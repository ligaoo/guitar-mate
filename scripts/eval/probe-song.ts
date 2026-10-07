// 临时诊断脚本(跑完即删):给一首**没有人工标注**的整曲做质量体检。
//
// 没有标注 ⇒ 算不出真正的 F1。这里用四个"可信度代理指标",并用 ACCURACY.md 里
// 真实 GuitarSet 的实测值当标尺(独奏 8 片段 / 和弦伴奏 8 片段):
//   ① 起音支撑率:音符起点 ±40ms 内有真实起音的比例 —— 独奏实测 ≈79%,和弦伴奏 ≈45%
//   ② 调内音比例:检测到调性后落在调内的比例 —— 越低说明"差半音幻觉音"越多
//   ③ 存活八度重影对:±12/24 半音且时间重叠 >50% 的对数(模型幻觉的典型症状)
//   ④ 密度 / 置信度:个每秒、中位置信度、低置信度(<0.5)占比
// 用法:node probe-song.js --wav=<path> --mode=full|ab [--start=秒 --dur=秒]
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR, type RawNote } from '../../src/transcription/pipeline'
import { bpPreset, type BpOptions } from '../../src/transcription/basicPitch'
import { separateDsp, percussiveBpmHint, extractBassNotes, compensateLevelInPlace } from '../../src/transcription/separation'
import { detectKey, filterToKey } from '../../src/transcription/cleanup'
import { runBpEngine, runDspEngine, runProductPipeline } from './engines'
import { decodeWav } from './wav'

const args = process.argv.slice(2)
const flag = (n: string, d = '') => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const WAV = flag('wav')
const MODE = flag('mode', 'full')
const root = process.cwd()

interface Metrics {
  label: string
  notes: RawNote[]
  est: { start: number; dur: number; midi: number }[]
  support: number
  inKey: number
  keyName: string
  ghosts: number
  confMedian: number
  confLow: number
  density: number
  polyMean: number
  polyMax: number
  bpm: number
  bpmStrength: number
  tuningCents: number
  retimed: number
  droppedRange: number
  droppedConflict: number
  tabSteps: number
  keyDropShare: number
}

function measure(label: string, est: { start: number; dur: number; midi: number }[], notes: RawNote[], onsets: number[], out: { bpm: number; bpmStrength?: number; tuningCents?: number; retimed?: number }, duration: number): Metrics {
  // ① 起音支撑率
  let supported = 0
  for (const n of est) {
    let ok = false
    for (const t of onsets) {
      const d = Math.abs(t - n.start)
      if (d <= 0.04) {
        ok = true
        break
      }
      if (t > n.start + 0.04) break
    }
    if (ok) supported++
  }
  const support = est.length ? supported / est.length : 0
  // ② 调内音比例
  const key = detectKey(notes)
  const inKey = key ? filterToKey(est, key).length / est.length : 0
  // ③ 存活八度重影
  let ghosts = 0
  for (let i = 0; i < est.length; i++) {
    for (let j = i + 1; j < est.length; j++) {
      if (est[j].start >= est[i].start + est[i].dur) break
      const ov = Math.min(est[i].start + est[i].dur, est[j].start + est[j].dur) - Math.max(est[i].start, est[j].start)
      const shorter = Math.min(est[i].dur, est[j].dur)
      const d = Math.abs(est[i].midi - est[j].midi)
      if ((d === 12 || d === 24) && ov > shorter * 0.5) ghosts++
    }
  }
  // ④ 置信度 / 密度 / 复音度
  const confs = notes.map((n) => n.confidence).sort((a, b) => a - b)
  const confMedian = confs.length ? confs[confs.length >> 1] : 0
  const confLow = confs.length ? confs.filter((c) => c < 0.5).length / confs.length : 0
  const byOnset = new Map<number, number>()
  for (const n of est) {
    const k = Math.round(n.start * 16) / 16
    byOnset.set(k, (byOnset.get(k) ?? 0) + 1)
  }
  const polys = [...byOnset.values()]
  const polyMean = polys.length ? polys.reduce((a, b) => a + b, 0) / polys.length : 0
  const polyMax = polys.length ? Math.max(...polys) : 0
  return {
    label, notes, est, support, inKey, keyName: key?.name ?? '未检出', ghosts,
    confMedian, confLow, density: duration > 0 ? est.length / duration : 0,
    polyMean, polyMax,
    bpm: out.bpm, bpmStrength: out.bpmStrength ?? 0, tuningCents: out.tuningCents ?? 0,
    retimed: out.retimed ?? 0, droppedRange: 0, droppedConflict: 0, tabSteps: 0, keyDropShare: 0,
  }
}

