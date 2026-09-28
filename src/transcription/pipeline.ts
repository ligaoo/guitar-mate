// 自动扒谱 DSP 管线:重采样 → STFT → 频谱通量起音检测 → YIN 逐帧音高 → 音符分割 → BPM 估计 → 量化
// 设计为在 Web Worker 中运行,适合单旋律/单音吉他片段(复音失真段落准确率有限)
import { yin, makeYinScratch } from '../audio/pitch'

export const SR = 22050

export interface RawNote {
  start: number // 秒(原始时间)
  end: number
  midi: number
  confidence: number // 0-1
  velocity: number // 0-1
}

export interface TranscribeResult {
  notes: RawNote[]
  onsets: number[]
  bpm: number
  offset: number // 量化锚点(第一拍)秒
  duration: number
  f0Track: Float32Array // 每 hop 一帧的 f0(0=无),供 UI 画音高轨迹
  likelyPolyphonic?: boolean // DSP 路径的复音疑似标记(建议切换 Basic Pitch)
  bpmStrength?: number // 节拍锁定度 0-1(包络自相关峰值归一化),高=可信
}

export function toMono(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0].slice() // 不改写入参
  const out = new Float32Array(length)
  for (const ch of channels) for (let i = 0; i < length; i++) out[i] += ch[i] / channels.length
  return out
}

export function resampleLinear(data: Float32Array, srIn: number, srOut: number): Float32Array {
  if (srIn === srOut) return data
  const ratio = srIn / srOut
  const n = Math.floor(data.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    out[i] = data[i0] * (1 - frac) + (data[i0 + 1] ?? data[i0]) * frac
  }
  return out
}

function normalize(data: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  const out = new Float32Array(data.length) // 不改写入参
  if (peak < 1e-6) return out
  const g = 0.95 / peak
  for (let i = 0; i < data.length; i++) out[i] = data[i] * g
  return out
}

// ---- STFT 与频谱通量 ----

const WIN = 1024
const HOP = 256
// 分析前在信号前补 WIN 个采样(让开头的起音有"静音 → 发声"的对比帧可检)。
// 所有"帧序号 → 时间"的换算都必须减去这个偏移,否则整谱的起音会系统性偏晚约 46ms。
const PAD_SEC = WIN / SR

function stftMags(data: Float32Array): { mags: Float32Array[]; rms: Float32Array; times: Float32Array } {
  const win = new Float32Array(WIN)
  for (let i = 0; i < WIN; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)))
  const nFrames = Math.max(0, Math.floor((data.length - WIN) / HOP) + 1)
  const mags: Float32Array[] = []
  const rms = new Float32Array(nFrames)
  const times = new Float32Array(nFrames)
  const re = new Float32Array(WIN)
  const im = new Float32Array(WIN)
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP
    let energy = 0
    for (let i = 0; i < WIN; i++) {
      const v = data[off + i] || 0
      energy += v * v
      re[i] = v * win[i]
      im[i] = 0
    }
    rms[f] = Math.sqrt(energy / WIN)
    times[f] = (off + WIN / 2) / SR
    fftInPlace(re, im)
    const mag = new Float32Array(WIN / 2)
    for (let i = 0; i < WIN / 2; i++) mag[i] = Math.hypot(re[i], im[i])
    mags.push(mag)
  }
  return { mags, rms, times }
}

