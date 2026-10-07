// 质量指标标定:把"无标注代理分"回归到"有标注的真实 F1"
//
// 目的有两个,缺一不可:
//   ① 让闭环报出的「预计准确率」有依据(拟合 expectedF1 = a + b·score);
//   ② **验证代理指标到底可不可信** —— 如果代理分与真实 F1 的相关性很低,
//      那"按代理分自动选参数"就是瞎选,必须如实告诉用户,而不是假装能自动。
//
// 数据:真实 GuitarSet(有人工标注的 8 个片段)。做法:
//   整片推理一次 → 切成 8~12 秒窗口 → 每个窗口同时算
//     (a) 代理指标(quality.ts 的 segmentMetrics/qualityScore)
//     (b) 真实音符级 F1(与标注比,±50ms + 音高全等,与 EVAL.md 口径一致)
//   输出 eval/quality-calibration.json,含每个窗口的原始数据 + 相关系数 + 最小二乘系数。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR, type RawNote } from '../../src/transcription/pipeline'
import { bpPreset, evaluateChunked, postProcessFrames, ensureBackend, getModel } from '../../src/transcription/basicPitch'
import { estimateTuningFromPcm } from '../../src/transcription/tuning'
import { detectKey } from '../../src/transcription/cleanup'
import { segmentMetrics, qualityScore } from '../../src/transcription/auto/quality'
import { ensureModelServer, closeModelServer, runProductPipeline } from './engines'
import { scoreNotes } from './metrics'
import { decodeWav } from './wav'
import { guitarTruth } from './fixtures'
import type { EvalClip, EvalNote } from './types'

