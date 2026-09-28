// 录音音高轨迹:帧级 YIN 跟踪 + 稳定段分割(带音名/音分),纯逻辑可 Node 测试
import { yin, makeYinScratch } from '../audio/pitch'
import { midiToName } from '../theory/notes'

export interface PitchFrame {
  t: number
  freq: number
  prob: number
  rms: number
}

export interface PitchSegment {
  start: number
  end: number
  midi: number // 段内中位数(连续值)
  noteName: string // 最近半音的音名
  cents: number // 相对最近半音的偏差
  stability: number // 段内音高标准差(音分)
  conf: number // 平均置信度
}

export interface PitchTrackResult {
  frames: PitchFrame[]
  segments: PitchSegment[]
  voicedRatio: number
  minMidi: number
  maxMidi: number
}

const FRAME = 2048
const HOP_SEC = 0.0116 // ≈11.6ms 一帧

const midiOf = (f: number) => 69 + 12 * Math.log2(f / 440)

/** 帧级音高跟踪。逐段让出事件循环并回报进度,长录音不卡页面 */
export async function computePitchTrack(
  data: Float32Array,
  sr: number,
  onProgress?: (p: number) => void,
): Promise<PitchTrackResult> {
  const hop = Math.max(64, Math.round(sr * HOP_SEC))
  const n = Math.max(0, Math.floor((data.length - FRAME) / hop) + 1)
  const scratch = makeYinScratch(FRAME, sr, 70)
  const buf = new Float32Array(FRAME)
  const frames: PitchFrame[] = []
  for (let f = 0; f < n; f++) {
    const off = f * hop
    let energy = 0
    for (let i = 0; i < FRAME; i++) {
      const v = data[off + i] || 0
      buf[i] = v
      energy += v * v
    }
    const { freq, prob, rms } = yin(buf, sr, 0.12, 70, 1300, scratch)
    frames.push({ t: (off + FRAME / 2) / sr, freq, prob, rms })
    if (f % 300 === 299) {
      onProgress?.(f / n)
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  }
  onProgress?.(1)
  const voiced = frames.filter((f) => f.freq > 0 && f.prob > 0.6 && f.rms > 0.008)
  const voicedRatio = frames.length ? voiced.length / frames.length : 0
  const midis = voiced.map((f) => midiOf(f.freq))
  const segments = segmentPitchTrack(frames)
  return {
    frames,
    segments,
    voicedRatio,
    minMidi: midis.length ? Math.min(...midis) : 0,
    maxMidi: midis.length ? Math.max(...midis) : 0,
  }
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/** 稳定段分割:与段内中位数偏差 ≤ 0.8 半音视为同段(容忍揉弦),
 *  滑音/换音自动分段;≥ 0.12s 的段落生成音名标注 */
export function segmentPitchTrack(frames: PitchFrame[]): PitchSegment[] {
  const voiced = frames.filter((f) => f.freq > 0 && f.prob > 0.6 && f.rms > 0.008)
  const raw: { start: number; end: number; midis: number[]; probs: number[] }[] = []
  let cur: (typeof raw)[number] | null = null
  for (const f of voiced) {
    const m = midiOf(f.freq)
    if (!cur) {
      cur = { start: f.t, end: f.t, midis: [m], probs: [f.prob] }
    } else if (Math.abs(m - median(cur.midis)) <= 0.8) {
      cur.end = f.t
      cur.midis.push(m)
      cur.probs.push(f.prob)
    } else {
      raw.push(cur)
      cur = { start: f.t, end: f.t, midis: [m], probs: [f.prob] }
    }
  }
  if (cur) raw.push(cur)
  return raw
    .filter((s) => s.end - s.start >= 0.12)
    .map((s) => {
      const med = median(s.midis)
      const rounded = Math.round(med)
      const cents = s.midis.map((m) => (m - rounded) * 100)
      const cMean = cents.reduce((a, b) => a + b, 0) / cents.length
      const cStd = Math.sqrt(cents.reduce((a, b) => a + (b - cMean) ** 2, 0) / cents.length)
      return {
        start: s.start,
        end: s.end,
        midi: med,
        noteName: midiToName(rounded),
        cents: cMean,
        stability: cStd,
        conf: s.probs.reduce((a, b) => a + b, 0) / s.probs.length,
      }
    })
}
