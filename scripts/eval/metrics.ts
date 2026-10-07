// 扒谱评估:音符级 / Tab 级指标
//
// 主指标采用 MIREX 风格的音符匹配:onset 在 ±tol 内且音高完全相等才算命中。
// 匹配算法为**最大基数二分匹配**(Kuhn 增广路径,2026-10-07 替换旧的按距离贪心):
// 贪心不保证最大 TP,在 ±50ms 窗内挤着多个同音高候选的和弦密集处会系统性低估命中数。
//
// 多指标并存(PLAN-90 阶段 1:单一指标会误导归因):
//   exact F1      — onset ±tol + 音高全等(主口径)
//   onsetOnlyF1   — 只看时间,忽略音高
//   onsetOffsetF1 — COnPOnOff:onset+音高命中且音尾偏差达标
//   octaveTolF1   — 音高差 ±12/24 半音也算命中(八度误配的代价量化)
//   chromaF1      — 忽略八度(音级相同即命中)
//   pitchOnlyF1   — 只看音高多重集(诊断用)
//   strictF1      — ±25ms 严格容差(诊断起音精度)
// 每个指标都应与 shiftedBaseline(输出整体错开后的同一指标)并列读 —— 没有基线列的
// 百分比不可解读(实测:参考谱错开 1.37s 后「音频验证率」仍有 70%)。
//
// 另有分数级指标(尺子 B):scoreTabCells 按「网格步×弦×品」比对用户最终看到的谱面。

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
  /** 音高容差 ±12/24 半音的 onset 匹配 F1 */
  octaveTolF1: number
  /** 忽略八度(音级相同即命中)的 onset 匹配 F1 */
  chromaF1: number
  /** ±25ms 严格容差下的 F1:诊断起音精度(帧量化/检测延迟会在这里暴露) */
  strictF1: number
  /** COnPOnOff 风格:起音+音高命中且音尾(end)偏差 ≤ max(0.12s, 25% ref 时值) 的 F1 */
  onsetOffsetF1: number
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

/** 收集候选配对。est 与 ref 各自按 start 排序后双指针推进(O(n+m+边数)),
 *  调参网格里一次评分要跑几十次,不能接受 O(n·m) 全扫。 */
function collectPairs(
  ref: EvalNote[],
  est: EvalNote[],
  onsetTol: number,
  pitchOk: (rm: number, em: number) => boolean,
): Pair[] {
  const order = est.map((_, j) => j).sort((a, b) => est[a].start - est[b].start)
  const refOrder = ref.map((_, i) => i).sort((a, b) => ref[a].start - ref[b].start)
  const out: Pair[] = []
  let lo = 0
  for (const i of refOrder) {
    const rs = ref[i].start
    while (lo < order.length && est[order[lo]].start < rs - onsetTol) lo++
    for (let k = lo; k < order.length; k++) {
      const j = order[k]
      const ds = est[j].start - rs
      if (ds > onsetTol) break // 已按 start 升序,后面只会更晚
      if (!pitchOk(ref[i].midi, est[j].midi)) continue
      out.push({ i, j, d: Math.abs(ds) })
    }
  }
  return out
}

/**
 * 最大基数二分匹配(Kuhn 增广路径,迭代式)。
 *
 * 为什么不用贪心:贪心按 onset 距离升序取用,遇到「ref A 抢走 est a 后,ref B 只剩
 * est a 可配」的交叉情形会丢掉本可多算的 TP。MIREX 口径按最大匹配计,贪心结果
 * 是它的下界(实测在密集和弦素材上低 0~2pt)。确定性:邻接表按 (距离, est 下标)
 * 排序后进入增广,同样的输入永远得到同样的匹配。
 */
