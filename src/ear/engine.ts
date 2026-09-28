// 练耳题库引擎:按难度生成各题型
import { INTERVALS, SCALES, midiToFreq, midiToName } from '../theory/notes'
import { CHORD_TYPES } from '../theory/chords'
import { GuitarSynth } from '../audio/synth'
import { getCtx } from '../audio/engine'

export type EarKind = 'interval' | 'chord' | 'scale' | 'melody' | 'rhythm'

export const EAR_KINDS: { id: EarKind; name: string; icon: string }[] = [
  { id: 'interval', name: '音程', icon: '🎵' },
  { id: 'chord', name: '和弦', icon: '🎸' },
  { id: 'scale', name: '音阶', icon: '🎼' },
  { id: 'melody', name: '旋律', icon: '🎶' },
  { id: 'rhythm', name: '节奏', icon: '🥁' },
]

export interface Question {
  kind: EarKind
  level: number
  prompt: string
  choices: string[]
  answer: number // choices 下标;旋律/节奏题为 -1
  answerSeq?: number[] // 旋律:音级序列
  slots?: number // 节奏:总格数
  answerPattern?: boolean[] // 节奏:每格是否有音
  detail: string // 答案说明
  hint?: string // 正确答案的听感特征(复盘展示)
  replay: () => void
  replaySlow?: () => void
}

// ---- 听感特征提示(教学提示:该听什么) ----

export const INTERVAL_HINTS: Record<string, string> = {
  m2: '半音摩擦,紧贴不安——导音"贴"着主音的感觉',
  M2: '音阶相邻两级,平顺自然,没有紧张感',
  m3: '带小调色彩,下行时尤其忧郁',
  M3: '明亮开阔的大调色彩,像阳光;《两只老虎》里 2→3 就是它',
  P4: '号角般坚定稳定;《婚礼进行曲》"新娘来了"的开头上行',
  TT: '不安、诡异、悬在半空("魔鬼音程"),总想逃去别的音',
  P5: '空旷坚定,殿堂感;《小星星》1→5 的跳进',
  m6: '比五度更辽阔,但染着一层忧郁',
  M6: '宽广激昂,像推开一扇大窗',
  m7: '明显的未完成感,渴望解决到八度',
  M7: '几乎贴着八度却差半音,尖锐紧张',
  P8: '同一个音的高低两个身份,豁然开朗;《Over the Rainbow》"Some-where"',
}

export const CHORD_HINTS: Record<string, string> = {
  maj: '明亮、稳定、愉快——"正常"的大和弦',
  min: '柔和、内敛、忧伤,像大和弦蒙了层灰',
  '7': '不安分、想往前解决,带布鲁斯味',
  maj7: '梦幻悬浮的爵士感,像一杯雾',
  m7: '柔和中带点慵懒,常见于抒情/Neo-Soul',
  dim: '紧张收缩,恐怖片/悬疑配乐的常客',
  aug: '迷离、扩张、晕开的感觉',
  sus2: '空灵、未决,像少了点什么',
  sus4: '悬在半空想落回大三,教堂/民谣感',
  add9: '明亮开阔又带一层色彩,流行抒情常用',
  '6': '温暖复古,老式流行/爵士的甜味',
  m7b5: '暗淡紧张,爵士小调的阴天',
}

export const SCALE_HINTS: Record<string, string> = {
  major: '明亮完整,do-re-mi 的家乡',
  minor: '忧郁的传统小调,古典小曲的底色',
  harmonicMinor: '小调里藏一个"诡异"的大跨步(第6→7音)',
  majorPent: '去掉半音关系的五声,中国风/民谣感',
  minorPent: '摇滚与布鲁斯的万能音阶,干脆利落',
  blues: '五声里加了一个"哭腔"滑音感',
  dorian: '小调但第6音被提亮,忧郁中带一点向上',
  mixolydian: '大调但第7音被压低,摇滚/民谣的豪爽',
}

export const METHOD_HINTS: Record<EarKind, string> = {
  interval: '先判断两音是"贴着"(小音程)还是"跳远"(大音程),再哼出来对照',
  chord: '先问自己明不明显"开心"(大)还是"难过"(小),再听有没有第4个音带来的额外色彩',
  scale: '跟着哼:明 or 暗?有没有东方五声感?有没有突然的大跳或怪音?',
  melody: '先记住第一个音,跟着哼;数清一共几个音,注意相邻是级进还是跳进',
  rhythm: '先跟着打稳定拍,再注意哪些拍上有音、有没有落在半拍',
}

