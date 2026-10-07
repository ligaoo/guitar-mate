// 指法推断:把 MIDI 音符序列分配到 (弦, 品)
//
// 算法:先按"同时发声音簇"(同一 step 的音,即和弦/扫弦簇)分组,簇内做**联合**分配
// (弦必须互不相同——物理上同一根弦在同一时刻只能发一个音),簇间用上一簇的低音锚点
// 做换把/跨弦代价。最后再做一次跨簇的同弦区间重叠检查与修复。
//
// 为什么不用"逐音 DP":审计与实测都发现,逐音 DP 的同弦冲突只跟**相邻**音符比较,
// 三音以上的簇里第 1 个音与第 3 个音可以落在同一根弦上(实测 A2+D3+E3 → 弦 1 同时
// 按品 0 与品 7),而丢弃报告是空的——用户拿到的是物理上按不出来的谱。

export interface TabNote {
  id: number
  step: number // 16 分音符步数(0 起;实际为每拍 12 细分)
  dur: number // 时值(步数)
  midi: number
  string: number // 0=6弦(低音) … 5=1弦
  fret: number // -1 表示未分配
  /** 识别置信度 0-1(手工插入/旧曲库条目为 undefined)。UI 用它标出可疑音符 */
  conf?: number
}

export interface DroppedNote {
  midi: number
  step: number
  dur: number
  reason: 'range' | 'conflict' // 超出指板范围 / 同弦时间冲突无解
}

export interface FingeringResult {
  notes: TabNote[]
  dropped: DroppedNote[]
}

interface Note {
  midi: number
  step: number
  dur: number
  conf?: number
}

interface Pos {
  string: number
  fret: number
}

export function positionsForMidi(midi: number, tuning: number[], maxFret: number): Pos[] {
  const out: Pos[] = []
  for (let s = 0; s < tuning.length; s++) {
    const fret = midi - tuning[s]
    if (fret >= 0 && fret <= maxFret) out.push({ string: s, fret })
  }
  return out
}

const overlaps = (a: { step: number; dur: number }, b: { step: number; dur: number }) =>
  a.step < b.step + b.dur && b.step < a.step + a.dur

/** 位置代价:偏好低把位、偏好空弦 */
function positionCost(p: Pos): number {
  return p.fret === 0 ? 0.1 : p.fret * 0.2
}

/** 相邻两音的移动代价:换把距离 + 换弦 + 跨弦拉伸 */
function transitionCost(a: Pos, b: Pos): number {
  let c = 0
  if (a.fret > 0 && b.fret > 0) c += Math.abs(a.fret - b.fret) * 1.2 // 换把(把位中心移动)
  else if (a.fret > 0 || b.fret > 0) c += 0.15
  c += Math.abs(a.string - b.string) * 0.05
  // 跨弦拉伸:相隔 ≥3 根弦还要换品,手指够不着
  if (a.fret > 0 && b.fret > 0 && Math.abs(a.string - b.string) >= 3 && a.fret !== b.fret) c += 0.9
  return c
}

/** 一个簇内部的手型代价:按弦音的品位跨度太大要扣分(跨 4 品以上很难同时按住) */
function handCost(picks: Pos[]): number {
  const fretted = picks.filter((p) => p.fret > 0).map((p) => p.fret)
  if (fretted.length < 2) return 0
  const span = Math.max(...fretted) - Math.min(...fretted)
  return span > 4 ? (span - 4) * 0.6 : 0
}

/** 簇内联合求解:枚举所有"弦互不相同"的组合,取代价最小者。
 *  簇规模由 capPolyphony 限制在 6 音以内,枚举量 ≤ 6! ,可以暴力做。 */
function solveCluster(cands: Pos[][], prev: Pos | null): Pos[] | null {
  const n = cands.length
  if (n === 0) return []
  if (cands.some((c) => c.length === 0)) return null
  let best: Pos[] | null = null
  let bestCost = Infinity
  const picks: Pos[] = new Array(n)
  const usedStrings = new Set<number>()
  const dfs = (k: number, sum: number) => {
    if (best !== null && sum >= bestCost) return // 剪枝:位置代价已超过当前最优
    if (k === n) {
      // 低音锚点(最靠低音弦的音)承接上一簇的手指位置
      const anchor = picks.reduce((m, p) => (p.string < m.string ? p : m), picks[0])
      const total = sum + handCost(picks) + (prev ? transitionCost(prev, anchor) : 0)
      if (total < bestCost) {
        bestCost = total
        best = picks.slice()
      }
      return
    }
    for (const p of cands[k]) {
      if (usedStrings.has(p.string)) continue
      usedStrings.add(p.string)
      picks[k] = p
      dfs(k + 1, sum + positionCost(p))
      usedStrings.delete(p.string)
    }
  }
  dfs(0, 0)
  return best
}

