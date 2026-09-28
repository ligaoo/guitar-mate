// 乐理基础:音名 / MIDI / 频率 换算
export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

export const mod12 = (n: number) => ((n % 12) + 12) % 12

export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
export const freqToMidiFloat = (f: number) => 69 + 12 * Math.log2(f / 440)

export function midiToPitchClass(m: number): number {
  return mod12(m)
}

export function midiToName(m: number, flat = false): string {
  const names = flat ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP
  return `${names[mod12(m)]}${Math.floor(m / 12) - 1}`
}

export function midiToNoteName(m: number): string {
  return NOTE_NAMES_SHARP[mod12(m)]
}

/** "C4" / "F#3" / "Bb2" → MIDI;非法返回 null */
export function nameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim())
  if (!m) return null
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()]
  if (base === undefined) return null
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  const oct = parseInt(m[3], 10)
  return base + acc + (oct + 1) * 12
}

export const centsBetween = (f1: number, f2: number) => 1200 * Math.log2(f2 / f1)

/** 音阶/调式定义(半音级数) */
export interface ScaleDef {
  id: string
  name: string
  intervals: number[]
}

export const SCALES: ScaleDef[] = [
  { id: 'major', name: '自然大调', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: '自然小调', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonicMinor', name: '和声小调', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'majorPent', name: '大调五声', intervals: [0, 2, 4, 7, 9] },
  { id: 'minorPent', name: '小调五声', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', name: '布鲁斯', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'dorian', name: '多利亚 (Dorian)', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixolydian', name: '混合利底亚 (Mixolydian)', intervals: [0, 2, 4, 5, 7, 9, 10] },
]

export interface IntervalDef {
  semitones: number
  name: string
  short: string
}

export const INTERVALS: IntervalDef[] = [
  { semitones: 1, name: '小二度', short: 'm2' },
  { semitones: 2, name: '大二度', short: 'M2' },
  { semitones: 3, name: '小三度', short: 'm3' },
  { semitones: 4, name: '大三度', short: 'M3' },
  { semitones: 5, name: '纯四度', short: 'P4' },
  { semitones: 6, name: '三全音', short: 'TT' },
  { semitones: 7, name: '纯五度', short: 'P5' },
  { semitones: 8, name: '小六度', short: 'm6' },
  { semitones: 9, name: '大六度', short: 'M6' },
  { semitones: 10, name: '小七度', short: 'm7' },
  { semitones: 11, name: '大七度', short: 'M7' },
  { semitones: 12, name: '纯八度', short: 'P8' },
]
