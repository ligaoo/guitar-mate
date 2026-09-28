// 和弦引擎:和弦类型定义、指法(Voicing)生成、按指法反查和弦名
import { mod12 } from './notes'

export interface ChordType {
  id: string
  suffix: string
  name: string
  intervals: number[] // 相对根音的半音数
  group: 'basic' | 'color' | 'jazz'
}

export const CHORD_TYPES: ChordType[] = [
  { id: 'maj', suffix: '', name: '大三和弦', intervals: [0, 4, 7], group: 'basic' },
  { id: 'min', suffix: 'm', name: '小三和弦', intervals: [0, 3, 7], group: 'basic' },
  { id: '7', suffix: '7', name: '属七和弦', intervals: [0, 4, 7, 10], group: 'basic' },
  { id: 'maj7', suffix: 'maj7', name: '大七和弦', intervals: [0, 4, 7, 11], group: 'color' },
  { id: 'm7', suffix: 'm7', name: '小七和弦', intervals: [0, 3, 7, 10], group: 'color' },
  { id: 'dim', suffix: 'dim', name: '减三和弦', intervals: [0, 3, 6], group: 'color' },
  { id: 'aug', suffix: 'aug', name: '增三和弦', intervals: [0, 4, 8], group: 'color' },
  { id: 'sus2', suffix: 'sus2', name: '挂留二和弦', intervals: [0, 2, 7], group: 'color' },
  { id: 'sus4', suffix: 'sus4', name: '挂留四和弦', intervals: [0, 5, 7], group: 'color' },
  { id: 'add9', suffix: 'add9', name: '加九和弦', intervals: [0, 4, 7, 14], group: 'color' },
  { id: '6', suffix: '6', name: '大六和弦', intervals: [0, 4, 7, 9], group: 'color' },
  { id: 'm7b5', suffix: 'm7b5', name: '半减七和弦', intervals: [0, 3, 6, 10], group: 'jazz' },
]

export function chordTypeId(rootPc: number, typeId: string): string {
  return `${rootPc}|${typeId}`
}

/** 一个可按的指法 */
export interface Voicing {
  frets: number[] // 每根弦:-1 闷音 / 0 空弦 / >0 品位;索引 0 = 6 弦
  fingers: number[] // 每根弦的手指标号 0=无 1-4
  barre: { fret: number; from: number; to: number } | null
  baseFret: number // 显示窗口的起始品(最小按弦品,若全空弦则 1)
  score: number
}

interface GenOptions {
  maxFret?: number // 搜索的最高品
  limit?: number // 最多保留的指法数
}

const voicingCache = new Map<string, Voicing[]>()
const VOICING_CACHE_MAX = 600

// 标准调弦下的教科书开放把位指法(rootPc|typeId → frets),命中则置顶
const TEXTBOOK: Record<string, number[]> = {
  '0|maj': [-1, 3, 2, 0, 1, 0],
  '2|maj': [-1, -1, 0, 2, 3, 2],
  '4|maj': [0, 2, 2, 1, 0, 0],
  '7|maj': [3, 2, 0, 0, 0, 3],
  '9|maj': [-1, 0, 2, 2, 2, 0],
  '0|min': [-1, -1, -1, -1, -1, -1], // Cm 无常用开放指法,占位避免误匹配
  '2|min': [-1, -1, 0, 2, 3, 1],
  '4|min': [0, 2, 2, 0, 0, 0],
  '9|min': [-1, 0, 2, 2, 1, 0],
  '4|7': [0, 2, 0, 1, 0, 0],
  '9|7': [-1, 0, 2, 0, 2, 0],
  '2|7': [-1, -1, 0, 2, 1, 2],
  '7|7': [3, 2, 0, 0, 0, 1],
}

/**
 * 枚举某和弦在某调弦下的所有可按指法。
 * 约束:发声弦连续、音都属于和弦、须含根音、把位跨度 ≤ 4 品、手指 ≤ 4(允许食指横按)。
 */
export function generateVoicings(
  rootPc: number,
  intervals: number[],
  tuning: number[],
  opts: GenOptions = {},
): Voicing[] {
  const { maxFret = 12, limit = 16 } = opts
  const key = `${mod12(rootPc)}|${intervals.join(',')}|${tuning.join(',')}|${maxFret}`
  // 缓存未截断的全量结果,返回时再按 limit 截取(修复:缓存 key 漏 limit 导致后续请求被旧截断)
  let all = voicingCache.get(key)
  if (!all) {
    all = computeVoicings(rootPc, intervals, tuning, maxFret)
    if (voicingCache.size >= VOICING_CACHE_MAX) {
      const oldest = voicingCache.keys().next().value
      if (oldest !== undefined) voicingCache.delete(oldest)
    }
    voicingCache.set(key, all)
  }
  return all.slice(0, limit)
}