export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k + len / 2] = re[i + k] - vr
        im[i + k + len / 2] = im[i + k] - vi
        re[i + k] += vr
        im[i + k] += vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function detectOnsets(mags: Float32Array[], rms: Float32Array): number[] {
  const n = mags.length
  if (n < 4) return []
  const flux = new Float32Array(n)
  for (let f = 1; f < n; f++) {
    let s = 0
    const a = mags[f]
    const b = mags[f - 1]
    for (let i = 2; i < a.length; i++) {
      const d = a[i] - b[i]
      if (d > 0) s += d * d
    }
    flux[f] = Math.sqrt(s)
  }
  // 自适应阈值:局部均值 * 系数 + delta
  const w = 12 // ±12 帧 ≈ ±140ms
  const thr = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    let cnt = 0
    for (let k = Math.max(0, f - w); k <= Math.min(n - 1, f + w); k++) {
      sum += flux[k]
      cnt++
    }
    thr[f] = (sum / cnt) * 1.5 + 0.02
  }
  const onsets: number[] = []
  let lastT = -1
  for (let f = 2; f < n - 2; f++) {
    if (flux[f] > thr[f] && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && flux[f] > flux[f - 2] && flux[f] > flux[f + 2]) {
      // 起音必须伴随能量上升:衰减拖尾里的频谱闪变不是新音符
      if (f >= 2 && rms[f] < rms[f - 2] * 1.15 && rms[f] < 0.6) continue
      // 抛物线插值细化峰值位置:把帧量化的 ±半帧(≈±6ms)误差降到 ±2ms 左右
      const denom = flux[f - 1] - 2 * flux[f] + flux[f + 1]
      const delta = denom !== 0 ? (0.5 * (flux[f - 1] - flux[f + 1])) / denom : 0
      const t = ((f + Math.max(-0.5, Math.min(0.5, delta))) * HOP + WIN / 2) / SR - PAD_SEC
      if (t - lastT >= 0.07) {
        onsets.push(t)
        lastT = t
      }
    }
  }
  return onsets
}

/** 去掉 120ms 内的「同音伪起音」:衰减拖尾的频谱闪变会触发第二个起音,
 *  若相邻两段的稳定音高相同(±0.8 半音),合并为一段 */
function suppressSamePitchOnsets(onsets: number[], f0: Float32Array, duration: number): number[] {
  if (onsets.length < 3) return onsets
  const segMedian = (a: number, b: number) => {
    const midis: number[] = []
    for (let f = 0; f < f0.length; f++) {
      const t = frameTime(f)
      if (t < a + 0.01 || t >= b) continue
      if (f0[f] > 0) midis.push(69 + 12 * Math.log2(f0[f] / 440))
    }
    if (midis.length === 0) return null
    midis.sort((x, y) => x - y)
    return midis[Math.floor(midis.length / 2)]
  }
  const bounds = [...onsets, duration]
  const keep: number[] = [onsets[0]]
  for (let i = 1; i < onsets.length; i++) {
    const gap = onsets[i] - onsets[i - 1]
    if (gap < 0.12) {
      const prev = segMedian(bounds[i - 1], bounds[i])
      const cur = segMedian(bounds[i], bounds[i + 1])
      if (prev !== null && cur !== null && Math.abs(prev - cur) < 0.8) continue // 同音伪起音
    }
    keep.push(onsets[i])
  }
  return keep
}

// ---- 音高跟踪 ----

function trackF0(data: Float32Array): Float32Array {
  const frame = 1536
  const hop = HOP
  const n = Math.max(0, Math.floor((data.length - frame) / hop) + 1)
  const out = new Float32Array(n)
  const buf = new Float32Array(frame)
  const scratch = makeYinScratch(frame, SR, 70)
  for (let f = 0; f < n; f++) {
    const off = f * hop
    for (let i = 0; i < frame; i++) buf[i] = data[off + i] || 0
    const { freq, prob } = yin(buf, SR, 0.14, 70, 1200, scratch)
    out[f] = prob > 0.55 ? freq : 0
  }
  return out
}

const frameTime = (f: number) => (f * HOP + 1536 / 2) / SR - PAD_SEC