const root = process.cwd()
const WINDOW = 10 // 每个窗口 10 秒
// --clips / --out:扩样标定时用独立清单与报告文件,不动 real-clips.json(test-real-eval 的稳定基线)
const args = process.argv.slice(2)
const flag = (name: string, def: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const clipsFile = flag('clips', 'eval/real-clips.json')
const outFile = flag('out', 'eval/quality-calibration.json')
const clips = (JSON.parse(readFileSync(join(root, clipsFile), 'utf8')) as { clips: EvalClip[] }).clips

const resolveAudio = (p: string): string | null => {
  const direct = isAbsolute(p) ? p : join(root, p)
  if (existsSync(direct)) return direct
  const dataDir = process.env.GM_DATA_DIR
  const tail = p.split('\\').join('/').split('/').slice(-2).join('/')
  const alt = dataDir ? join(dataDir, tail) : ''
  return alt && existsSync(alt) ? alt : null
}

interface Sample {
  clip: string
  t0: number
  noteF1: number
  score: number
  lead: number
  onsetSupport: number
  gridFit: number
  inKey: number
  confMedian: number
  lowConfShare: number
  feasibleRate: number
  ghostRate: number
}

const pearson = (xs: number[], ys: number[]) => {
  const n = xs.length
  if (n < 3) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
}

async function main() {
  const url = await ensureModelServer(root)
  await ensureBackend(true)
  const bp = await getModel(url)
  const samples: Sample[] = []

  for (const clip of clips) {
    const path = resolveAudio(clip.audio!.path)
    if (!path) {
      console.warn(`跳过(音频不在场):${clip.id}`)
      continue
    }
    const raw = await readFile(path)
    const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const mono = wav.channels.length === 1 ? wav.channels[0] : toMono(wav.channels, wav.channels[0].length)
    const pcm = resampleLinear(mono, wav.sampleRate, SR)
    const tune = estimateTuningFromPcm(pcm, SR)
    const preset = bpPreset('solo')
    const { frames, onsets: onsetFrames } = await evaluateChunked(bp, pcm, () => {})
    const r = await postProcessFrames(
      frames,
      onsetFrames,
      {
        ...preset,
        removeOctaveGhosts: true,
        retime: true,
        retimeOnsets: estimateOnsets(pcm, SR),
        lowestMidi: clip.tuning[0],
        highestMidi: clip.tuning[clip.tuning.length - 1] + 22,
        tuningCents: tune ? Math.round(tune.semis * 100) : 0,
      },
      pcm.length / SR,
    )
    const truth = guitarTruth(clip) as EvalNote[]
    const key = detectKey(r.notes)
    const onsets = estimateOnsets(pcm, SR)
    const dur = pcm.length / SR
    console.log(`▶ ${clip.id}:${r.notes.length} 音符 · BPM ${r.bpm} · 调 ${key?.name ?? '未检出'}`)

    for (let t0 = 0; t0 + WINDOW <= dur; t0 += WINDOW) {
      const t1 = t0 + WINDOW
      const seg = r.notes.filter((n) => n.start >= t0 && n.start < t1) as RawNote[]
      if (seg.length < 5) continue
      // 真实 F1:同窗口的标注 vs 识别(音符级,±50ms)
      const truthSeg = truth.filter((n) => n.start >= t0 && n.start < t1)
      if (truthSeg.length < 3) continue
      const estSeg = seg.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
      const f1 = scoreNotes(truthSeg, estSeg).f1
      // 代理指标(与闭环里用的完全同一套代码)
      const product = runProductPipeline(
        { notes: seg, bpm: r.bpm, offset: r.offset, duration: WINDOW, bpmStrength: r.bpmStrength },
        clip.tuning,
        15,
        { minConf: 0, autoDensity: false },
      )
      const m = segmentMetrics({
        notes: seg,
        tab: product.tab,
        dropped: product.dropped,
        onsets,
        bpm: product.bpmUsed,
        globalKey: key,
        duration: WINDOW,
      })
      const score = qualityScore(m)
      samples.push({
        clip: clip.id,
        t0,
        noteF1: f1,
        score,
        lead: 0,
        onsetSupport: m.onsetSupport,
        gridFit: m.gridFit,
        inKey: m.inKey,
        confMedian: m.confMedian,
        lowConfShare: m.lowConfShare,
        feasibleRate: m.feasibleRate,
        ghostRate: m.ghostRate,
      })
    }
  }

  closeModelServer()
  if (samples.length < 6) {
    console.error(`✗ 样本太少(${samples.length}),无法标定`)
    process.exit(1)
  }

  // ---- 相关性与拟合 ----
  const f1s = samples.map((s) => s.noteF1)
  const scores = samples.map((s) => s.score)
  const rScore = pearson(scores, f1s)
  const perMetric = {
    onsetSupport: pearson(samples.map((s) => s.onsetSupport), f1s),
    gridFit: pearson(samples.map((s) => s.gridFit), f1s),
    inKey: pearson(samples.map((s) => s.inKey), f1s),
    confMedian: pearson(samples.map((s) => s.confMedian), f1s),
    lowConfShare: pearson(samples.map((s) => s.lowConfShare), f1s),
    feasibleRate: pearson(samples.map((s) => s.feasibleRate), f1s),
    ghostRate: pearson(samples.map((s) => s.ghostRate), f1s),
  }
  const ms = scores.reduce((a, b) => a + b, 0) / scores.length
  const mf = f1s.reduce((a, b) => a + b, 0) / f1s.length
  let num = 0
  let den = 0
  for (let i = 0; i < samples.length; i++) {
    num += (scores[i] - ms) * (f1s[i] - mf)
    den += (scores[i] - ms) ** 2
  }
  const b = den > 0 ? num / den : 0
  const a = mf - b * ms

  const report = {
    generatedAt: new Date().toISOString(),
    windowSec: WINDOW,
    samples: samples.length,
    calibration: { a, b, pearsonR: rScore },
    perMetricPearson: perMetric,
    meanF1: mf,
    rows: samples,
  }
  writeFileSync(join(root, outFile), JSON.stringify(report, null, 2), 'utf8')

  console.log('\n' + '='.repeat(80))
  console.log(`样本 ${samples.length} 个窗口 · 真实音符级 F1 均值 ${(mf * 100).toFixed(1)}%`)
  console.log(`复合质量分与真实 F1 的相关性 r = ${rScore.toFixed(3)}  ${rScore >= 0.6 ? '(可信)' : rScore >= 0.4 ? '(勉强)' : '(不可信!代理分不能用来选参数)'}`)
  console.log('单指标相关性:')
  for (const [k, v] of Object.entries(perMetric)) console.log(`   ${k.padEnd(14)} r = ${v.toFixed(3)}`)
  console.log(`\n标定系数:expectedF1 = ${a.toFixed(3)} + ${b.toFixed(3)} × score`)
  console.log(`   (写回 src/transcription/auto/quality.ts 的 CALIB:{ a: ${a.toFixed(3)}, b: ${b.toFixed(3)}, samples: ${samples.length}, r: ${rScore.toFixed(3)} })`)
  console.log(`报告:${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
