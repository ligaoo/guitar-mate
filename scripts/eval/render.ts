// 扒谱评估:把标注渲染成音频
//
// 完全离线、确定性(可注入 mulberry32 种子),不依赖 AudioContext。
// 支持四种乐器,其中贝斯/人声/鼓的作用是"污染"——复现整首歌识别时
// 低频谐波(贝斯)、同音区持续音(人声)、宽带瞬态(鼓)带来的伪音符。

import { renderPluckSamples } from '../../src/audio/synth'
import { midiToFreq } from '../../src/theory/notes'
import type { EvalClip, EvalTrack } from './types'
import { EVAL_SR as SR } from './types'

/** mulberry32:小而快的确定性 PRNG,保证同一 fixture 每次渲染完全一致 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash32 = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 由音高+起始时间派生每音独立种子:改一个音不会扰动其它音 */
const noteSeed = (freq: number, start: number, salt: number): number => {
  let h = (Math.round(freq * 1000) ^ Math.round(start * 10000) ^ salt) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) >>> 0
}

/** 渲染时的实际频率:叠加整体失谐与参考音高偏差(标注音高不变) */
export function noteFreq(midi: number, clip: EvalClip): number {
  const ratio = Math.pow(2, clip.detuneCents / 1200) * (clip.a4 / 440)
  return midiToFreq(midi) * ratio
}

export function clipDuration(clip: EvalClip): number {
  let end = 0
  for (const t of clip.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.dur)
  return end + clip.tail
}

function peakNormalize(buf: Float32Array, target: number): Float32Array {
  let peak = 0
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
  if (peak < 1e-9) return buf
  const g = target / peak
  for (let i = 0; i < buf.length; i++) buf[i] *= g
  return buf
}

/** 拨弦类乐器(吉他/贝斯):Karplus-Strong,靠 brightness 与音高区分音色 */
function renderPlucked(track: EvalTrack, clip: EvalClip, len: number, salt: number, brightness: number): Float32Array {
  const out = new Float32Array(len)
  for (const n of track.notes) {
    const f = noteFreq(n.midi, clip)
    // 出音时长严格等于标注时长:若让上一个音继续拖过下一个音的起点,音频里就真的
    // 存在两个同时发声的音而标注只有一个——那会把"正确检出的延音"算成假阳性。
    const ring = Math.min(2.6, Math.max(0.12, n.dur))
    const rng = makeRng(noteSeed(f, n.start, salt))
    const buf = renderPluckSamples(f, SR, ring, brightness, rng)
    const jitter = track.humanize ? (rng() - 0.5) * 2 * track.humanize : 0
    const strumOff = track.strum && n.string !== undefined ? n.string * track.strum : 0
    const from = Math.max(0, Math.floor((n.start + jitter + strumOff) * SR))
    const vel = n.velocity ?? 0.8
    const lim = Math.min(buf.length, len - from)
    for (let i = 0; i < lim; i++) out[from + i] += buf[i] * vel
  }
  return out
}

/** 人声:谐波堆 + 颤音 + 共振峰包络。目的是在吉他音区制造一个"居中的持续单音" */
function renderVocal(track: EvalTrack, clip: EvalClip, len: number, salt: number): Float32Array {
  const out = new Float32Array(len)
  const FF = [700, 1220, 2600, 3400]
  const FB = [130, 180, 250, 300]
  const MAXH = 16
  for (const n of track.notes) {
    const f0 = noteFreq(n.midi, clip)
    const from = Math.floor(n.start * SR)
    const to = Math.min(len, Math.floor((n.start + n.dur) * SR))
    if (to <= from) continue
    const atk = Math.max(1, Math.floor(0.05 * SR))
    const rel = Math.max(1, Math.floor(0.09 * SR))
    const vel = n.velocity ?? 0.8
    const phase = makeRng(noteSeed(f0, n.start, salt))() * Math.PI * 2
    for (let k = from; k < to; k++) {
      const t = (k - from) / SR
      // 颤音 5.5Hz、±15 音分,起振后 0.25s 渐入
      const vib = 1 + 0.0087 * Math.min(1, t / 0.25) * Math.sin(2 * Math.PI * 5.5 * t)
      const env = k - from < atk ? (k - from) / atk : to - k < rel ? (to - k) / rel : 1
      let s = 0
      for (let h = 1; h <= MAXH; h++) {
        const fh = f0 * h * vib
        if (fh > SR * 0.45) break
        let fg = 0.15
        for (let q = 0; q < FF.length; q++) {
          const d = (fh - FF[q]) / FB[q]
          fg += 0.7 * Math.exp(-d * d)
        }
        s += (fg / Math.pow(h, 1.15)) * Math.sin(2 * Math.PI * fh * t + phase * h)
      }
      out[k] += s * env * vel
    }
  }
  return out
}