const rand = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(arr: T[]): T => arr[rand(arr.length)]
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---- 音程 ----

const INTERVAL_POOL: Record<number, string[]> = {
  1: ['P4', 'P5', 'P8'],
  2: ['P4', 'P5', 'P8', 'm3', 'M3'],
  3: ['m3', 'M3', 'm6', 'M6', 'm7'],
  4: ['m2', 'M2', 'm6', 'M6', 'm7', 'M7'],
  5: ['m2', 'M2', 'TT', 'm7', 'M7', 'm6', 'M6'],
}

function makeInterval(level: number): Question {
  const pool = (INTERVAL_POOL[level] ?? INTERVAL_POOL[5]).map(
    (s) => INTERVALS.find((i) => i.short === s)!,
  )
  const target = pick(pool)
  const base = 52 + rand(12) // E3–E4
  const low = base
  const high = base + target.semitones
  const melodic = level <= 2 ? true : Math.random() < 0.5
  const play = (slow: boolean) => () => {
    const ctx = getCtx()
    const t = ctx.currentTime + 0.05
    if (melodic) {
      GuitarSynth.pluckMidi(low, { when: t, gain: 0.45 })
      GuitarSynth.pluckMidi(high, { when: t + (slow ? 1.6 : 0.85), gain: 0.45 })
    } else {
      GuitarSynth.strumMidis([low, high], t, slow ? 0.05 : 0.015, { gain: 0.4 })
    }
  }
  const choices = shuffle(pool.map((i) => i.name))
  return {
    kind: 'interval',
    level,
    prompt: melodic ? '听两个音的音程(先后播放)' : '听两个音的音程(同时发声)',
    choices,
    answer: choices.indexOf(target.name),
    detail: `${midiToName(low)} → ${midiToName(high)} 是 ${target.name}(${target.short})`,
    hint: INTERVAL_HINTS[target.short],
    replay: play(false),
    replaySlow: play(true),
  }
}

// ---- 和弦 ----

const CHORD_POOL: Record<number, string[]> = {
  1: ['maj', 'min'],
  2: ['maj', 'min', 'dim', 'aug'],
  3: ['maj', 'min', '7', 'maj7', 'm7'],
  4: ['maj', 'min', '7', 'maj7', 'm7', 'sus4', 'sus2', '6'],
  5: ['7', 'maj7', 'm7', 'm7b5', 'add9', 'sus4', '6'],
}

function makeChord(level: number): Question {
  const pool = (CHORD_POOL[level] ?? CHORD_POOL[5]).map((id) => CHORD_TYPES.find((t) => t.id === id)!)
  const target = pick(pool)
  const root = 48 + rand(12) // C3–B3
  const midis = target.intervals.map((i) => root + i)
  const play = (slow: boolean) => () => {
    GuitarSynth.strumMidis(midis, getCtx().currentTime + 0.05, slow ? 0.06 : 0.02, { gain: 0.35 })
  }
  const choices = shuffle(pool.map((t) => t.name))
  return {
    kind: 'chord',
    level,
    prompt: '听和弦的性质(根音会变化,判断大小/类别)',
    choices,
    answer: choices.indexOf(target.name),
    detail: `这是 ${midiToName(root)}${target.suffix}(${target.name})`,
    hint: CHORD_HINTS[target.id],
    replay: play(false),
    replaySlow: play(true),
  }
}

// ---- 音阶 ----

const SCALE_POOL: Record<number, string[]> = {
  1: ['major', 'minor'],
  2: ['major', 'minor', 'majorPent', 'minorPent'],
  3: ['major', 'minor', 'blues', 'harmonicMinor'],
  4: ['major', 'minor', 'dorian', 'majorPent', 'blues'],
  5: ['dorian', 'mixolydian', 'harmonicMinor', 'minorPent', 'blues'],
}