function withProduct(m: Metrics, tuning: number[]): Metrics {
  const out = { notes: m.notes, bpm: m.bpm, offset: m.est[0]?.start ?? 0, duration: 0, bpmStrength: m.bpmStrength }
  const p = runProductPipeline(out, tuning, 15, { minConf: 0 })
  return {
    ...m,
    droppedRange: p.dropped.filter((d) => d.reason === 'range').length,
    droppedConflict: p.dropped.filter((d) => d.reason === 'conflict').length,
    tabSteps: new Set(p.tab.map((t) => t.step)).size,
  }
}

function print(m: Metrics) {
  console.log(`\n── ${m.label}`)
  console.log(
    `   音符 ${String(m.est.length).padStart(5)} · 密度 ${m.density.toFixed(1)}/秒 · 复音 均${m.polyMean.toFixed(1)}/最大 ${m.polyMax} · ` +
      `置信中位 ${m.confMedian.toFixed(2)} · 低置信占比 ${(m.confLow * 100).toFixed(0)}%`,
  )
  console.log(
    `   起音支撑率 ${(m.support * 100).toFixed(0)}% · 调内音 ${(m.inKey * 100).toFixed(0)}%(${m.keyName}) · 存活八度重影 ${m.ghosts} 对`,
  )
  console.log(
    `   BPM ${m.bpm}(锁定 ${(m.bpmStrength * 100).toFixed(0)}%) · 调音 ${m.tuningCents > 0 ? '+' : ''}${m.tuningCents}¢ · 起音对时 ${m.retimed} 个`,
  )
  if (m.tabSteps > 0) console.log(`   产品链路:谱面格点 ${m.tabSteps} · 超音域丢弃 ${m.droppedRange} · 同弦冲突丢弃 ${m.droppedConflict}`)
}

async function load(start = 0, dur = 0) {
  const raw = await readFile(WAV)
  const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const sr = wav.sampleRate
  const total = wav.channels[0].length
  const a = Math.max(0, Math.floor(start * sr))
  const b = dur > 0 ? Math.min(total, Math.floor((start + dur) * sr)) : total
  const chans = wav.channels.map((c) => c.subarray(a, b))
  return { chans, sr, duration: (b - a) / sr, hasStereo: chans.length >= 2 }
}

