// 扒谱评估:黄金样例集
//
// 每个 fixture 对应一类真实失效场景,而不是随机音符:
//   solo-guitar     单声部旋律(基线健全性检查,DSP 应该能做对)
//   guitar-drums    吉他 + 鼓            → 复现"宽带瞬态变成伪起音"
//   guitar-bass     吉他 + 低音贝斯      → 复现"贝斯谐波变成高八度幽灵音"
//   guitar-vocal    吉他 + 人声          → 复现"居中人声污染"
//   full-mix        双轨吉他 + 贝斯 + 人声 + 鼓 → "直接扔一首歌"
//   full-mix-sharp  full-mix 整体偏高 55 音分 → 复现"变速翻录/整体调音偏高"
//
// 所有样例的 ground truth 都是"理想位置"(无抖动),人性化抖动与扫弦展开
// 只在渲染期引入,不会污染标注。

import type { EvalClip, EvalNote, EvalTrack } from './types'
import { TUNINGS } from '../../src/theory/tunings'

const STD = TUNINGS[0].midi // [40,45,50,55,59,64]
const BPM = 100
const LEAD = 0.5
const TAIL = 0.8

interface TabStep {
  step: number // 每拍 12 格
  dur: number // 格
  string: number // 0 = 6 弦(最低)
  fret: number
  vel?: number
}
interface MidiStep {
  step: number
  dur: number
  midi: number
  vel?: number
}

const stepSec = (bpm: number) => 60 / bpm / 12

function tab(spec: TabStep[], bpm = BPM, leadIn = LEAD): EvalNote[] {
  const g = stepSec(bpm)
  return spec.map((s) => ({
    start: leadIn + s.step * g,
    dur: s.dur * g,
    midi: STD[s.string] + s.fret,
    string: s.string,
    fret: s.fret,
    velocity: s.vel ?? 0.8,
  }))
}

function midiNotes(spec: MidiStep[], bpm = BPM, leadIn = LEAD): EvalNote[] {
  const g = stepSec(bpm)
  return spec.map((s) => ({ start: leadIn + s.step * g, dur: s.dur * g, midi: s.midi, velocity: s.vel ?? 0.8 }))
}

/** 把一段 spec 重复 times 次,每次整体后移 span 格 */
const repeat = (spec: TabStep[], times: number, span: number): TabStep[] =>
  Array.from({ length: times }, (_, k) => spec.map((s) => ({ ...s, step: s.step + k * span }))).flat()

const repeatM = (spec: MidiStep[], times: number, span: number): MidiStep[] =>
  Array.from({ length: times }, (_, k) => spec.map((s) => ({ ...s, step: s.step + k * span }))).flat()

// ---- 8 小节和声进行 C G Am F ×2 ----
const PROG = ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F'] as const
type ChordName = (typeof PROG)[number]

/** 常用开放把位 (弦, 品) */
const CHORDS: Record<ChordName, [number, number][]> = {
  C: [
    [1, 3],
    [2, 2],
    [3, 0],
    [4, 1],
    [5, 0],
  ],
  G: [
    [0, 3],
    [1, 2],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 3],
  ],
  Am: [
    [1, 0],
    [2, 2],
    [3, 2],
    [4, 1],
    [5, 0],
  ],
  F: [
    [0, 1],
    [1, 3],
    [2, 3],
    [3, 2],
    [4, 1],
    [5, 1],
  ],
}

/** 贝斯基频全部 < 70Hz(65.4 / 49.0 / 55.0 / 43.7):正好落在 BP 默认 minHz 之下 */
const BASS_ROOT: Record<ChordName, number> = { C: 36, G: 31, Am: 33, F: 29 }
const BASS_FIFTH: Record<ChordName, number> = { C: 31, G: 38, Am: 40, F: 36 }

/** 人声旋律:落在吉他音区(C4-F4),且有较长持续音 */
const MELODY: Record<ChordName, [number, number]> = {
  C: [64, 67],
  G: [62, 67],
  Am: [60, 64],
  F: [60, 65],
}

/** 节奏吉他:每小节第 1、3 拍各扫一个完整和弦(各持续 2 拍) */
function rhythmGuitar(): EvalNote[] {
  const spec: TabStep[] = []
  PROG.forEach((name, b) => {
    for (const [s, f] of CHORDS[name]) {
      spec.push({ step: b * 48, dur: 24, string: s, fret: f })
      spec.push({ step: b * 48 + 24, dur: 24, string: s, fret: f })
    }
  })
  return tab(spec)
}

/** 单声部旋律乐句(2 小节),全部在同一根弦附近,便于 DSP 处理 */
const RIFF: TabStep[] = [
  { step: 0, dur: 6, string: 4, fret: 1 }, // C4
  { step: 6, dur: 6, string: 4, fret: 3 }, // D4
  { step: 12, dur: 6, string: 4, fret: 5 }, // E4
  { step: 18, dur: 6, string: 4, fret: 3 }, // D4
  { step: 24, dur: 6, string: 3, fret: 2 }, // A3
  { step: 30, dur: 6, string: 4, fret: 0 }, // B3
  { step: 36, dur: 12, string: 4, fret: 1 }, // C4
  { step: 48, dur: 6, string: 5, fret: 0 }, // E4
  { step: 54, dur: 6, string: 5, fret: 3 }, // G4
  { step: 60, dur: 6, string: 5, fret: 5 }, // A4
  { step: 66, dur: 6, string: 5, fret: 3 }, // G4
  { step: 72, dur: 6, string: 4, fret: 1 }, // C4
  { step: 78, dur: 6, string: 4, fret: 3 }, // D4
  { step: 84, dur: 12, string: 4, fret: 5 }, // E4
]