function makeScale(level: number): Question {
  const pool = (SCALE_POOL[level] ?? SCALE_POOL[5]).map((id) => SCALES.find((s) => s.id === id)!)
  const target = pick(pool)
  const root = 55 + rand(7)
  const midis = [...target.intervals.map((i) => root + i), root + 12]
  const play = (slow: boolean) => () => {
    const ctx = getCtx()
    const t = ctx.currentTime + 0.05
    const gap = slow ? 0.75 : 0.42
    midis.forEach((m, i) => GuitarSynth.pluckMidi(m, { when: t + i * gap, gain: 0.4 }))
  }
  const choices = shuffle(pool.map((s) => s.name))
  return {
    kind: 'scale',
    level,
    prompt: '听一段上行音阶,判断是哪种',
    choices,
    answer: choices.indexOf(target.name),
    detail: `这是从 ${midiToName(root)} 开始的${target.name}`,
    hint: SCALE_HINTS[target.id],
    replay: play(false),
    replaySlow: play(true),
  }
}

// ---- 旋律听写 ----

const MELODY_LEN: Record<number, number> = { 1: 3, 2: 4, 3: 4, 4: 5, 5: 6 }

function makeMelody(level: number): Question {
  const len = MELODY_LEN[level] ?? 4
  // 大调音级 1-8(MIDI 60-72 内的 C 大调)
  const degrees = [60, 62, 64, 65, 67, 69, 71, 72]
  const seq: number[] = [rand(4)] // 从较低音级开始
  while (seq.length < len) {
    const last = seq[seq.length - 1]
    const step = pick([-2, -1, -1, 1, 1, 2, 3, -3])
    const nx = last + step
    if (nx >= 0 && nx < 8) seq.push(nx)
  }
  const midis = seq.map((d) => degrees[d])
  const play = (slow: boolean) => () => {
    const ctx = getCtx()
    const t = ctx.currentTime + 0.05
    const gap = slow ? 0.85 : 0.5
    midis.forEach((m, i) => GuitarSynth.pluckMidi(m, { when: t + i * gap, gain: 0.42 }))
  }
  return {
    kind: 'melody',
    level,
    prompt: `听 ${len} 个音的旋律,用音级(1-8)按顺序点出来`,
    choices: ['1', '2', '3', '4', '5', '6', '7', '8'],
    answer: -1,
    answerSeq: seq.map((d) => d + 1),
    detail: `正确答案:${seq.map((d) => d + 1).join(' ')}`,
    hint: METHOD_HINTS.melody,
    replay: play(false),
    replaySlow: play(true),
  }
}

// ---- 节奏 ----

const RHYTHM_SLOTS: Record<number, number> = { 1: 8, 2: 8, 3: 16, 4: 16, 5: 16 }

function makeRhythm(level: number): Question {
  const slots = RHYTHM_SLOTS[level] ?? 16
  const pattern = new Array(slots).fill(false)
  pattern[0] = true
  // L1/L2 只用偶数格(四分/八分骨架),高等级放开奇数格(十六分反拍)
  const allowedOdd = level > 2
  // 可用格数:slot0 + 其余中满足奇偶限制的格
  let usable = 1
  for (let i = 1; i < slots; i++) if (allowedOdd || i % 2 === 0) usable++
  const targetHits = Math.min(slots - 1, Math.round(slots / 2 + level - 1), usable)
  let hits = 1
  let guard = 0
  const guardMax = slots * 4
  while (hits < targetHits && guard++ < guardMax) {
    const i = 1 + Math.floor(Math.random() * (slots - 1))
    if (!pattern[i] && (allowedOdd || i % 2 === 0)) {
      pattern[i] = true
      hits++
    }
  }
  const slotDur = 0.28
  const play = (slow: boolean) => () => {
    const ctx = getCtx()
    const t = ctx.currentTime + 0.08
    const d = slow ? slotDur * 1.8 : slotDur
    pattern.forEach((hit, i) => {
      if (hit) GuitarSynth.click(t + i * d, i === 0, 0.55)
    })
  }
  return {
    kind: 'rhythm',
    level,
    prompt: `听节奏(共 ${slots / 8} 小节 8 分音符网格),点亮你听到的格子`,
    choices: [],
    answer: -1,
    slots,
    answerPattern: pattern,
    detail: `正确节奏:${pattern.map((h) => (h ? '●' : '○')).join(' ')}`,
    hint: METHOD_HINTS.rhythm,
    replay: play(false),
    replaySlow: play(true),
  }
}

export function makeQuestion(kind: EarKind, level: number): Question {
  switch (kind) {
    case 'interval':
      return makeInterval(level)
    case 'chord':
      return makeChord(level)
    case 'scale':
      return makeScale(level)
    case 'melody':
      return makeMelody(level)
    case 'rhythm':
      return makeRhythm(level)
  }
}