/** 鼓:按 GM 编号区分 36=底鼓 / 38=军鼓 / 42=踩镲。宽带瞬态是伪起音的主要来源 */
function renderDrums(track: EvalTrack, clip: EvalClip, len: number, salt: number): Float32Array {
  const out = new Float32Array(len)
  for (const n of track.notes) {
    const rng = makeRng(noteSeed(n.midi, n.start, salt))
    const jitter = track.humanize ? (rng() - 0.5) * 2 * track.humanize : 0
    const from = Math.max(0, Math.floor((n.start + jitter) * SR))
    const vel = n.velocity ?? 0.8
    const t60 = n.midi === 36 ? 0.22 : n.midi === 38 ? 0.13 : 0.045
    const dur = Math.ceil(t60 * 4 * SR)
    const lim = Math.min(dur, len - from)
    if (n.midi === 36) {
      // 底鼓:音高快速下滑的正弦(110 → 45Hz)
      let ph = 0
      for (let i = 0; i < lim; i++) {
        const t = i / SR
        const f = 45 + 75 * Math.exp(-t / 0.028)
        ph += (2 * Math.PI * f) / SR
        out[from + i] += Math.sin(ph) * Math.exp(-t / t60) * vel
      }
    } else if (n.midi === 38) {
      // 军鼓:一阶低通噪声(近似鼓皮宽带)+ 190Hz 基音
      let lp = 0
      for (let i = 0; i < lim; i++) {
        const t = i / SR
        const w = rng() * 2 - 1
        lp += 0.6 * (w - lp)
        const env = Math.exp(-t / t60)
        out[from + i] += (lp * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.5) * env * vel
      }
    } else {
      // 踩镲:噪声一阶差分(高通)
      let prev = 0
      for (let i = 0; i < lim; i++) {
        const t = i / SR
        const w = rng() * 2 - 1
        const hp = w - prev
        prev = w
        out[from + i] += hp * Math.exp(-t / t60) * 0.7 * vel
      }
    }
  }
  return out
}

/** 渲染单条轨道(已按 track.gain 峰值归一,尚未声像摆放) */
export function renderTrack(track: EvalTrack, clip: EvalClip, len: number, saltSeed = 0): Float32Array {
  const salt = (hash32(track.id) ^ saltSeed) >>> 0
  let buf: Float32Array
  if (track.instrument === 'vocal') buf = renderVocal(track, clip, len, salt)
  else if (track.instrument === 'drums') buf = renderDrums(track, clip, len, salt)
  else buf = renderPlucked(track, clip, len, salt, track.instrument === 'bass' ? 0.3 : 0.7)
  return peakNormalize(buf, track.gain)
}

export interface RenderedClip {
  left: Float32Array
  right: Float32Array
  /** 各轨的独立信号(峰值归一后、未摆声像),用于诊断 */
  stems: Map<string, Float32Array>
  duration: number
}

/** 渲染整段:各轨 → 声像摆放 → 混音 → 峰值归一到 0.9(等价于一首成品的电平) */
export function renderClip(clip: EvalClip, seed = 1): RenderedClip {
  const duration = clipDuration(clip)
  const len = Math.ceil(duration * SR)
  const left = new Float32Array(len)
  const right = new Float32Array(len)
  const stems = new Map<string, Float32Array>()
  for (const track of clip.tracks) {
    const data = renderTrack(track, clip, len, seed)
    stems.set(track.id, data)
    // 等功率声像
    const th = ((track.pan + 1) * Math.PI) / 4
    const gl = Math.cos(th)
    const gr = Math.sin(th)
    for (let i = 0; i < len; i++) {
      const v = data[i]
      left[i] += v * gl
      right[i] += v * gr
    }
  }
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  if (peak > 1e-9) {
    const g = 0.9 / peak
    for (let i = 0; i < len; i++) {
      left[i] *= g
      right[i] *= g
    }
    for (const s of stems.values()) for (let i = 0; i < len; i++) s[i] *= g
  }
  return { left, right, stems, duration }
}