function computeVoicings(rootPc: number, intervals: number[], tuning: number[], maxFret: number): Voicing[] {
  const chordPcs = new Set(intervals.map((i) => mod12(rootPc + i)))
  const nStrings = tuning.length
  const minSounded = intervals.length >= 3 ? 4 : 3
  const results: Voicing[] = []
  const textbook =
    tuning.join(',') === '40,45,50,55,59,64' ? TEXTBOOK[`${mod12(rootPc)}|${typeIdOf(intervals)}`] : undefined

  // DFS:逐弦选品。state:已确定的品、发声弦起点/连续性、按弦品集合
  const frets: number[] = new Array(nStrings).fill(-1)
  let soundedFrom = -1
  let soundedTo = -1

  const dfs = (si: number) => {
    if (si === nStrings) {
      emit()
      return
    }
    for (let f = -1; f <= maxFret; f++) {
      if (f >= 0) {
        // 空弦与按弦音都必须属于和弦
        const pc = mod12(tuning[si] + f)
        if (!chordPcs.has(pc)) continue
        if (f > 0) {
          // 跨度约束(与已按品比较)
          const pressed = pressedFrets()
          if (pressed.length > 0) {
            const mn = Math.min(...pressed, f)
            const mx = Math.max(...pressed, f)
            if (mx - mn > 3) continue
          }
        }
      }
      frets[si] = f
      if (f === -1) {
        if (soundedFrom === -1) {
          dfs(si + 1)
        } else {
          // 已有发声弦,不允许中间闷音 → 剩余弦全部闷音,输出这个组合
          emitTail(si)
        }
        frets[si] = -1
      } else {
        if (soundedFrom === -1) {
          const oldFrom = soundedFrom
          const oldTo = soundedTo
          soundedFrom = si
          soundedTo = si
          dfs(si + 1)
          soundedFrom = oldFrom
          soundedTo = oldTo
        } else {
          const oldTo = soundedTo
          soundedTo = si
          dfs(si + 1)
          soundedTo = oldTo
        }
        frets[si] = -1
      }
    }
  }

  const pressedFrets = (): number[] => {
    const out: number[] = []
    for (let i = 0; i < nStrings; i++) if (frets[i] > 0) out.push(frets[i])
    return out
  }

  // 从 si 开始的剩余弦全部置为闷音后输出
  const emitTail = (si: number) => {
    const saved: number[] = []
    for (let i = si; i < nStrings; i++) {
      saved.push(frets[i])
      frets[i] = -1
    }
    emit()
    for (let i = si; i < nStrings; i++) frets[i] = saved[i - si]
  }

  const emit = () => {
    const soundedIdx: number[] = []
    for (let i = 0; i < nStrings; i++) if (frets[i] !== -1) soundedIdx.push(i)
    if (soundedIdx.length < minSounded) return
    // 连续性
    if (soundedIdx[soundedIdx.length - 1] - soundedIdx[0] !== soundedIdx.length - 1) return
    // 须含根音
    const pcs = new Set(soundedIdx.map((i) => mod12(tuning[i] + frets[i])))
    if (!pcs.has(mod12(rootPc))) return
    // 手指可行性
    const pressed = pressedFrets()
    let baseFret = 1
    if (pressed.length > 0) {
      baseFret = Math.min(...pressed)
      const groups = new Map<number, number[]>()
      for (let i = 0; i < nStrings; i++) {
        if (frets[i] > 0) {
          const g = groups.get(frets[i]) ?? []
          g.push(i)
          groups.set(frets[i], g)
        }
      }
      // 每个品位一组;最低品位若跨多弦可视为横按(1 根手指);其余品位每根弦一根手指
      let fingers = 0
      const sorted = [...groups.keys()].sort((a, b) => a - b)
      sorted.forEach((fr, gi) => {
        const stringsAt = groups.get(fr)!
        if (gi === 0 && stringsAt.length > 1) fingers += 1 // 横按
        else fingers += stringsAt.length
      })
      if (fingers > 4) return
    }
    // 手指标号
    const fingerArr = new Array(nStrings).fill(0)
    let barre: Voicing['barre'] = null
    if (pressed.length > 0) {
      const groups = new Map<number, number[]>()
      for (let i = 0; i < nStrings; i++) {
        if (frets[i] > 0) {
          const g = groups.get(frets[i]) ?? []
          g.push(i)
          groups.set(frets[i], g)
        }
      }
      const sorted = [...groups.keys()].sort((a, b) => a - b)
      sorted.forEach((fr, gi) => {
        const stringsAt = groups.get(fr)!
        const finger = gi + 1
        stringsAt.forEach((i) => (fingerArr[i] = finger))
        if (gi === 0 && stringsAt.length > 1) {
          barre = { fret: fr, from: Math.min(...stringsAt), to: Math.max(...stringsAt) }
        }
      })
    }
    // 评分:弦多 > 空弦多 > 把位低 > 根音在低音弦(非根音低音倒扣)> 教科书指法置顶
    const openCount = frets.filter((f) => f === 0).length
    const avgFret = pressed.length ? pressed.reduce((a, b) => a + b, 0) / pressed.length : 0
    const bassPc = mod12(tuning[soundedIdx[0]] + frets[soundedIdx[0]])
    const isTextbook = textbook !== undefined && textbook.join(',') === frets.join(',')
    const score =
      soundedIdx.length * 2.5 +
      openCount * 2.2 +
      (bassPc === mod12(rootPc) ? 3.5 : -1) -
      avgFret * 0.55 +
      (isTextbook ? 8 : 0)
    results.push({ frets: [...frets], fingers: fingerArr, barre, baseFret, score })
  }

  dfs(0)
  results.sort((a, b) => b.score - a.score)
  // 按显示形状去重:仅边缘闷音/空弦不同、或同形状换弦组的指法画出来几乎一样,只留评分最高的
  const seen = new Set<string>()
  const uniq: Voicing[] = []
  for (const v of results) {
    const sig = shapeSignature(v.frets)
    if (seen.has(sig)) continue
    seen.add(sig)
    uniq.push(v)
  }
  return uniq
}

