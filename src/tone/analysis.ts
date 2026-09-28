// 单音音色分析:谐波结构 / 包络 / 频谱特征(纯逻辑,可在 Node 测试)
import { yin, rms, makeYinScratch } from '../audio/pitch'
import { frameSpectrum, hannWindow, harmonicAmplitude, spectralCentroid, spectralFlatness, spectralRolloff } from '../audio/analysis'
import { freqToMidiFloat, midiToName } from '../theory/notes'

export interface ToneReport {
  noteName: string
  cents: number
  freq: number
  harmonics: number[] // H1..H8,归一化到 H1=1
  oddEven: number
  centroid: number
  rolloff: number
  flatness: number
  attackMs: number
  decayS: number
  stabilityCents: number // 音准抖动(音分,标准差)
  distortionRatio: number
}

export function analyzeTone(buffer: AudioBuffer): ToneReport | null {
  const sr = buffer.sampleRate
  const data = buffer.getChannelData(0)
  const frame = 2048
  const hop = 1024
  // 逐帧音高 → 中位数 f0 与稳定度
  const f0s: number[] = []
  const scratch = makeYinScratch(frame, sr, 70)
  for (let off = 0; off + frame <= data.length; off += hop) {
    const seg = data.subarray(off, off + frame)
    const { freq, prob } = yin(seg as Float32Array, sr, 0.13, 70, 900, scratch)
    if (freq > 0 && prob > 0.7) f0s.push(freq)
  }
  if (f0s.length < 3) return null
  f0s.sort((a, b) => a - b)
  const f0 = f0s[Math.floor(f0s.length / 2)]
  const centsDevs = f0s.map((f) => 1200 * Math.log2(f / f0))
  const mean = centsDevs.reduce((a, b) => a + b, 0) / centsDevs.length
  const std = Math.sqrt(centsDevs.reduce((a, b) => a + (b - mean) ** 2, 0) / centsDevs.length)
  // 包络(小窗 RMS)
  const envHop = 64
  const win = 256
  const env: number[] = []
  for (let off = 0; off + win <= data.length; off += envHop) {
    env.push(rms(data.subarray(off, off + win) as Float32Array))
  }
  let peakI = 0
  for (let i = 1; i < env.length; i++) if (env[i] > env[peakI]) peakI = i
  let attackEnd = peakI
  for (let i = 0; i < peakI; i++) {
    if (env[i] >= env[peakI] * 0.9) {
      attackEnd = i
      break
    }
  }
  // 起音起点相对底噪(前 10% 帧的中位数)而非纯峰值比例,带底噪的录音不再虚高
  const head = Math.max(1, Math.floor(env.length * 0.1))
  const sortedHead = [...env.slice(0, head)].sort((a, b) => a - b)
  const noiseFloor = sortedHead[Math.floor(sortedHead.length / 2)] ?? 0
  const startThresh = Math.max(env[peakI] * 0.1, noiseFloor * 2)
  let attackStart = attackEnd
  for (let i = attackEnd; i >= 0; i--) {
    if (env[i] <= startThresh) {
      attackStart = i
      break
    }
  }
  const attackMs = ((attackEnd - attackStart) * envHop * 1000) / sr
  let decayEnd = env.length - 1
  for (let i = peakI; i < env.length; i++) {
    if (env[i] <= env[peakI] * 0.01) {
      decayEnd = i
      break
    }
  }
  const decayS = (Math.max(0, decayEnd - peakI) * envHop) / sr
  // 谐波与频谱特征:取延音段(峰值后 35%)一帧大 FFT
  const sustainOff = Math.min(
    data.length - 4097,
    Math.max(0, Math.floor(peakI * envHop + (data.length - peakI * envHop) * 0.35)),
  )
  const fftSize = 4096
  const seg = new Float32Array(fftSize)
  for (let i = 0; i < fftSize; i++) seg[i] = data[sustainOff + i] ?? 0
  const mag = frameSpectrum(seg, hannWindow(fftSize))
  const harmonics: number[] = []
  for (let n = 1; n <= 8; n++) harmonics.push(harmonicAmplitude(mag, sr, fftSize, f0 * n, f0))
  const h1 = harmonics[0] || 1e-9
  const norm = harmonics.map((h) => h / h1)
  const odd = norm[2] + norm[4] + norm[6]
  const even = norm[1] + norm[3] + norm[5] + norm[7]
  const oddEven = even > 1e-6 ? odd / even : odd
  const midiF = freqToMidiFloat(f0)
  const cents = (midiF - Math.round(midiF)) * 100
  return {
    noteName: midiToName(Math.round(midiF)),
    cents,
    freq: f0,
    harmonics: norm,
    oddEven,
    centroid: spectralCentroid(mag, sr, fftSize),
    rolloff: spectralRolloff(mag, sr, fftSize),
    flatness: spectralFlatness(mag),
    attackMs,
    decayS,
    stabilityCents: std,
    distortionRatio: norm.slice(1).reduce((a, b) => a + b, 0),
  }
}