// ---- 分割 ----

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function segmentNotes(onsets: number[], f0: Float32Array, rms: Float32Array, duration: number): RawNote[] {
  const notes: RawNote[] = []
  const bounds = [...onsets, duration]
  for (let i = 0; i < bounds.length - 1; i++) {
    const t0 = bounds[i]
    const t1 = bounds[i + 1]
    // 收集该段内可信 f0
    const midis: number[] = []
    for (let f = 0; f < f0.length; f++) {
      const t = frameTime(f)
      if (t < t0 + 0.015 || t >= t1) continue
      if (f0[f] > 0) midis.push(69 + 12 * Math.log2(f0[f] / 440))
    }
    if (midis.length < 2) continue
    const med = median(midis)
    const rounded = Math.round(med)
    const inliers = midis.filter((m) => Math.abs(m - rounded) <= 0.7)
    const conf = inliers.length / midis.length
    if (conf < 0.5) continue
    // 结束时间:段内最后一个有声帧(能量阈值)
    let lastVoiced = t0
    for (let f = 0; f < rms.length; f++) {
      const t = (f * HOP + WIN / 2) / SR - PAD_SEC
      if (t >= t0 && t < t1 && rms[f] > 0.02) lastVoiced = t
    }
    const start = t0
    const end = Math.min(t1, Math.max(lastVoiced + 0.06, start + 0.09))
    if (end - start < 0.07) continue
    let vel = 0
    for (let f = 0; f < rms.length; f++) {
      const t = (f * HOP + WIN / 2) / SR - PAD_SEC
      if (t >= start && t < start + 0.08) vel = Math.max(vel, rms[f])
    }
    notes.push({
      start,
      end,
      midi: Math.max(40, Math.min(88, rounded)),
      confidence: Math.min(1, conf),
      velocity: Math.min(1, vel * 3.5),
    })
  }
  return notes
}

/** 无明显起音(连奏)时的兜底:按音高连续性分段。
 * 判据用「与段内中位数的偏差 ≤ 0.75 半音」而非取整相等——揉弦 ±0.6 半音不再把整段切碎;
 * 短段先保留、再与中位数相近的邻段合并,最后才按最短时值过滤。 */
export function segmentByPitchProbe(f0: Float32Array, rms: Float32Array): RawNote[] {
  return segmentByPitch(f0, rms)
}

function segmentByPitch(f0: Float32Array, rms: Float32Array): RawNote[] {
  interface Seg {
    start: number
    end: number
    midis: number[]
  }
  const segs: Seg[] = []
  let cur: Seg | null = null
  for (let f = 0; f < f0.length; f++) {
    const t = frameTime(f)
    const voiced = f0[f] > 0 && (f < rms.length ? rms[f] : 0) > 0.02
    if (!voiced) continue
    const mf = 69 + 12 * Math.log2(f0[f] / 440)
    if (!cur) {
      cur = { start: t, end: t, midis: [mf] }
    } else {
      const med = median(cur.midis)
      if (Math.abs(mf - med) <= 0.75) {
        // 仍属于当前音(含揉弦/小滑音),段中位数随之缓慢重锚
        cur.end = t
        cur.midis.push(mf)
      } else {
        segs.push(cur)
        cur = { start: t, end: t, midis: [mf] }
      }
    }
  }
  if (cur) segs.push(cur)
  // 相邻段中位数相差 ≤ 1 个半音 → 合并(揉弦来回摆动产生的碎段在此收拢)
  const merged: Seg[] = []
  for (const s of segs) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(median(last.midis) - median(s.midis)) <= 1 && s.start - last.end < 0.35) {
      last.end = s.end
      last.midis.push(...s.midis)
    } else {
      merged.push({ ...s, midis: [...s.midis] })
    }
  }
  return merged
    .filter((s) => s.end - s.start >= 0.12)
    .map((s) => ({
      start: s.start,
      end: s.end,
      midi: Math.max(40, Math.min(88, Math.round(median(s.midis)))),
      confidence: 0.55,
      velocity: 0.6,
    }))
}

// ---- BPM 估计与量化 ----