function maxMatch(pairs: Pair[]): Map<number, number> {
  let nEst = 0
  for (const p of pairs) if (p.j >= nEst) nEst = p.j + 1
  if (!pairs.length || nEst <= 0) return new Map()
  // 按 ref 分组,组内按 (距离, j) 排序 → 增广优先走最近的 est,保持确定性
  const adj = new Map<number, { j: number; d: number }[]>()
  for (const p of pairs) {
    const arr = adj.get(p.i) ?? []
    arr.push({ j: p.j, d: p.d })
    adj.set(p.i, arr)
  }
  for (const [, arr] of adj) arr.sort((a, b) => a.d - b.d || a.j - b.j)
  const matchOfEst = new Int32Array(nEst).fill(-1)
  const mark = new Int32Array(nEst).fill(-1)
  let ts = 0

  const refs = [...adj.keys()].sort((a, b) => a - b)
  for (const start of refs) {
    ts++
    // 迭代 DFS:stack 帧 = [ref, 下一候选边下标];path = 各父帧下探时占用的 est
    const stack: Array<[number, number]> = [[start, 0]]
    const path: number[] = []
    let done = false
    while (stack.length && !done) {
      const top = stack[stack.length - 1]
      const i = top[0]
      const edges = adj.get(i)!
      if (top[1] >= edges.length) {
        stack.pop()
        if (path.length > stack.length) path.length = stack.length // 回溯:释放本帧占用的 est
        continue
      }
      const j = edges[top[1]].j
      top[1]++
      if (mark[j] === ts) continue
      mark[j] = ts
      if (matchOfEst[j] === -1) {
        // 找到空闲 est:沿增广路径回写(rk←j,r_t←path[t])
        matchOfEst[j] = i
        for (let t = stack.length - 2; t >= 0; t--) {
          const rt = stack[t][0]
          matchOfEst[path[t]] = rt
        }
        done = true
      } else {
        path.push(j)
        stack.push([matchOfEst[j], 0])
      }
    }
  }
  const out = new Map<number, number>()
  for (let j = 0; j < nEst; j++) if (matchOfEst[j] >= 0) out.set(matchOfEst[j], j)
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

/** 输出整体平移 dt 秒(与参考完全错开)——同一指标在此值附近即无判别力 */
export function shiftNotes<T extends { start: number }>(notes: T[], dt: number): T[] {
  return notes.map((n) => ({ ...n, start: n.start + dt }))
}

/**
 * 音符级评分。
 * @param onsetTol 起音容差(秒),默认 50ms(MIREX 常用 50ms)
 */
export function scoreNotes(ref: EvalNote[], est: EvalNote[], onsetTol = 0.05): NoteScore {
  const exact = maxMatch(collectPairs(ref, est, onsetTol, (r, e) => r === e))
  const matches = exact
  const tp = matches.size
  const fp = est.length - tp
  const fn = ref.length - tp

  // ±25ms 严格档:同一个匹配算法,只收紧容差
  const strictTp = maxMatch(collectPairs(ref, est, 0.025, (r, e) => r === e)).size
  const strictF1 = prf(strictTp, est.length - strictTp, ref.length - strictTp).f1

  // COnPOnOff:在精确命中的配对上,再考核音尾(end)偏差
  let ooTp = 0
  for (const [i, j] of matches) {
    const tol = Math.max(0.12, ref[i].dur * 0.25)
    if (Math.abs(est[j].start + est[j].dur - (ref[i].start + ref[i].dur)) <= tol) ooTp++
  }
  const onsetOffsetF1 = prf(ooTp, est.length - ooTp, ref.length - ooTp).f1

  // 音级(忽略八度)与 ±12/24 容差档
  const chromaTp = maxMatch(collectPairs(ref, est, onsetTol, (r, e) => ((r - e) % 12 + 12) % 12 === 0)).size
  const chromaF1 = prf(chromaTp, est.length - chromaTp, ref.length - chromaTp).f1
  const octTolTp = maxMatch(collectPairs(ref, est, onsetTol, (r, e) => r === e || Math.abs(r - e) === 12 || Math.abs(r - e) === 24)).size
  const octaveTolF1 = prf(octTolTp, est.length - octTolTp, ref.length - octTolTp).f1

  // 八度误配(诊断):该 ref 音未精确命中,但时间窗内有差 12/24 半音的 est 音
  const octCand = collectPairs(ref, est, onsetTol, (r, e) => Math.abs(r - e) === 12 || Math.abs(r - e) === 24)
  const octRefSet = new Set(octCand.map((p) => p.i))
  let octaveErrors = 0
  for (const i of octRefSet) if (!matches.has(i)) octaveErrors++

  const pitchTp = pitchOnlyTp(ref, est)
  const pitchOnlyF1 = prf(pitchTp, est.length - pitchTp, ref.length - pitchTp).f1

  const onsetTp = maxMatch(collectPairs(ref, est, onsetTol, () => true)).size
  const onsetOnlyF1 = prf(onsetTp, est.length - onsetTp, ref.length - onsetTp).f1

  return {
    tp,
    fp,
    fn,
    ...prf(tp, fp, fn),
    octaveErrors,
    pitchOnlyF1,
    onsetOnlyF1,
    octaveTolF1,
    chromaF1,
    strictF1,
    onsetOffsetF1,
    matches,
  }
}

/** BPM 判定:±4% 内算对;恰为半速/倍速(八度错选)单独归类 */
export type BpmVerdict = 'ok' | 'octave' | 'wrong'

export function judgeBpm(est: number, truth: number, tol = 0.04): BpmVerdict {
  const near = (a: number, b: number) => Math.abs(a - b) <= b * tol
  if (near(est, truth)) return 'ok'
  if (near(est, truth * 2) || near(est, truth / 2)) return 'octave'
  return 'wrong'
}

export interface QuantScore {
  f1: number
  /** 参与比对的 ref 音符数 */
  refCount: number
  estCount: number
  tp: number
}

/**
 * 量化谱面准确率:把 ref 与 est 都量化到 BPM 网格(每拍 subdiv 格,与 fixtures
 * 的 12 细分约定一致)后,按「格序号 + 音高完全相等」比对。
 *
 * 这是用户最终在谱面上看到的东西:识别可能「对了音」,但 BPM/锚点错一格,
 * 谱面照样错位。锚点由 ref 首音取整到网格得到(fixtures 的 leadIn 本就网格对齐)。
 */
export function scoreQuantized(
  ref: EvalNote[],
  est: EvalNote[],
  bpm: number,
  subdivPerBeat = 12,
): QuantScore {
  const step = 60 / bpm / subdivPerBeat
  const anchor = ref.length ? Math.round(ref[0].start / step) * step : 0
  // +1e-9 吸收恰好落在格线上的浮点噪声(如 0.049999…96 应进位到 1)
  const gridOf = (t: number) => Math.round((t - anchor) / step + 1e-9)
  const key = (n: EvalNote) => `${gridOf(n.start)}:${n.midi}`
  const c = new Map<string, number>()
  for (const n of est) c.set(key(n), (c.get(key(n)) ?? 0) + 1)
  let tp = 0
  for (const n of ref) {
    const k = c.get(key(n)) ?? 0
    if (k > 0) {
      tp++
      c.set(key(n), k - 1)
    }
  }
  const precision = tp + (est.length - tp) > 0 ? tp / est.length : 0
  const recall = tp + (ref.length - tp) > 0 ? tp / ref.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { f1, refCount: ref.length, estCount: est.length, tp }
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

// ---------- 分数级指标(尺子 B:PLAN-90 阶段 1)----------
//
// 用户感知的准确率是「谱面上这一格、这根弦、这个品对不对」,不是 ±50ms 的起音。
// 把双方都量化到网格后按「格×弦×品」比对:对 ±50ms 抖动不敏感,且直接对应
// "改谱成本"。granularity='measure' 时按小节(48 格)聚合,给更粗的对照。

export interface TabCellNote {
  step: number
  string: number
  fret: number
}

export interface TabCellScore {
  f1: number
  precision: number
  recall: number
  tp: number
  refCount: number
  estCount: number
}

export function scoreTabCells(
  ref: TabCellNote[],
  est: TabCellNote[],
  granularity: 'step' | 'measure' = 'step',
  stepsPerMeasure = 48,
): TabCellScore {
  const cell = (n: TabCellNote) => {
    const g = granularity === 'measure' ? Math.floor(n.step / stepsPerMeasure) : n.step
    return `${g}:${n.string}:${n.fret}`
  }
  const rc = new Set(ref.map(cell))
  const ec = new Set(est.map(cell))
  let tp = 0
  for (const c of ec) if (rc.has(c)) tp++
  const precision = ec.size > 0 ? tp / ec.size : 0
  const recall = rc.size > 0 ? tp / rc.size : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { f1, precision, recall, tp, refCount: rc.size, estCount: ec.size }
}

// ---------- 产品链路口径(用户最终看到的六线谱)----------
//
// 上面的 scoreQuantized 用**真值 BPM + 真值锚点**,是识别能力的乐观上界。
// 用户实际看到的是:引擎估的 BPM(必要时 refineBpm 细化)→ 引擎的首个起音当锚点
// → 12 细分吸格 → 复音上限 → 指法分配。这里按产品语义打分:
//   · 把标注与识别结果都投到**同一个**产品锚点网格上,比「格序号 + 音高」;
//   · 命中者里再统计 (弦, 品) 是否与标注一致(指法准确率)。
export interface TabLike {
  step: number
  midi: number
  string: number
  fret: number
}

export interface ProductScore {
  tp: number
  precision: number
  recall: number
  f1: number
  refCount: number
  estCount: number
  /** 命中音里 (弦,品) 完全一致的比例(指法;同一音高有多个合法位置,偏严,只做横向对比) */
  tabExactRate: number
  stringRate: number
  fretRate: number
}

export function scoreProduct(
  ref: EvalNote[],
  est: TabLike[],
  bpm: number,
  anchor: number,
  subdivPerBeat = 12,
): ProductScore {
  const step = 60 / bpm / subdivPerBeat
  const stepOf = (t: number) => Math.round((t - anchor) / step + 1e-9)
  // 标注投到同一网格(和弦簇内弦/品用于指法比对)
  const refCells = new Map<string, { string?: number; fret?: number }[]>()
  for (const n of ref) {
    const k = `${stepOf(n.start)}:${n.midi}`
    const arr = refCells.get(k) ?? []
    arr.push({ string: n.string, fret: n.fret })
    refCells.set(k, arr)
  }
  const estByKey = new Map<string, TabLike[]>()
  for (const n of est) {
    const k = `${n.step}:${n.midi}`
    const arr = estByKey.get(k) ?? []
    arr.push(n)
    estByKey.set(k, arr)
  }
  let tp = 0
  let matchedTab = 0
  let stringOk = 0
  let fretOk = 0
  let tabCompared = 0
  for (const [k, refs] of refCells) {
    const cands = estByKey.get(k)
    if (!cands || cands.length === 0) continue
    const used = new Set<number>()
    for (const r of refs) {
      const idx = cands.findIndex((c, i) => !used.has(i))
      if (idx < 0) break
      used.add(idx)
      tp++
      const c = cands[idx]
      if (r.string !== undefined && r.fret !== undefined) {
        tabCompared++
        if (c.string === r.string) stringOk++
        if (c.fret === r.fret) fretOk++
        if (c.string === r.string && c.fret === r.fret) matchedTab++
      }
    }
  }
  const precision = est.length > 0 ? tp / est.length : 0
  const recall = ref.length > 0 ? tp / ref.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const rate = (n: number) => (tabCompared > 0 ? n / tabCompared : 0)
  return {
    tp,
    precision,
    recall,
    f1,
    refCount: ref.length,
    estCount: est.length,
    tabExactRate: rate(matchedTab),
    stringRate: rate(stringOk),
    fretRate: rate(fretOk),
  }
}
