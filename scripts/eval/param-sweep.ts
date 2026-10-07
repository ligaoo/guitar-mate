// 参数寻优:在真实 GuitarSet 上按素材档(solo/comp)搜索后处理参数最优区。
//
// 背景:BPM→参数规则(AUTO.md §2)是在合成数据 + 16 窗口上定的;现在有分层 60 片段
// (6 位演奏者,solo/comp 各半),应该用真实数据重新验证/校准这些阈值。
//
// 做法(与 auto 闭环同一思路,推理只做一次):
//   每片段:解码 → YIN 调音 → Basic Pitch 推理一次,缓存帧矩阵
//   → 阶段 A:网格搜 onsetThresh × frameThresh × melodia(mnl 固定为现行规则 16分×0.6)
//   → 阶段 B:用 A 的最优 (ot,ft,mel) 搜 最短音长倍率 × 置信过滤
//   → 全程与标定/评测同一口径:scoreNotes 音符级 F1(±50ms + 音高全等),按档宏平均
//
// 输出:eval/param-sweep.json(基线 vs 最优,含全部行)+ 控制台摘要。
// 用法:node scripts/run-calibrate.mjs 的同款打包方式,或 npm run sweep(见 package.json)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR } from '../../src/transcription/pipeline'
import { evaluateChunked, postProcessFrames, ensureBackend, getModel } from '../../src/transcription/basicPitch'
import { estimateTuningFromPcm } from '../../src/transcription/tuning'
import { ensureModelServer, closeModelServer } from './engines'
import { scoreNotes } from './metrics'
import { decodeWav } from './wav'
import { guitarTruth } from './fixtures'
import type { EvalClip, EvalNote } from './types'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name: string, def: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const clipsFile = flag('clips', 'eval/real-clips-cal.json')
const outFile = flag('out', 'eval/param-sweep.json')
const clips = (JSON.parse(readFileSync(join(root, clipsFile), 'utf8')) as { clips: EvalClip[] }).clips

const resolveAudio = (p: string): string | null => {
  const direct = isAbsolute(p) ? p : join(root, p)
  if (existsSync(direct)) return direct
  const dataDir = process.env.GM_DATA_DIR
  const tail = p.split('\\').join('/').split('/').slice(-2).join('/')
  const alt = dataDir ? join(dataDir, tail) : ''
  return alt && existsSync(alt) ? alt : null
}

const FPS = 86 // Basic Pitch 帧率
// 2026-10-07 v2:上一轮 ft 最优 0.40 卡在网格边界(更高值未搜,PLAN-90 阶段 2 第 2 项),
// 本轮扩到 0.5/0.6;ot 同步加 0.60 档。并加 holdout 留出集:寻优只在 sweep 池上做,
// 最优参数与基线/现行参数再在 holdout 池上评一次 —— 消除"同一批样本取最优"的乐观偏差。
const OTS = [0.45, 0.5, 0.55, 0.6]
const FTS = [0.3, 0.35, 0.4, 0.5, 0.6]
const MNL_MULTS = [0.3, 0.45, 0.6, 0.8, 1.0] // × 16分音符帧数(现行规则 0.6)
const MINCONFS: Array<number | 'auto'> = [0, 0.15, 0.25, 'auto'] // auto = 该次结果置信中位 × 0.5,夹 [0.15,0.4]
/** holdout 比例(按 clip id 哈希确定性分池,同一 id 永远同池) */
const HOLDOUT_FRAC = 0.4
const hashId = (s: string) => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
const isHoldout = (id: string) => hashId(id) % 10 < HOLDOUT_FRAC * 10