export function estimateBpm(onsets: number[]): { bpm: number } {
  const iois: number[] = []
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1]
    if (d >= 0.18) iois.push(d)
  }
  if (iois.length < 2) return { bpm: 90 }
  // 折叠到 [0.3, 1.25]s 拍长范围(48–200 BPM,覆盖审计矩阵的 60/200 两端)
  const LO = 0.3
  const HI = 1.25
  const folded = iois.map((d) => {
    let x = d
    while (x < LO) x *= 2
    while (x > HI) x /= 2
    return x
  })
  // 直方图(10ms 桶)+ 平滑,取众数;桶中心用桶内(含相邻桶)样本均值而非桶几何中心
  const BIN = 0.01
  const nb = Math.ceil((HI - LO) / BIN)
  const hist = new Float32Array(nb)
  const samples: number[][] = Array.from({ length: nb }, () => [])
  for (const x of folded) {
    const b = Math.min(nb - 1, Math.floor((x - LO) / BIN))
    hist[b]++
    samples[b].push(x)
  }
  const sm = new Float32Array(nb)
  for (let i = 0; i < nb; i++) {
    const a = hist[Math.max(0, i - 1)]
    const c = hist[Math.min(nb - 1, i + 1)]
    sm[i] = (a + 2 * hist[i] + c) / 4
  }
  let best = 0
  for (let i = 1; i < nb; i++) if (sm[i] > sm[best]) best = i
  const nearby = [...(samples[best - 1] ?? []), ...samples[best], ...(samples[best + 1] ?? [])]
  let period = nearby.length
    ? nearby.reduce((a, b) => a + b, 0) / nearby.length
    : LO + (best + 0.5) * BIN
  // 温和的八度仲裁:仅当众数桶支撑不足(少数派)且半/倍拍桶支撑 ≥ 1.5 倍时才切换,
  // 均匀 IOI(单一节奏)不会被先验翻转
  const support = (lo: number, hi: number) => folded.filter((x) => x >= lo && x <= hi).length
  const bpmOf = (p: number) => 60 / p
  const bestSupport = support(period * 0.96, period * 1.04)
  if (bestSupport < folded.length * 0.4) {
    for (const cand of [period / 2, period * 2]) {
      if (cand < LO || cand > HI) continue
      const s = support(cand * 0.96, cand * 1.04)
      if (s >= bestSupport * 1.5 && s >= folded.length * 0.4) {
        // 目标桶需确实存在样本,避免空桶翻倍
        period = cand
        break
      }
    }
  }
  return { bpm: Math.max(30, Math.min(300, Math.round(bpmOf(period)))) }
}

/** 起音包络自相关 BPM 估计:整曲节拍(跟鼓点/和声律动)比"音符汤间隔直方图"稳健得多。
 *  包络去均值 → 自相关(滞后 ≈ 30-225 BPM)→ 平滑找峰 → 90-180 BPM 先验 → 半速倍频仲裁。
 *  strength = 最优滞后处的自相关值 / 方差(≈ lag0),~0.1 以上视为节拍锁定。 */