/** 显示形状签名:发声弦的品位居点(相对最低发声品),去掉首尾空弦(边缘空弦在图上与闷音几乎无差) */
function shapeSignature(frets: number[]): string {
  const rel = frets.filter((f) => f >= 0)
  if (rel.length === 0) return ''
  const min = Math.min(...rel)
  const arr = rel.map((f) => f - min)
  while (arr.length && arr[0] === 0) arr.shift()
  while (arr.length && arr[arr.length - 1] === 0) arr.pop()
  return arr.join(',')
}

/** 由音程组反查类型 id(用于教科书指法表匹配) */
function typeIdOf(intervals: number[]): string {
  const sig = intervals.join(',')
  const t = CHORD_TYPES.find((t) => t.intervals.join(',') === sig)
  return t?.id ?? ''
}

// exact 判定所需的「特征音级」(音程数组下标):三和弦须含根音+三音,七和弦还须含七音,
// 挂留须含挂留音,加音和弦须含特征音——五音/可省音不参与判定
const REQUIRED_DEGREES: Record<string, number[]> = {
  maj: [0, 1],
  min: [0, 1],
  dim: [0, 1],
  aug: [0, 1],
  '7': [0, 1, 3],
  maj7: [0, 1, 3],
  m7: [0, 1, 3],
  m7b5: [0, 1, 3],
  sus2: [0, 1],
  sus4: [0, 1],
  '6': [0, 1, 3],
  add9: [0, 1, 3],
}

export interface ChordMatch {
  rootPc: number
  type: ChordType
  exact: boolean
}

/** 反查:给定指法(每弦品 -1..f)与调弦,推测和弦名 */
export function reverseLookup(frets: number[], tuning: number[]): ChordMatch[] {
  const pcs = new Set<number>()
  for (let i = 0; i < frets.length; i++) {
    if (frets[i] < 0) continue
    pcs.add(mod12(tuning[i] + frets[i]))
  }
  if (pcs.size < 2) return []
  const out: (ChordMatch & { score: number })[] = []
  for (let rootPc = 0; rootPc < 12; rootPc++) {
    for (const type of CHORD_TYPES) {
      const chordPcs = new Set(type.intervals.map((i) => mod12(rootPc + i)))
      // 我按的音必须都在该和弦内
      let superset = true
      pcs.forEach((p) => {
        if (!chordPcs.has(p)) superset = false
      })
      if (!superset) continue
      // 该和弦的特征音级必须按齐(缺三音/七音只能算近似)
      const required = REQUIRED_DEGREES[type.id] ?? [0, 1]
      let hasRequired = true
      for (const idx of required) {
        if (!pcs.has(mod12(rootPc + type.intervals[idx]))) {
          hasRequired = false
          break
        }
      }
      // 排序权重:exact > 含根音 > 特征音齐 > 音数多,保证同分时候顺序稳定
      const score =
        (pcs.has(mod12(rootPc)) ? 4 : 0) +
        (hasRequired ? 3 : 0) +
        pcs.size * 0.4 -
        type.intervals.length * 0.1
      out.push({ rootPc, type, exact: hasRequired, score })
    }
  }
  out.sort((a, b) => {
    const ea = a.exact ? 1 : 0
    const eb = b.exact ? 1 : 0
    if (ea !== eb) return eb - ea
    if (b.score !== a.score) return b.score - a.score
    return chordName(a.rootPc, a.type).localeCompare(chordName(b.rootPc, b.type))
  })
  return out.slice(0, 24)
}

export function chordName(rootPc: number, type: ChordType): string {
  const sharp = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][rootPc]
  const flat = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'][rootPc]
  const root = type.suffix === 'dim' || type.suffix === 'm' || type.suffix === 'm7' || type.suffix === 'm7b5' ? flat : sharp
  return root + type.suffix
}
