// 参考谱引导扒谱:人工参考谱(Songsterr)+ 录音对齐 + 音频证据校验 → 高置信谱面。
//
// 定位(与盲扒 `npm run auto` 互补):有参考谱时,瓶颈从「模型识别」变成
// 「参考谱与这版录音对齐 + 哪些音在音频里真的存在」。本脚本:
//   ① Basic Pitch 对整曲推理一次(帧矩阵落盘缓存,后续不再推理)
//   ② 参考谱音符按 align.json 的仿射映射到录音时间轴
//   ③ 逐音符音频验证:起音支撑(DSP 起音 ±60ms)+ 音高支撑(BP 帧激活)
//   ④ 产出:可直接导入的曲库 JSON(主音+节奏两首)+ 验证报告 md + 逐音符判定 json
//
// 用法(esbuild 打包):
//   node .ref-guided.cjs --audio=... --lead=lead-events.json --rhythm=rhythm-events.json \
//     --align=align.json --out-dir="D:/music/tab-out/God knows-ref" --name="God knows"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR } from '../src/transcription/pipeline'
import { evaluateChunked, ensureBackend, getModel } from '../src/transcription/basicPitch'
import { ensureModelServer, closeModelServer } from './eval/engines'
import { decodeWav } from './eval/wav'
import { verifyTrack, type ScoreEvent } from './ref-core'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name: string, def = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

interface Ev { t: number; dur: number; midi: number; string: number; fret: number; measure: number }
const MIDI_BASE = 21 // BP 88 个音高桶从 A0 (21) 开始

