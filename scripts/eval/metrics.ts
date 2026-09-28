// 扒谱评估:音符级 / Tab 级指标
//
// 主指标采用 MIREX 风格的音符匹配:onset 在 ±tol 内且音高完全相等才算命中。
// 另外给出两个"诊断用"指标,用于把误差归因到音高还是节奏:
//   pitchOnlyF1 — 只看音高(多重集交集),忽略时间对齐
//   onsetOnlyF1 — 只看时间,忽略音高
// 以及 octaveErrors —— 时间对上了但差 12/24 半音(贝斯谐波、八度重影的典型症状)。

import type { EvalNote } from './types'

export interface NoteScore {
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
  /** ref 侧:时间窗内有 est 音,但音高差 12/24 半音(且无精确命中)的数量 */
  octaveErrors: number
  pitchOnlyF1: number
  onsetOnlyF1: number
  /** ref 下标 → est 下标(仅精确命中) */
  matches: Map<number, number>
}

const prf = (tp: number, fp: number, fn: number) => {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { precision, recall, f1 }
}

interface Pair {
  i: number
  j: number
  d: number
}

/** 收集候选配对。est 按 start 排序后滑动窗口,避免 O(n·m) 全比。
 *  samePitch=true 时要求音高完全相等。 */
function collectPairs(ref: EvalNote[], est: EvalNote[], onsetTol: number, samePitch: boolean): Pair[] {
  const order = est.map((_, j) => j).sort((a, b) => est[a].start - est[b].start)
  const out: Pair[] = []
  for (let i = 0; i < ref.length; i++) {
    const rs = ref[i].start
    for (const j of order) {
      const ds = est[j].start - rs
      if (ds > onsetTol) break // 已按 start 升序,后面只会更晚
      if (-ds > onsetTol) continue
      if (samePitch && est[j].midi !== ref[i].midi) continue
      out.push({ i, j, d: Math.abs(ds) })
    }
  }
  return out
}

/** 贪心一对一分配:按 onset 距离升序取用,保证确定性 */
function assign(pairs: Pair[]): Pair[] {
  pairs.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j)
  const usedR = new Set<number>()
  const usedE = new Set<number>()
  const out: Pair[] = []
  for (const p of pairs) {
    if (usedR.has(p.i) || usedE.has(p.j)) continue
    usedR.add(p.i)
    usedE.add(p.j)
    out.push(p)
  }
  return out
}

/** 多重集交集:Σ_midi min(ref 中该音高的个数, est 中该音高的个数) */
function pitchOnlyTp(ref: EvalNote[], est: EvalNote[]): number {
  const c = new Map<number, number>()
  for (const n of est) c.set(n.midi, (c.get(n.midi) ?? 0) + 1)
  let tp = 0
  for (const n of ref) {
    const k = c.get(n.midi) ?? 0
    if (k > 0) {
      tp++
      c.set(n.midi, k - 1)
    }
  }
  return tp
}

/**
 * 音符级评分。
 * @param onsetTol 起音容差(秒),默认 50ms(MIREX 常用 50ms)
 */
export function scoreNotes(ref: EvalNote[], est: EvalNote[], onsetTol = 0.05): NoteScore {
  const exact = assign(collectPairs(ref, est, onsetTol, true))
  const matches = new Map<number, number>()
  for (const p of exact) matches.set(p.i, p.j)
  const tp = exact.length
  const fp = est.length - tp
  const fn = ref.length - tp

  // 八度误配:该 ref 音未精确命中,但时间窗内有差 12/24 半音的 est 音
  let octaveErrors = 0
  for (let i = 0; i < ref.length; i++) {
    if (matches.has(i)) continue
    for (const j of est.keys()) {
      const dt = Math.abs(est[j].start - ref[i].start)
      if (dt > onsetTol) continue
      const d = Math.abs(est[j].midi - ref[i].midi)
      if (d === 12 || d === 24) {
        octaveErrors++
        break
      }
    }
  }

  const pitchTp = pitchOnlyTp(ref, est)
  const pitchOnlyF1 = prf(pitchTp, est.length - pitchTp, ref.length - pitchTp).f1

  const onsetPairs = assign(collectPairs(ref, est, onsetTol, false))
  const onsetOnlyF1 = prf(onsetPairs.length, est.length - onsetPairs.length, ref.length - onsetPairs.length).f1

  return { tp, fp, fn, ...prf(tp, fp, fn), octaveErrors, pitchOnlyF1, onsetOnlyF1, matches }
}

export interface TabScore {
  /** 参与比对的数量:ref 里定义了弦/品且被精确命中的音 */
  matched: number
  exact: number
  stringOk: number
  fretOk: number
  exactRate: number
  stringRate: number
  fretRate: number
}

/**
 * Tab 级评分:在精确命中的音符上,比较推断出的(弦, 品)与标注。
 *
 * 注意:同一个音高在指板上有多个合法位置,指法推断选了"另一个同样可弹"的位置
 * 并不等于扒错。因此 exactRate 是偏严的指标,主要用于横向对比(改动前后 / 不同引擎),
 * 不作为绝对精度。真正的绝对精度看音符级 F1。
 */
export function scoreTab(ref: EvalNote[], est: EvalNote[], matches: Map<number, number>): TabScore {
  let matched = 0
  let exact = 0
  let stringOk = 0
  let fretOk = 0
  for (const [i, j] of matches) {
    const r = ref[i]
    const e = est[j]
    if (r.string === undefined || r.fret === undefined) continue
    if (e.string === undefined || e.fret === undefined) continue
    matched++
    if (e.string === r.string) stringOk++
    if (e.fret === r.fret) fretOk++
    if (e.string === r.string && e.fret === r.fret) exact++
  }
  const rate = (n: number) => (matched > 0 ? n / matched : 0)
  return { matched, exact, stringOk, fretOk, exactRate: rate(exact), stringRate: rate(stringOk), fretRate: rate(fretOk) }
}

/** 0-1 的小数 → 百分比字符串,便于打表 */
export const pct = (v: number) => `${(v * 100).toFixed(1)}%`