export function assignFingering(notes: Note[], tuning: number[], maxFret = 15): FingeringResult {
  if (notes.length === 0) return { notes: [], dropped: [] }
  // 超出指板范围的音直接进丢弃报告
  const playable: Note[] = []
  const dropped: DroppedNote[] = []
  for (const n of notes) {
    if (positionsForMidi(n.midi, tuning, maxFret).length > 0) playable.push(n)
    else dropped.push({ midi: n.midi, step: n.step, dur: n.dur, reason: 'range' })
  }
  if (playable.length === 0) return { notes: [], dropped }
  playable.sort((a, b) => a.step - b.step || a.midi - b.midi)

  // ---- 按同时发声音簇分组(同一 step) ----
  const clusters: Note[][] = []
  for (const n of playable) {
    const last = clusters[clusters.length - 1]
    if (last && last[0].step === n.step) last.push(n)
    else clusters.push([n])
  }

  const assigned: { note: Note; pos: Pos }[] = []
  let prev: Pos | null = null
  for (const cl of clusters) {
    const cands = cl.map((n) => positionsForMidi(n.midi, tuning, maxFret))
    let picks: Pos[] | null = cl.length <= 8 ? solveCluster(cands, prev) : null
    if (!picks) {
      // 簇内无解(音数超过可用弦数等):按"候选越多越先安排"贪心,安排不下的进丢弃报告
      const order = cl.map((_, i) => i).sort((a, b) => cands[b].length - cands[a].length)
      const used = new Set<number>()
      picks = new Array<Pos>(cl.length)
      for (const i of order) {
        const pick = cands[i]
          .filter((p) => !used.has(p.string))
          .sort((a, b) => positionCost(a) - positionCost(b))[0]
        if (!pick) {
          dropped.push({ midi: cl[i].midi, step: cl[i].step, dur: cl[i].dur, reason: 'conflict' })
          picks[i] = { string: -1, fret: -1 }
        } else {
          used.add(pick.string)
          picks[i] = pick
        }
      }
    }
    let anchor: Pos | null = null
    for (let i = 0; i < cl.length; i++) {
      const p: Pos | undefined = picks[i]
      if (!p || p.string < 0) continue
      assigned.push({ note: cl[i], pos: p })
      // 低音锚点(最靠低音弦的音)承接给下一簇
      if (!anchor || p.string < anchor.string) anchor = p
    }
    if (anchor) prev = anchor
  }

  // ---- 跨簇同弦区间重叠修复:同弦且时间重叠 = 物理上按不出来 ----
  const kept: { note: Note; pos: Pos }[] = []
  for (const a of assigned) {
    const conflict = kept.find((k) => k.pos.string === a.pos.string && overlaps(k.note, a.note))
    if (!conflict) {
      kept.push(a)
      continue
    }
    // 换到另一根不冲突的弦
    const fixed = positionsForMidi(a.note.midi, tuning, maxFret)
      .filter((p) => !kept.some((k) => k.pos.string === p.string && overlaps(k.note, a.note)))
      .sort((x, y) => positionCost(x) - positionCost(y))[0]
    if (fixed) kept.push({ note: a.note, pos: fixed })
    else dropped.push({ midi: a.note.midi, step: a.note.step, dur: a.note.dur, reason: 'conflict' })
  }

  kept.sort((a, b) => a.note.step - b.note.step || a.note.midi - b.note.midi)
  return {
    notes: kept.map((k, i) => ({
      id: i,
      step: k.note.step,
      dur: k.note.dur,
      midi: k.note.midi,
      string: k.pos.string,
      fret: k.pos.fret,
      conf: k.note.conf,
    })),
    dropped,
  }
}
