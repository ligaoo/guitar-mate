// 指法推断:动态规划把 MIDI 音符序列分配到 (弦, 品),代价最小化手部移动
// 返回值包含被丢弃音符的报告(超出指板范围等),由 UI 提示用户
export interface TabNote {
  id: number
  step: number // 16 分音符步数(0 起)
  dur: number // 时值(步数)
  midi: number
  string: number // 0=6弦(低音) … 5=1弦
  fret: number // -1 表示未分配
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

export function positionsForMidi(midi: number, tuning: number[], maxFret: number): { string: number; fret: number }[] {
  const out: { string: number; fret: number }[] = []
  for (let s = 0; s < tuning.length; s++) {
    const fret = midi - tuning[s]
    if (fret >= 0 && fret <= maxFret) out.push({ string: s, fret })
  }
  return out
}

export function assignFingering(
  notes: { midi: number; step: number; dur: number }[],
  tuning: number[],
  maxFret = 15,
): FingeringResult {
  if (notes.length === 0) return { notes: [], dropped: [] }
  // 超出指板范围的音直接进丢弃报告
  const playable: { midi: number; step: number; dur: number }[] = []
  const dropped: DroppedNote[] = []
  for (const n of notes) {
    if (positionsForMidi(n.midi, tuning, maxFret).length > 0) playable.push(n)
    else dropped.push({ midi: n.midi, step: n.step, dur: n.dur, reason: 'range' })
  }
  const POS = playable.map((n) => positionsForMidi(n.midi, tuning, maxFret))
  if (playable.length === 0) return { notes: [], dropped }
  const n = playable.length
  // cost[i][p]:到第 i 个音符取第 p 个位置的最小总代价
  const cost: number[][] = POS.map((ps) => new Array(ps.length).fill(Infinity))
  const from: number[][] = POS.map((ps) => new Array(ps.length).fill(-1))
  POS[0].forEach((p, pi) => {
    cost[0][pi] = positionCost(p)
  })
  for (let i = 1; i < n; i++) {
    for (let pi = 0; pi < POS[i].length; pi++) {
      const cur = POS[i][pi]
      for (let pj = 0; pj < POS[i - 1].length; pj++) {
        const prev = POS[i - 1][pj]
        // 同弦时间重叠:物理上不可能同弦同时发两个音,禁掉
        const overlap = playable[i].step < playable[i - 1].step + playable[i - 1].dur
        if (overlap && cur.string === prev.string) continue
        const c = cost[i - 1][pj] + transitionCost(prev, cur)
        if (c < cost[i][pi]) {
          cost[i][pi] = c
          from[i][pi] = pj
        }
      }
      cost[i][pi] += positionCost(cur)
    }
  }
  // 回溯
  let best = 0
  for (let p = 1; p < POS[n - 1].length; p++) if (cost[n - 1][p] < cost[n - 1][best]) best = p
  // 某音符所有位置都不可达(同弦冲突整链无解)时回退:允许冲突并标记
  if (!isFinite(cost[n - 1][best])) {
    return fallbackAssign(playable, tuning, maxFret, dropped)
  }
  const chosen: { string: number; fret: number }[] = new Array(n)
  for (let i = n - 1, p = best; i >= 0; i--) {
    chosen[i] = POS[i][p]
    p = from[i][p]
    if (p < 0 && i > 0) p = 0
  }
  return {
    notes: playable.map((note, i) => ({
      id: i,
      step: note.step,
      dur: note.dur,
      midi: note.midi,
      string: chosen[i].string,
      fret: chosen[i].fret,
    })),
    dropped,
  }
}

/** DP 整链无解时的兜底:贪心逐音选(允许同弦冲突),并把无法分配的音记入丢弃报告 */
function fallbackAssign(
  playable: { midi: number; step: number; dur: number }[],
  tuning: number[],
  maxFret: number,
  dropped: DroppedNote[],
): FingeringResult {
  const out: TabNote[] = []
  let last: { string: number; fret: number } | null = null
  for (const note of playable) {
    const cands = positionsForMidi(note.midi, tuning, maxFret)
    let bestPos: { string: number; fret: number } | null = null
    let bestCost = Infinity
    for (const c of cands) {
      const overlap = out.some((o) => o.string === c.string && note.step < o.step + o.dur && note.midi !== o.midi)
      const cCost = (overlap ? 100 : 0) + (last ? transitionCost(last, c) : 0) + positionCost(c)
      if (cCost < bestCost) {
        bestCost = cCost
        bestPos = c
      }
    }
    if (!bestPos || bestCost >= 100) {
      dropped.push({ midi: note.midi, step: note.step, dur: note.dur, reason: 'conflict' })
    } else {
      out.push({ id: out.length, step: note.step, dur: note.dur, midi: note.midi, string: bestPos.string, fret: bestPos.fret })
      last = bestPos
    }
  }
  return { notes: out, dropped }
}

function positionCost(p: { string: number; fret: number }): number {
  // 偏好低把位、偏好空弦
  return p.fret === 0 ? 0.1 : p.fret * 0.2
}

function transitionCost(a: { string: number; fret: number }, b: { string: number; fret: number }): number {
  let c = 0
  if (a.fret > 0 && b.fret > 0) c += Math.abs(a.fret - b.fret) * 1.2 // 换把(把位中心移动)
  else if (a.fret > 0 || b.fret > 0) c += 0.15
  c += Math.abs(a.string - b.string) * 0.05
  // 跨弦拉伸:相隔 ≥3 根弦还要换品,手指够不着
  if (a.fret > 0 && b.fret > 0 && Math.abs(a.string - b.string) >= 3 && a.fret !== b.fret) c += 0.9
  return c
}