/** 帧矩阵落盘缓存(避免重复 10 分钟推理) */
async function inferCached(bp: Awaited<ReturnType<typeof getModel>>, pcm: Float32Array, cacheBase: string) {
  const framesPath = cacheBase + '.frames.f32'
  const onsetsPath = cacheBase + '.onsets.f32'
  const metaPath = cacheBase + '.meta.json'
  if (existsSync(framesPath) && existsSync(onsetsPath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { nFrames: number; nBins: number }
    const load = (p: string) => new Float32Array(readFileSync(p).buffer.slice(0, meta.nFrames * meta.nBins * 4))
    console.log(`帧缓存命中:${meta.nFrames} 帧`)
    return { framesF: load(framesPath), onsetsF: load(onsetsPath), nFrames: meta.nFrames, nBins: meta.nBins }
  }
  console.log('推理中(整曲一次,约 8~12 分钟)…')
  const { frames, onsets } = await evaluateChunked(bp, pcm, () => {})
  const nFrames = frames.length
  const nBins = frames[0]?.length ?? 88
  const flat = (m: number[][]) => {
    const f = new Float32Array(m.length * nBins)
    for (let i = 0; i < m.length; i++) for (let j = 0; j < nBins; j++) f[i * nBins + j] = m[i][j] ?? 0
    return f
  }
  const framesF = flat(frames)
  const onsetsF = flat(onsets)
  writeFileSync(framesPath, Buffer.from(framesF.buffer))
  writeFileSync(onsetsPath, Buffer.from(onsetsF.buffer))
  writeFileSync(metaPath, JSON.stringify({ nFrames, nBins, duration: pcm.length / SR }))
  return { framesF, onsetsF, nFrames, nBins }
}

async function main() {
  const audioPath = flag('audio')
  const leadPath = flag('lead')
  const rhythmPath = flag('rhythm')
  const alignPath = flag('align')
  const outDir = flag('out-dir')
  const songName = flag('name', 'God knows')
  if (!audioPath || !leadPath || !alignPath || !outDir) {
    console.error('用法:--audio= --lead= [--rhythm=] --align= --out-dir= [--name=]')
    process.exit(1)
  }
  const align = JSON.parse(readFileSync(alignPath, 'utf8')) as { offset: number; scale: number; bpmScore: number }
  mkdirSync(outDir, { recursive: true })

  const raw = await readFile(audioPath)
  const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const mono = wav.channels.length === 1 ? wav.channels[0] : toMono(wav.channels, wav.channels[0].length)
  const pcm = resampleLinear(mono, wav.sampleRate, SR)
  const duration = pcm.length / SR
  const audioOnsets = estimateOnsets(pcm, SR)
  console.log(`音频 ${duration.toFixed(1)}s · DSP 起音 ${audioOnsets.length} · 对齐 offset=${align.offset}s scale=${align.scale}`)

  const url = await ensureModelServer(root)
  await ensureBackend(true)
  const bp = await getModel(url)
  const cacheBase = join(outDir, 'frame-cache')
  const { framesF, onsetsF, nFrames, nBins } = await inferCached(bp, pcm, cacheBase)

  // ---------- 逐音符验证 + 生成曲库 ----------
  // 验证逻辑(双证据 + 分级阈值)已抽到 ref-core.verifyTrack —— 与一键流水线
  // ref-pipeline.ts 共用同一实现,改阈值只改一处(阈值依据见 REF.md)。
  const processTrack = (path: string, trackLabel: string, songTitle: string) => {
    const evs = JSON.parse(readFileSync(path, 'utf8')) as { events: ScoreEvent[] }
    const r = verifyTrack(
      evs.events,
      { offset: align.offset, scale: align.scale, bpmScore: align.bpmScore },
      { framesF, onsetsF, nFrames, nBins, duration },
      audioOnsets,
      trackLabel,
      songTitle,
    )
    writeFileSync(join(outDir, `verify-${trackLabel}.json`), JSON.stringify(r.perNote, null, 1), 'utf8')
    return { song: r.song, n: r.n, perNote: r.perNote }
  }

  const results = []
  results.push({ label: 'lead', title: `${songName}(参考谱 · 主音吉他)`, ...processTrack(leadPath, 'lead', `${songName}(参考谱 · 主音吉他)`) })
  if (rhythmPath) results.push({ label: 'rhythm', title: `${songName}(参考谱 · 节奏吉他)`, ...processTrack(rhythmPath, 'rhythm', `${songName}(参考谱 · 节奏吉他)`) })

  const lib = { version: 1, songs: results.map((r) => r.song) }
  writeFileSync(join(outDir, `${songName}.ref.library.json`), JSON.stringify(lib), 'utf8')

  // ---------- 报告 ----------
  const lines = ['# 参考谱引导扒谱 · 验证报告', '', `- 音频:${audioPath}(${duration.toFixed(1)}s)`, `- 对齐:audioT = ${align.offset}s + ${align.scale} × scoreT(谱面 ${align.bpmScore} BPM)`, '- 验证口径:起音支撑 = DSP 起音 ±60ms;音高支撑 = BP 帧激活(该音高 120ms 窗最大值)', '']
  for (const r of results) {
    const v = { strong: 0, ok: 0, weak: 0, none: 0 }
    for (const p of r.perNote) v[p.verdict as keyof typeof v]++
    const total = r.perNote.length
    lines.push(`## ${r.title}`)
    lines.push('')
    lines.push(`- 音符 ${total} 个`)
    lines.push(`- ✅ 强验证(音高≥0.30 且有起音):**${v.strong}(${((v.strong / total) * 100).toFixed(1)}%)**`)
    lines.push(`- ✓ 基本验证(音高≥0.15 或 音高≥0.10+起音):${v.ok}(${((v.ok / total) * 100).toFixed(1)}%)`)
    lines.push(`- ⚠ 弱证据:${v.weak} · ❌ 无音频证据:${v.none}(多为混音中被掩蔽的音,谱面本身仍可信)`)
    lines.push(`- 「强+基本」合计:**${(((v.strong + v.ok) / total) * 100).toFixed(1)}%** ← 该谱与这版录音的一致度`)
    // 逐小节摘要:弱证据集中处 = 建议人工对照原曲复核的小节
    const byM = new Map<number, { total: number; weak: number }>()
    for (const p of r.perNote) {
      const cur = byM.get(p.m) ?? { total: 0, weak: 0 }
      cur.total++
      if (p.verdict === 'weak' || p.verdict === 'none') cur.weak++
      byM.set(p.m, cur)
    }
    const weakMeasures = [...byM.entries()]
      .filter(([, s]) => s.weak / s.total >= 0.5)
      .map(([m, s]) => `m${m + 1}(${s.weak}/${s.total})`)
    if (weakMeasures.length) lines.push(`- 弱证据过半的小节(建议对照原曲复核):${weakMeasures.join(' ')}`)
    lines.push('')
  }
  writeFileSync(join(outDir, 'ref-report.md'), lines.join('\n'), 'utf8')
  closeModelServer()
  console.log(lines.join('\n'))
  console.log(`\n产物:${join(outDir, `${songName}.ref.library.json`)}(页面「📂 导入曲库」即用)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