export function estimateBpmFromEnvelope(env: Float32Array, fps: number): { bpm: number; strength: number } {
  const n = env.length
  if (n < fps * 2) return { bpm: 0, strength: 0 }
  let mean = 0
  for (let i = 0; i < n; i++) mean += env[i]
  mean /= n
  let varr = 0
  for (let i = 0; i < n; i++) varr += (env[i] - mean) * (env[i] - mean)
  if (varr < 1e-9) return { bpm: 0, strength: 0 }
  const minLag = Math.max(2, Math.floor((60 / 225) * fps))
  const maxLag = Math.min(n - 2, Math.ceil((60 / 30) * fps))
  const ac = new Float32Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean)
    ac[lag] = s / (n - lag)
  }
  // 3 点平滑抑制单帧毛刺
  const sm = new Float32Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    sm[lag] =
      ((ac[lag - 1] ?? 0) + 2 * ac[lag] + (ac[lag + 1] ?? 0)) / 4
  }
  // 局部极大候选峰,按值排序
  const peaks: { lag: number; v: number }[] = []
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (sm[lag] > sm[lag - 1] && sm[lag] >= sm[lag + 1] && sm[lag] > 0) peaks.push({ lag, v: sm[lag] })
  }
  if (peaks.length === 0) return { bpm: 0, strength: 0 }
  peaks.sort((a, b) => b.v - a.v)
  // 先验:最强 10 个峰里优先 90-180 BPM(常见歌曲节拍区间),没有再退回全局最强
  const top = peaks.slice(0, 10)
  const inRange = top.filter((p) => {
    const b = (60 * fps) / p.lag
    return b >= 90 && b <= 180
  })
  const best = inRange.length ? inRange[0] : top[0]
  // 倍频仲裁:若半周期处(lag/2)也有相当强度的峰,取更快的那个(避免半速)
  let lag = best.lag
  while (lag / 2 >= minLag) {
    const half = Math.floor(lag / 2)
    const halfV = sm[half]
    if (halfV >= sm[lag] * 0.72 && halfV > (sm[half - 1] ?? 0) && halfV >= (sm[half + 1] ?? 0)) {
      lag = half
    } else break
  }
  // 亚帧精度:对原始自相关峰做抛物线插值(整数滞后在快歌处每帧 ≈ ±3 BPM,插值后 <0.5)
  const y0 = ac[lag - 1] ?? 0
  const y1 = ac[lag]
  const y2 = ac[lag + 1] ?? 0
  const denom = y0 - 2 * y1 + y2
  const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  const lagFine = lag + Math.max(-0.5, Math.min(0.5, delta))
  const bpm = (60 * fps) / lagFine
  return { bpm: Math.max(30, Math.min(300, Math.round(bpm))), strength: Math.max(0, Math.min(1, sm[lag] / (varr / n))) }
}

/** 主入口:完整管线 */
export function transcribe(monoData: Float32Array, srIn: number): TranscribeResult {  const resampled = normalize(resampleLinear(monoData, srIn, SR))
  const duration = resampled.length / SR
  // 前置补零:保证信号开头的起音有"静音 → 发声"的对比帧可检
  const padded = new Float32Array(WIN + resampled.length)
  padded.set(resampled, WIN)
  const { mags, rms } = stftMags(padded)
  let onsets = detectOnsets(mags, rms)
  // 起音漏检兜底:信号在首个起音前已有明显发声时,补一个起点
  let firstSound = -1
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] > 0.02) {
      firstSound = (f * HOP + WIN / 2) / SR - PAD_SEC
      break
    }
  }
  if (firstSound >= 0 && (onsets.length === 0 || onsets[0] - firstSound > 0.12)) {
    onsets = [Math.max(0, firstSound), ...onsets]
  }
  const f0 = trackF0(padded)
  // 同音伪起音合并(需先有 f0)
  onsets = suppressSamePitchOnsets(onsets, f0, duration)
  let notes = onsets.length >= 2 ? segmentNotes(onsets, f0, rms, duration) : []
  if (notes.length === 0) notes = segmentByPitch(f0, rms)
  // 复音疑似检测:有能量的帧里 YIN 检出稳定单音的比例过低(和弦/双音会让 YIN 失效)
  let energyFrames = 0
  let voicedEnergyFrames = 0
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] <= 0.02) continue
    energyFrames++
    if (f0[f] > 0) voicedEnergyFrames++
  }
  const likelyPolyphonic = energyFrames >= 10 && voicedEnergyFrames / energyFrames < 0.45
  // 合并同音连续(误检起音)
  const merged: RawNote[] = []
  for (const n of notes) {
    const last = merged[merged.length - 1]
    if (last && last.midi === n.midi && n.start - last.end < 0.04) {
      last.end = n.end
      last.confidence = Math.max(last.confidence, n.confidence)
    } else {
      merged.push({ ...n })
    }
  }
  const { bpm } = estimateBpm(onsets.length >= 2 ? onsets : merged.map((n) => n.start))
  const offset = onsets.length > 0 ? onsets[0] : merged.length > 0 ? merged[0].start : 0
  return { notes: merged, onsets, bpm, offset, duration, f0Track: f0, likelyPolyphonic }
}