const vocalSpec: MidiStep[] = PROG.flatMap((name, b) => {
  const [m1, m2] = MELODY[name]
  return [
    { step: b * 48, dur: 24, midi: m1 },
    { step: b * 48 + 24, dur: 24, midi: m2 },
  ]
})

const bassSpec: MidiStep[] = PROG.flatMap((name, b) => [
  { step: b * 48, dur: 24, midi: BASS_ROOT[name] },
  { step: b * 48 + 24, dur: 24, midi: BASS_FIFTH[name] },
])

const drumSpec: MidiStep[] = PROG.flatMap((_, b) => {
  const out: MidiStep[] = [
    { step: b * 48, dur: 3, midi: 36, vel: 0.9 }, // 底鼓 1
    { step: b * 48 + 24, dur: 3, midi: 36, vel: 0.85 }, // 底鼓 3
    { step: b * 48 + 12, dur: 3, midi: 38, vel: 0.8 }, // 军鼓 2
    { step: b * 48 + 36, dur: 3, midi: 38, vel: 0.8 }, // 军鼓 4
  ]
  for (let e = 0; e < 8; e++) out.push({ step: b * 48 + e * 6, dur: 2, midi: 42, vel: e % 2 === 0 ? 0.5 : 0.35 })
  return out
})

// ---- 轨道工厂 ----

/** 单轨吉他。strum 只对和弦有意义:单声部旋律线给 strum 会凭空引入同弦间的时间差 */
const guitarLead = (notes: EvalNote[], strum = 0): EvalTrack => ({
  id: 'guitar',
  instrument: 'guitar',
  gain: 0.72,
  pan: -0.5,
  notes,
  humanize: 0.005,
  strum,
})

/** 双轨吉他:真实录音里两轨时间/音色都不同,这是"中侧分离"能work的物理基础 */
const guitarDouble = (notes: EvalNote[]): EvalTrack[] => [
  { id: 'guitar-L', instrument: 'guitar', gain: 0.6, pan: -0.75, notes, humanize: 0.012, strum: 0.005 },
  { id: 'guitar-R', instrument: 'guitar', gain: 0.6, pan: 0.75, notes, humanize: 0.012, strum: 0.005 },
]

const bassTrack = (): EvalTrack => ({
  id: 'bass',
  instrument: 'bass',
  gain: 0.7,
  pan: 0,
  notes: midiNotes(bassSpec),
  humanize: 0.008,
})

const vocalTrack = (): EvalTrack => ({
  id: 'vocal',
  instrument: 'vocal',
  gain: 0.6,
  pan: 0,
  notes: midiNotes(vocalSpec),
})

const drumTrack = (): EvalTrack => ({
  id: 'drums',
  instrument: 'drums',
  gain: 0.55,
  pan: 0,
  notes: midiNotes(drumSpec),
  humanize: 0.005,
})

function clip(id: string, desc: string, tracks: EvalTrack[], detuneCents = 0): EvalClip {
  return { id, desc, bpm: BPM, tuning: STD, tracks, leadIn: LEAD, tail: TAIL, detuneCents, a4: 440 }
}

const melodyNotes = tab(repeat(RIFF, 4, 96))
const chordNotes = rhythmGuitar()

export const FIXTURES: EvalClip[] = [
  clip('solo-guitar', '单声部旋律(无伴奏)', [guitarLead(melodyNotes)]),
  clip('guitar-drums', '吉他 + 鼓', [{ ...guitarLead(chordNotes, 0.004), pan: 0 }, drumTrack()]),
  clip('guitar-bass', '吉他 + 贝斯(贝斯基频 < 70Hz)', [
    { ...guitarLead(chordNotes, 0.004), pan: 0 },
    bassTrack(),
  ]),
  clip('guitar-vocal', '吉他 + 居中人声', [{ ...guitarLead(chordNotes, 0.004), pan: 0 }, vocalTrack()]),
  clip('full-mix', '双轨吉他 + 贝斯 + 人声 + 鼓(整首歌)', [
    ...guitarDouble(chordNotes),
    bassTrack(),
    vocalTrack(),
    drumTrack(),
  ]),
  clip('full-mix-sharp', 'full-mix 且整体偏高 55 音分(变速翻录)', [
    ...guitarDouble(chordNotes),
    bassTrack(),
    vocalTrack(),
    drumTrack(),
  ], 55),
]

/** 该 fixture 用于评分的吉他 ground truth(与渲染出的轨道一一对应) */
export function guitarTruth(c: EvalClip): EvalNote[] {
  const t = c.tracks.find((x) => x.id === 'guitar' || x.id === 'guitar-L')
  return t ? t.notes : []
}

export { tab, midiNotes, repeat, repeatM, PROG, CHORDS }