interface Row {
  key: string
  kind: string
  ot: number
  ft: number
  mel: boolean
  mnlMult: number
  minConf: number | 'auto'
  f1s: number[] // 每片段 F1
  meanF1: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** 跑一次后处理 + 置信过滤 + 打分 */
async function runPass(
  bp: Awaited<ReturnType<typeof getModel>>,
  frames: number[][],
  onsets: number[][],
  clip: EvalClip,
  pcm: Float32Array,
  tune: { semis: number } | null,
  truth: EvalNote[],
  ot: number,
  ft: number,
  mnlFrames: number,
  mel: boolean,
  minConf: number | 'auto',
): Promise<number | null> {
  const retimeOnsets = estimateOnsets(pcm, SR)
  const r = await postProcessFrames(
    frames,
    onsets,
    {
      onsetThresh: ot,
      frameThresh: ft,
      minNoteLenFrames: mnlFrames,
      melodiaTrick: mel,
      removeOctaveGhosts: true,
      retime: true,
      retimeOnsets,
      lowestMidi: clip.tuning[0],
      highestMidi: clip.tuning[clip.tuning.length - 1] + 22,
      tuningCents: tune ? Math.round(tune.semis * 100) : 0,
    },
    pcm.length / SR,
  )
  let notes = r.notes
  const cut = minConf === 'auto'
    ? Math.min(0.4, Math.max(0.15, 0.5 * (notes.map((n) => n.confidence).sort((a, b) => a - b)[notes.length >> 1] ?? 0)))
    : minConf
  if (cut > 0) notes = notes.filter((n) => n.confidence >= cut)
  const est = notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
  return scoreNotes(truth, est).f1
}

async function main() {
  const url = await ensureModelServer(root)
  await ensureBackend(true)
  const bp = await getModel(url)
  const t0 = Date.now()

  // 每片段缓存:推理一次 + 基础数据
  interface Cached {
    clip: EvalClip
    kind: 'solo' | 'comp'
    frames: number[][]
    onsets: number[][]
    pcm: Float32Array
    tune: { semis: number } | null
    truth: EvalNote[]
    mnlBase: number // 16分音符帧数
  }
  const cache: Cached[] = []
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
    const { frames, onsets: onsetFrames } = await evaluateChunked(bp, pcm, () => {})
    cache.push({
      clip,
      kind: clip.id.includes('_solo') ? 'solo' : 'comp',
      frames,
      onsets: onsetFrames,
      pcm,
      tune,
      truth: guitarTruth(clip) as EvalNote[],
      mnlBase: Math.max(1, Math.round((60 / clip.bpm / 4) * FPS)),
    })
    console.log(`▶ ${clip.id}:推理完成(${((Date.now() - t0) / 1000).toFixed(0)}s 累计)`)
  }
  if (cache.length < 10) {
    console.error(`✗ 可用片段太少(${cache.length})`)
    process.exit(1)
  }

