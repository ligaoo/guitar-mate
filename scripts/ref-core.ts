// REF 流程的共享核心:Songsterr 解析 / 帧缓存推理 / 对齐 / 逐音符验证。
//
// ref-pipeline.ts(一键数据工厂,PLAN-90 阶段 4)与 ref-align.ts / ref-guided.ts
// (分步调试路径)共用这里的实现,保证两条路径的数值口径完全一致。
// 改动任何阈值时只需改本文件(阈值依据的实测见 REF.md / PLAN-90 §1)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { SR } from '../src/transcription/pipeline'
import { bpTimeToFrame } from '../src/transcription/basicPitch'

// ---------- ① Songsterr v4 谱面解析 ----------
// 语义(实测自数据,见 REF.md):
//   · beat.duration = [num, den] 是**全音符**的分数;[1,16]=16分,[1,24]=三连16
//   · note.tie === true 标在**被连的后一个音**上:延长前一个同弦音的时值,不产生新起音
//     (主音 157 个 tie 音中 155 个与前一同弦同品,方向已复核,勿再报"语义反了")
//   · string 0 = 最细弦(tuning[0] 是最高音);pitch = tuning[string] + fret
//   · tempo 在 automations.tempo(可能变速;本函数按小节分段取用)
export interface ScoreEvent {
  t: number
  dur: number
  midi: number
  string: number
  fret: number
  measure: number
  velocity?: number | null
}

export interface ParsedTrack {
  events: ScoreEvent[]
  bpm: number
  tuning: number[]
  measures: number
  duration: number
}

interface SongsterrNote {
  string: number
  fret: number
  tie?: boolean
  rest?: boolean
}
interface SongsterrBeat {
  duration?: [number, number]
  notes?: SongsterrNote[]
  velocity?: number | null
}
interface SongsterrTrack {
  measures: Array<{ signature?: [number, number]; voices?: Array<{ beats?: SongsterrBeat[] }> }>
  tuning: number[]
  automations?: { tempo?: Array<{ measure: number; bpm: number }> }
}

export function parseSongsterrTrack(tr: SongsterrTrack): ParsedTrack {
  const tempoAutos = (tr.automations?.tempo ?? []).slice().sort((a, b) => a.measure - b.measure)
  const bpmAt = (measureIdx: number) => {
    let bpm = 120
    for (const a of tempoAutos) if (a.measure <= measureIdx) bpm = a.bpm
    return bpm
  }
  const spbAt = (measureIdx: number) => 60 / bpmAt(measureIdx)

  const tuning = tr.tuning
  const events: ScoreEvent[] = []
  let t = 0 // 谱面绝对时间(秒)
  let pendingTie: { stringIdx: number; t: number } | null = null

  for (let mi = 0; mi < tr.measures.length; mi++) {
    const m = tr.measures[mi]
    const sig = m.signature ?? [4, 4]
    const beatsPerMeasure = sig[0] * (4 / sig[1])
    const spb = spbAt(mi)
    const voices = m.voices ?? []
    // 多 voice(防御):主 voice 定时间轴,其余声部按各自推进
    for (const v of voices) {
      let mt = t
      for (const b of v.beats ?? []) {
        const [num, den] = b.duration ?? [1, 4]
        const durSec = (num / den) * 4 * spb
        for (const n of b.notes ?? []) {
          if (n.rest) continue
          const stringIdx = n.string
          const midi = tuning[stringIdx] + n.fret
          if (pendingTie && pendingTie.stringIdx === stringIdx && Math.abs(pendingTie.t - mt) < 4 * spb) {
            // 连音线:延长前一个音,不产生新起音
            const prev = events[events.length - 1]
            if (prev) prev.dur += durSec
            pendingTie = null
            continue
          }
          events.push({ t: +mt.toFixed(4), dur: +durSec.toFixed(4), midi, string: stringIdx, fret: n.fret, measure: mi, velocity: b.velocity ?? null })
          if (n.tie === true) pendingTie = { stringIdx, t: mt }
        }
        mt += durSec
      }
    }
    t += beatsPerMeasure * spbAt(mi)
  }

  events.sort((a, b) => a.t - b.t || a.midi - b.midi)
  return { events, bpm: bpmAt(0), tuning, measures: tr.measures.length, duration: +t.toFixed(2) }
}