async function main() {
  if (!WAV || !existsSync(WAV)) throw new Error(`找不到 WAV: ${WAV}`)
  const tuning = [40, 45, 50, 55, 59, 64] // 标准调弦

  if (MODE === 'full') {
    // 产品导入整曲的默认路径:分轨预处理(中置抑制 0.6)→ 混音预设 → BP
    const { chans, sr, duration, hasStereo } = await load()
    console.log(`整曲体检:${duration.toFixed(1)}s · ${sr}Hz · ${chans.length} 声道`)
    const t0 = Date.now()
    const stems = separateDsp(chans, sr, { centerSuppress: 0.6 })
    const drumBpm = percussiveBpmHint(stems.percussive, sr)
    const bass = extractBassNotes(stems.bass, sr)
    const rms = (c: Float32Array[]) => {
      let s = 0
      let n = 0
      for (const x of c) for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; n++ }
      return Math.sqrt(s / n)
    }
    const eG = rms(stems.guitar)
    const eP = rms(stems.percussive)
    const eB = rms(stems.bass)
    const gain = compensateLevelInPlace(stems.guitar)
    console.log(
      `分轨用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 能量占比 吉他 ${(eG / (eG + eP + eB) * 100).toFixed(0)}% / 鼓 ${(eP / (eG + eP + eB) * 100).toFixed(0)}% / 低频 ${(eB / (eG + eP + eB) * 100).toFixed(0)}%` +
        ` · 电平补偿 ${gain > 1.001 ? '+' + (20 * Math.log10(gain)).toFixed(1) + 'dB' : '无'} · 鼓轨 BPM 提示 ${drumBpm ?? '弃权'} · 贝斯参照音 ${bass.length} 个`,
    )
    const p = bpPreset('mix')
    const opts: BpOptions = { ...p, removeOctaveGhosts: true, retime: true, lowestMidi: tuning[0], highestMidi: tuning[5] + 22, bpmHint: drumBpm ?? undefined, bassNotes: bass }
    console.log('开始推理(整曲,分离后的吉他轨)…')
    const ti = Date.now()
    const out = await runBpEngine(stems.guitar as Float32Array[], sr, root, opts)
    console.log(`推理用时 ${((Date.now() - ti) / 1000).toFixed(1)}s`)
    const mono22 = resampleLinear(toMono(stems.guitar as Float32Array[], stems.guitar[0].length), sr, SR)
    const onsets = estimateOnsets(mono22, SR)
    const est = out.notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
    let m = measure('整曲 · 分轨后吉他轨 · 混音预设', est, out.notes, onsets, out, duration)
    m = withProduct(m, tuning)
    m.keyDropShare = 1 - m.inKey
    print(m)
    // 分段体检:20 秒一段,找最差的段落
    console.log('\n分段体检(每 20 秒):支撑率低 / 调外音多 / 密度异常的段落最值得用「只扒片段」重扒')
    console.log('  时间段      音符  支撑率  调内音  置信中位  密度')
    for (let s = 0; s < duration; s += 20) {
      const seg = est.filter((n) => n.start >= s && n.start < s + 20)
      if (seg.length === 0) { console.log(`  ${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}-    0        -      -        -      -`); continue }
      const segNotes = out.notes.filter((n) => n.start >= s && n.start < s + 20)
      const key = detectKey(out.notes)
      const inKey = key ? filterToKey(seg, key).length / seg.length : 0
      let sup = 0
      for (const n of seg) {
        if (onsets.some((t) => Math.abs(t - n.start) <= 0.04)) sup++
      }
      const cs = segNotes.map((n) => n.confidence).sort((a, b) => a - b)
      console.log(
        `  ${String(Math.floor(s / 60)).padStart(2)}:${String(Math.floor(s % 60)).padStart(2, '0')}-${String(Math.floor((s + 20) / 60)).padStart(2)}:${String(Math.floor((s + 20) % 60)).padStart(2, '0')}  ` +
          `${String(seg.length).padStart(5)}  ${((sup / seg.length) * 100).toFixed(0).padStart(5)}%  ${((inKey) * 100).toFixed(0).padStart(5)}%  ` +
          `${(cs[cs.length >> 1] ?? 0).toFixed(2).padStart(7)}  ${(seg.length / 20).toFixed(1).padStart(5)}`,
      )
    }
    return
  }

  // A/B:同一段 60 秒,原始混音 vs 分轨后,再对比 DSP 引擎
  const start = parseFloat(flag('start', '60'))
  const dur = parseFloat(flag('dur', '60'))
  const { chans, sr, duration } = await load(start, dur)
  console.log(`A/B 片段:${start}s 起 ${duration.toFixed(1)}s · ${sr}Hz`)
  const p = bpPreset('mix')
  const base: BpOptions = { ...p, removeOctaveGhosts: true, retime: true, lowestMidi: 40, highestMidi: 86 }

  const monoRaw = toMono(chans, chans[0].length)
  const onsetsRaw = estimateOnsets(resampleLinear(monoRaw, sr, SR), SR)
  console.log('· 原始混音推理…')
  const outRaw = await runBpEngine(chans, sr, root, base)
  const estRaw = outRaw.notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
  print(withProduct(measure('原始混音(raw)', estRaw, outRaw.notes, onsetsRaw, outRaw, duration), tuning))

  const stems = separateDsp(chans, sr, { centerSuppress: 0.6 })
  const drumBpm = percussiveBpmHint(stems.percussive, sr)
  compensateLevelInPlace(stems.guitar)
  console.log('· 分轨后推理…')
  const outSep = await runBpEngine(stems.guitar as Float32Array[], sr, root, { ...base, bpmHint: drumBpm ?? undefined, bassNotes: extractBassNotes(stems.bass, sr) })
  const estSep = outSep.notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
  print(withProduct(measure('分轨后吉他轨(sep,中置抑制0.6)', estSep, outSep.notes, onsetsRaw, outSep, duration), tuning))

  const dsp = runDspEngine(chans, sr, { lowestMidi: 40, highestMidi: 86 })
  console.log(
    `\n── 内置 DSP 引擎(单音)对照\n   音符 ${dsp.notes.length} · 疑似复音标记 ${dsp.likelyPolyphonic ? '是(说明这段是复音材料,DSP 结果不可用)' : '否'}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