  const kinds: Array<'solo' | 'comp'> = ['solo', 'comp']
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), clipsFile, clips: cache.length, perKind: {} }

  for (const kind of kinds) {
    const all = cache.filter((c) => c.kind === kind)
    if (!all.length) continue
    // 确定性分池:寻优只看 sweep,最优参数的"干净成绩"在 holdout 上算
    const sweepPool = all.filter((c) => !isHoldout(c.clip.id))
    const holdoutPool = all.filter((c) => isHoldout(c.clip.id))
    const pool = sweepPool.length >= 6 && holdoutPool.length >= 4 ? sweepPool : all
    const holdout = pool === sweepPool ? holdoutPool : []
    console.log(`\n===== ${kind}(全部 ${all.length}:sweep ${pool.length} / holdout ${holdout.length})=====`)

    // 基线:现行规则 ot0.5/ft0.3/16分×0.6,solo 关 melodia、comp 开(AUTO.md §2)
    const baselineRows: number[] = []
    for (const c of pool) {
      const f1 = await runPass(bp, c.frames, c.onsets, c.clip, c.pcm, c.tune, c.truth, 0.5, 0.3, Math.round(c.mnlBase * 0.6), kind === 'comp', 0)
      baselineRows.push(f1 ?? 0)
    }
    console.log(`基线(ot0.50 ft0.30 ×0.6 ${kind === 'comp' ? 'melon' : 'meloff'}):宏平均 F1 = ${(mean(baselineRows) * 100).toFixed(1)}%`)

    // 阶段 A:ot × ft × melodia(mnl 固定 ×0.6,不过滤置信)
    const stageA: Row[] = []
    let melSkipped = 0
    for (const mel of [false, true]) {
      if (kind === 'solo' && mel) continue // 独奏档已实测 melodia 有害,不浪费算力
      for (const ot of OTS) {
        for (const ft of FTS) {
          const f1s: number[] = []
          let slow = false
          const passStart = Date.now()
          for (const c of pool) {
            const f1 = await runPass(bp, c.frames, c.onsets, c.clip, c.pcm, c.tune, c.truth, ot, ft, Math.round(c.mnlBase * 0.6), mel, 0)
            f1s.push(f1 ?? 0)
            if (Date.now() - passStart > 120_000) {
              slow = true // melodia 在密集素材上可能极慢,超 2 分钟弃掉这组
              break
            }
          }
          if (slow) {
            melSkipped++
            continue
          }
          stageA.push({ key: `ot${ot} ft${ft} ${mel ? 'melon' : 'meloff'}`, kind, ot, ft, mel, mnlMult: 0.6, minConf: 0, f1s, meanF1: mean(f1s) })
          console.log(`  A ${'ot' + ot.toFixed(2)} ${'ft' + ft.toFixed(2)} ${mel ? 'melon ' : 'meloff'} → ${(mean(f1s) * 100).toFixed(1)}%`)
        }
      }
    }
    stageA.sort((a, b) => b.meanF1 - a.meanF1)
    const bestA = stageA[0]
    if (!bestA) {
      console.error(`✗ ${kind}:阶段 A 无完整结果`)
      continue
    }

    // 阶段 B:mnl 倍率 × 置信过滤(用 A 的最优 ot/ft/mel)
    const stageB: Row[] = []
    for (const mult of MNL_MULTS) {
      // 每个倍率对全部 minConf 选项打分:后处理一次,minConf 过滤在打分前做
      const perConf: Record<string, number[]> = {}
      for (const mc of MINCONFS) perConf[String(mc)] = []
      for (const c of pool) {
        const mnlClip = Math.max(3, Math.min(12, Math.round(c.mnlBase * mult)))
        // 后处理一次,拿全部音符;置信过滤在 runPass 里做,但为省时这里手动展开
        const retimeOnsets = estimateOnsets(c.pcm, SR)
        const r = await postProcessFrames(
          c.frames,
          c.onsets,
          {
            onsetThresh: bestA.ot,
            frameThresh: bestA.ft,
            minNoteLenFrames: mnlClip,
            melodiaTrick: bestA.mel,
            removeOctaveGhosts: true,
            retime: true,
            retimeOnsets,
            lowestMidi: c.clip.tuning[0],
            highestMidi: c.clip.tuning[c.clip.tuning.length - 1] + 22,
            tuningCents: c.tune ? Math.round(c.tune.semis * 100) : 0,
          },
          c.pcm.length / SR,
        )
        for (const mc of MINCONFS) {
          const cut = mc === 'auto'
            ? Math.min(0.4, Math.max(0.15, 0.5 * (r.notes.map((n) => n.confidence).sort((a, b) => a - b)[r.notes.length >> 1] ?? 0)))
            : mc
          const notes = cut > 0 ? r.notes.filter((n) => n.confidence >= cut) : r.notes
          const est = notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
          perConf[String(mc)].push(scoreNotes(c.truth, est).f1)
        }
      }
      for (const mc of MINCONFS) {
        const f1s = perConf[String(mc)]
        stageB.push({ key: `×${mult} conf=${mc}`, kind, ot: bestA.ot, ft: bestA.ft, mel: bestA.mel, mnlMult: mult, minConf: mc, f1s, meanF1: mean(f1s) })
        console.log(`  B ×${mult.toFixed(2)} conf=${mc} → ${(mean(f1s) * 100).toFixed(1)}%`)
      }
    }
    stageB.sort((a, b) => b.meanF1 - a.meanF1)
    const best = stageB[0]
    console.log(`\n${kind} 最优:${best.key}(ot${best.ot} ft${best.ft} ${best.mel ? 'melon' : 'meloff'})→ 宏平均 F1 ${(best.meanF1 * 100).toFixed(1)}%`
      + `(基线 ${(mean(baselineRows) * 100).toFixed(1)}%,${best.meanF1 > mean(baselineRows) ? '↑' : '↓'} ${((best.meanF1 - mean(baselineRows)) * 100).toFixed(1)}pt)`)

    // ---- holdout 留出集:最优参数 vs 基线 vs 现行参数,都在没参与寻优的片段上评 ----
    let holdoutReport: Record<string, number> | null = null
    if (holdout.length >= 4) {
      const evalOn = async (label: string, ot: number, ft: number, mnlMult: number, mel: boolean, mc: number | 'auto') => {
        const f1s: number[] = []
        for (const c of holdout) {
          const f1 = await runPass(bp, c.frames, c.onsets, c.clip, c.pcm, c.tune, c.truth, ot, ft, Math.max(3, Math.min(12, Math.round(c.mnlBase * mnlMult))), mel, mc)
          f1s.push(f1 ?? 0)
        }
        const m = mean(f1s)
        console.log(`  holdout ${label} → ${(m * 100).toFixed(1)}%(n=${holdout.length})`)
        return m
      }
      holdoutReport = {
        baseline: await evalOn('基线 ot0.50/ft0.30', 0.5, 0.3, 0.6, kind === 'comp', 0),
        current: await evalOn('现行 ot0.55/ft0.40', 0.55, 0.4, 0.6, false, 0),
        best: await evalOn(`最优 ${best.key}`, best.ot, best.ft, best.mnlMult, best.mel, best.minConf),
      }
    }
    ;(report.perKind as Record<string, unknown>)[kind] = {
      clips: pool.length,
      holdoutClips: holdout.length,
      holdout: holdoutReport,
      baseline: { ot: 0.5, ft: 0.3, mnlMult: 0.6, mel: kind === 'comp', minConf: 0, meanF1: mean(baselineRows) },
      best: { ...best, f1s: undefined },
      stageATop: stageA.slice(0, 10).map((r) => ({ ...r, f1s: undefined })),
      stageBTop: stageB.slice(0, 12).map((r) => ({ ...r, f1s: undefined })),
      melSkipped,
    }
  }

  writeFileSync(join(root, outFile), JSON.stringify(report, null, 2), 'utf8')
  closeModelServer()
  console.log(`\n报告:${outFile} · 总用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
