// 起音对时(BP 的时间基准修正)
//
// 背景(ACCURACY.md §2.3 实测):
//   · Basic Pitch 的音符起点来自 86fps 的帧索引 → 粒度 11.6ms,占 12 细分格宽(30~51ms)
//     的 22~38%;逐样例的有符号偏差散布 −0.2 ~ −10.2ms。
//   · 本项目的 DSP 起音检测器(频谱通量 + 抛物线插值)实测与标注的偏差中位数 ≤3.4ms。
//   · 用后者给前者的音符**起点**对时:真实 GuitarSet 独奏上量化谱面 F1 52.6% → 60.0%
//     (+7.4 点),音符级指标不变(不动音高、不动时值)。
//
// 做法刻意保守:只在 ±tolSec 内存在起音时才移动,且一个起音最多吸附一个音符
// (按距离贪心分配),避免把相邻音粘成一堆。"没有起音支撑"的音符保持原样。
export interface RetimeOptions {
  /** 吸附半径(秒),默认 40ms:小于 12 细分格宽的最小值(30ms)的一半略多 */
  tolSec?: number
  /** 是否允许两个音符吸附到同一个起音(默认否) */
  allowShared?: boolean
}

export interface RetimeResult<T> {
  notes: T[]
  /** 实际被移动的音符数(用于 UI 提示与回归断言) */
  moved: number
  /** 参与对时的起音数 */
  onsets: number
}

/**
 * 把音符起点吸附到最近的起音。
 * @param notes 需含 start(秒);其余字段原样保留(不复制对象以外的结构)
 * @param onsets 起音时间(秒,升序)
 */
export function retimeNotesToOnsets<T extends { start: number }>(
  notes: T[],
  onsets: number[],
  opts: RetimeOptions = {},
): RetimeResult<T> {
  const tol = opts.tolSec ?? 0.04
  if (notes.length === 0 || onsets.length === 0) return { notes, moved: 0, onsets: onsets.length }
  // 候选对(音符, 起音, 距离),按距离升序贪心分配
  const pairs: { ni: number; oi: number; d: number }[] = []
  for (let ni = 0; ni < notes.length; ni++) {
    const s = notes[ni].start
    for (let oi = 0; oi < onsets.length; oi++) {
      const d = Math.abs(onsets[oi] - s)
      if (d <= tol) pairs.push({ ni, oi, d })
      else if (onsets[oi] > s + tol) break // 起音升序,后面只会更远
    }
  }
  pairs.sort((a, b) => a.d - b.d || a.ni - b.ni || a.oi - b.oi)
  const usedNote = new Set<number>()
  const usedOnset = new Set<number>()
  const out = notes.map((n) => ({ ...n }))
  let moved = 0
  for (const p of pairs) {
    if (usedNote.has(p.ni)) continue
    if (!opts.allowShared && usedOnset.has(p.oi)) continue
    usedNote.add(p.ni)
    usedOnset.add(p.oi)
    if (out[p.ni].start !== onsets[p.oi]) {
      out[p.ni].start = onsets[p.oi]
      moved++
    }
  }
  return { notes: out, moved, onsets: onsets.length }
}

/**
 * 量化锚点:优先用起音表的第一个起音(它是检测器给出的亚帧精度时间),
 * 但仅当它与首个音符足够接近(默认 0.5s)时才采用 —— 否则说明第一个检出的起音
 * 属于前奏/噪声,与谱面无关,这时回退到首个音符起点。
 */
export function pickAnchor(notes: { start: number }[], onsets: number[], maxGapSec = 0.5): number {
  if (notes.length === 0) return onsets[0] ?? 0
  const first = notes.reduce((m, n) => Math.min(m, n.start), Infinity)
  if (onsets.length === 0) return first
  let best = onsets[0]
  for (const t of onsets) {
    if (Math.abs(t - first) < Math.abs(best - first)) best = t
  }
  return Math.abs(best - first) <= maxGapSec ? best : first
}