// ---------- ② 帧矩阵推理 + 落盘缓存 ----------
// 整曲只推理一次(约 8~12 分钟);之后所有对齐/验证/参数实验都走缓存,秒级。
export interface FrameCache {
  framesF: Float32Array
  onsetsF: Float32Array
  nFrames: number
  nBins: number
  duration: number
}

export async function inferFrameCache(
  bp: { evaluateModel: (input: Float32Array, onFrames: (f: number[][], o: number[][]) => void, onProgress: (p: number) => void) => Promise<void> },
  pcm: Float32Array,
  cacheBase: string,
): Promise<FrameCache> {
  const framesPath = cacheBase + '.frames.f32'
  const onsetsPath = cacheBase + '.onsets.f32'
  const metaPath = cacheBase + '.meta.json'
  if (existsSync(framesPath) && existsSync(onsetsPath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { nFrames: number; nBins: number; duration?: number }
    const load = (p: string) => new Float32Array(readFileSync(p).buffer.slice(0, meta.nFrames * meta.nBins * 4))
    console.log(`帧缓存命中:${meta.nFrames} 帧`)
    return { framesF: load(framesPath), onsetsF: load(onsetsPath), nFrames: meta.nFrames, nBins: meta.nBins, duration: meta.duration ?? meta.nFrames / 86.58 }
  }
  const { evaluateChunked } = await import('../src/transcription/basicPitch')
  console.log('推理中(整曲一次,约 8~12 分钟)…')
  const { frames, onsets } = await evaluateChunked(bp as never, pcm, () => {})
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
  return { framesF, onsetsF, nFrames, nBins, duration: pcm.length / SR }
}

// ---------- ③ 对齐:起音网格搜 + 稳健回归 + 音高消歧 ----------
export interface AlignResult {
  offset: number
  scale: number
  pairs: number
  hitRate: number
  residual: { med: number; p90: number }
}

/** 粗对齐(offset×scale 网格)+ 精对齐(命中对稳健回归,两轮去外点) */
export function alignScoreToAudio(scoreOnsets: number[], audioOnsets: number[]): AlignResult {
  const TOL = 0.06
  const score = (offset: number, scale: number): { hits: number; w: number } => {
    let hits = 0
    let w = 0
    let ai = 0
    for (const s of scoreOnsets) {
      const at = s * scale + offset
      while (ai < audioOnsets.length - 1 && audioOnsets[ai + 1] < at - TOL) ai++
      let best = Infinity
      for (let k = Math.max(0, ai - 2); k <= Math.min(audioOnsets.length - 1, ai + 3); k++) {
        const d = Math.abs(audioOnsets[k] - at)
        if (d < best) best = d
      }
      if (best <= TOL) {
        hits++
        w += 1 - best / TOL
      }
    }
    return { hits, w }
  }

  let best = { offset: 0, scale: 1, hits: 0, w: -1 }
  for (let scale = 0.998; scale <= 1.012; scale += 0.0005) {
    for (let offset = -4; offset <= 4; offset += 0.05) {
      const r = score(offset, scale)
      if (r.w > best.w) best = { offset: +offset.toFixed(3), scale: +scale.toFixed(4), hits: r.hits, w: +r.w.toFixed(1) }
    }
  }
  console.log(`粗对齐:offset ${best.offset}s · scale ${best.scale} · 命中 ${best.hits}/${scoreOnsets.length}(${((best.hits / scoreOnsets.length) * 100).toFixed(1)}%)`)

  const pairs: Array<[number, number]> = []
  {
    let ai = 0
    for (const s of scoreOnsets) {
      const at = s * best.scale + best.offset
      while (ai < audioOnsets.length - 1 && audioOnsets[ai + 1] < at - TOL) ai++
      let bk = -1
      let bd = Infinity
      for (let k = Math.max(0, ai - 2); k <= Math.min(audioOnsets.length - 1, ai + 3); k++) {
        const d = Math.abs(audioOnsets[k] - at)
        if (d < bd) {
          bd = d
          bk = k
        }
      }
      if (bk >= 0 && bd <= TOL) pairs.push([s, audioOnsets[bk]])
    }
  }
  const fitLinear = (pts: Array<[number, number]>): { a: number; b: number } => {
    const n = pts.length
    const ms = pts.reduce((x, p) => x + p[0], 0) / n
    const ma = pts.reduce((x, p) => x + p[1], 0) / n
    let num = 0
    let den = 0
    for (const [s, a] of pts) {
      num += (s - ms) * (a - ma)
      den += (s - ms) ** 2
    }
    const b = den > 0 ? num / den : 1
    return { a: ma - b * ms, b }
  }
  let fit = fitLinear(pairs)
  for (let round = 0; round < 2; round++) {
    const res = pairs.map((p) => Math.abs(p[1] - (fit.a + fit.b * p[0])))
    res.sort((x, y) => x - y)
    const med = res[res.length >> 1]
    const keep = pairs.filter((p) => Math.abs(p[1] - (fit.a + fit.b * p[0])) <= Math.max(0.03, 2.5 * med))
    fit = fitLinear(keep)
  }
  const finalRes = pairs.map((p) => p[1] - (fit.a + fit.b * p[0])).sort((x, y) => x - y)
  const hitRate = score(fit.a, fit.b).hits / scoreOnsets.length
  console.log(`精对齐:audioT = ${fit.a.toFixed(3)} + ${fit.b.toFixed(5)} × scoreT · 匹配对 ${pairs.length}`)
  console.log(`残差:中位 ${finalRes[finalRes.length >> 1].toFixed(3)}s · P90 ${finalRes[Math.floor(finalRes.length * 0.9)].toFixed(3)}s · 命中率 ${(hitRate * 100).toFixed(1)}%`)
  return { offset: fit.a, scale: fit.b, pairs: pairs.length, hitRate, residual: { med: finalRes[finalRes.length >> 1], p90: finalRes[Math.floor(finalRes.length * 0.9)] } }
}

/**
 * 音高消歧(修"差一拍"类错误):起音列车无法分辨整拍平移(±1 拍的命中率几乎相同),
 * 但**音高激活**可以——只有真正的偏移会让参考音符的音高在对应时刻亮起来。
 * 对 [估计值 ± 3 拍] 的候选逐一计算采样参考音的平均音高激活,取最大者。
 */
export function disambiguateByPitch(
  align: AlignResult,
  beatSec: number,
  events: ScoreEvent[],
  cache: FrameCache,
): { offset: number; k: number; bestScore: number; scores: Array<{ k: number; score: number }> } {
  const MIDI_BASE = 21
  const pitchAt = (t: number, midi: number): number => {
    const b = midi - MIDI_BASE
    if (b < 0 || b >= cache.nBins) return 0
    const f0 = Math.max(0, bpTimeToFrame(Math.max(0, t)))
    const f1 = Math.min(cache.nFrames - 1, bpTimeToFrame(t + 0.06))
    let m = 0
    for (let f = f0; f <= f1; f++) m = Math.max(m, cache.framesF[f * cache.nBins + b])
    return m
  }
  const sampleEvs: ScoreEvent[] = []
  for (let i = 0; i < events.length; i += Math.max(1, Math.floor(events.length / 400))) sampleEvs.push(events[i])
  let bestK = 0
  let bestS = -1
  const scores: Array<{ k: number; score: number }> = []
  for (let k = -3; k <= 3; k++) {
    const off = align.offset + k * beatSec
    const s = sampleEvs.reduce((a, e) => a + pitchAt(off + align.scale * e.t, e.midi), 0) / sampleEvs.length
    console.log(`  音高消歧:offset ${off.toFixed(3)}s(k=${k})→ 平均激活 ${s.toFixed(3)}`)
    scores.push({ k, score: s })
    if (s > bestS) {
      bestS = s
      bestK = k
    }
  }
  if (bestK !== 0) console.log(`→ 音高证据否决了起音估计:offset 修正 ${bestK} 拍(${(bestK * beatSec).toFixed(2)}s)→ ${(align.offset + bestK * beatSec).toFixed(3)}s`)
  else console.log('→ 音高证据确认起音估计(0 拍偏移)')
  return { offset: align.offset + bestK * beatSec, k: bestK, bestScore: bestS, scores }
}

// ---------- ④ 逐音符验证 + 曲库条目 ----------
// 双证据:DSP 起音 ±60ms + BP 帧激活(120ms 窗最大)。
// 失真吉他的物理事实:基频桶常弱而 +12/+19/+24 泛音桶强 → "直检弱但同刻泛音强 + 有起音"
// 仍是该音存在的有效证据(标记为泛音验证)。分级阈值实测依据见 REF.md。
export interface VerdictNote {
  t: number
  midi: number
  m: number
  verdict: 'strong' | 'ok' | 'weak' | 'none'
  ev: string
  pitch: number
  onset: boolean
}

export interface LibNote {
  id: number
  step: number
  dur: number
  midi: number
  string: number
  fret: number
  conf: number
}

export interface VerifyTrackResult {
  song: {
    id: string
    name: string
    bpm: number
    tuningId: string
    notes: LibNote[]
    updatedAt: string
    grid: number
    source?: string
  }
  n: number
  perNote: VerdictNote[]
  verdictCount: { strong: number; ok: number; weak: number; none: number }
}

export function verifyTrack(
  evs: ScoreEvent[],
  align: { offset: number; scale: number; bpmScore: number },
  cache: FrameCache,
  audioOnsets: number[],
  trackLabel: string,
  songTitle: string,
): VerifyTrackResult {
  const MIDI_BASE = 21
  const pitchAt = (t: number, midi: number, winSec = 0.12): number => {
    const b = midi - MIDI_BASE
    if (b < 0 || b >= cache.nBins) return 0
    const f0 = Math.max(0, bpTimeToFrame(t))
    const f1 = Math.min(cache.nFrames - 1, bpTimeToFrame(t + winSec))
    let m = 0
    for (let f = f0; f <= f1; f++) m = Math.max(m, cache.framesF[f * cache.nBins + b])
    return m
  }
  const onsetSupport = (t: number, tol = 0.06): boolean => {
    let lo = 0
    let hi = audioOnsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (audioOnsets[mid] < t - tol) lo = mid + 1
      else hi = mid
    }
    for (let k = lo; k < audioOnsets.length && audioOnsets[k] <= t + tol; k++) if (Math.abs(audioOnsets[k] - t) <= tol) return true
    return false
  }
  const beatSec = 60 / align.bpmScore
  const SUB = 12 // 每拍 12 格(与产品网格一致)
  const notes: LibNote[] = []
  const perNote: VerdictNote[] = []
  const verdictCount = { strong: 0, ok: 0, weak: 0, none: 0 }
  for (const e of evs) {
    const at = align.offset + align.scale * e.t
    const p = pitchAt(at, e.midi)
    const p12 = pitchAt(at, e.midi + 12)
    const p19 = pitchAt(at, e.midi + 19)
    const p24 = pitchAt(at, e.midi + 24)
    const harm = Math.max(p12, p19, p24)
    const on = onsetSupport(at)
    let verdict: VerdictNote['verdict'] = 'none'
    let ev = 'none'
    let conf = 0.3
    if (p >= 0.3 && on) {
      verdict = 'strong'
      ev = 'direct+onset'
      conf = 0.95
    } else if (p >= 0.15 || (p >= 0.1 && on)) {
      verdict = 'ok'
      ev = p >= 0.15 ? 'direct' : 'direct-weak+onset'
      conf = 0.8
    } else if (on && p >= 0.05 && harm >= 0.35) {
      verdict = 'ok'
      ev = 'harmonic+onset'
      conf = 0.75
    } else if (p >= 0.08 || (on && p >= 0.05) || (p >= 0.04 && harm >= 0.25)) {
      verdict = 'weak'
      ev = on ? 'onset-only' : 'trace'
      conf = 0.55
    }
    verdictCount[verdict]++
    perNote.push({ t: +at.toFixed(3), midi: e.midi, m: e.measure, verdict, ev, pitch: +p.toFixed(3), onset: on })
    // step:锚在 align.offset(谱面 t=0 的音频时刻)——参考谱时间本身就是拍点整数倍,零量化误差
    const step = Math.round(((at - align.offset) / beatSec) * SUB)
    const dur = Math.max(1, Math.round((e.dur / beatSec) * SUB))
    notes.push({
      id: notes.length,
      step: Math.max(0, step),
      dur,
      midi: e.midi,
      string: 5 - e.string, // Songsterr 0=最细弦 → 产品 0=最低弦
      fret: e.fret,
      conf,
    })
  }
  return {
    song: { id: songTitle, name: songTitle, bpm: align.bpmScore, tuningId: 'standard', notes, updatedAt: new Date().toISOString(), grid: SUB, source: 'ref' },
    n: notes.length,
    perNote,
    verdictCount,
  }
}
