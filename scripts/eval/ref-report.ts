// 「输出 vs 人工参考谱」的统一多指标报告(PLAN-90 阶段 1/3 共用)。
//
// 使用方:
//   · ref-compare.ts   —— 产品盲扒链路各参数组
//   · ext-song-score.ts —— 外部引擎(MT3/YourMT3/微调模型…)的整曲输出
// 两边必须走同一套口径(5 指标 + 随机基线 + 分数级),否则跨引擎对比没有意义。
import { scoreNotes, scoreTabCells, shiftNotes, type NoteScore, type TabCellScore } from './metrics'
import { assignFingering } from '../../src/transcription/fingering'
import { STANDARD_TUNING } from '../../src/theory/tunings'
import type { EvalNote } from './types'

export interface RefAlign {
  offset: number
  scale: number
  bpmScore: number
}

export interface EstNote {
  start: number
  dur: number
  midi: number
}

/** 分数级参考格:step = 12 细分格;string 翻转(Songsterr 0=最细 → 产品 0=最低) */
export interface RefCell {
  step: number
  string: number
  fret: number
}

export interface RefContext {
  lead: EvalNote[]
  rhythm: EvalNote[]
  union: EvalNote[]
  refTab: RefCell[]
  align: RefAlign
}

export interface RefEvent {
  t: number
  dur: number
  midi: number
  string: number
  fret: number
}

/** 参考事件文件(lead-events/rhythm-events)→ 音频时间轴 + 分数级参考格 */
export function loadRefContext(events: RefEvent[][], align: RefAlign): RefContext {
  const map = (evs: RefEvent[]) =>
    evs.map((e) => ({ start: align.offset + align.scale * e.t, dur: e.dur, midi: e.midi }))
  const lead = map(events[0] ?? [])
  const rhythm = map(events[1] ?? [])
  const union = [...lead, ...rhythm].sort((a, b) => a.start - b.start)
  const beatSec = 60 / align.bpmScore
  const refTab: RefCell[] = [...(events[0] ?? []), ...(events[1] ?? [])].map((e) => ({
    step: Math.round((align.scale * e.t / beatSec) * 12),
    string: 5 - e.string,
    fret: e.fret,
  }))
  return { lead, rhythm, union, refTab, align }
}

export interface EstRowScore {
  vsLead: NoteScore
  vsUnion: NoteScore
  /** 随机基线:同一输出整体平移 1.37s(与参考完全错开)后的指标 */
  baseline: { exactF1: number; onsetOnlyF1: number; chromaF1: number }
  /** 分数级(尺子 B):格×弦×品 / 小节×弦×品 */
  tabStep: TabCellScore
  tabMeasure: TabCellScore
}

const pct = (v: number) => (v * 100).toFixed(1)

/** 对一份输出(音频时间轴上的音符)打全套指标。 */
export function scoreEstRow(est: EstNote[], ctx: RefContext): EstRowScore {
  const vsLead = scoreNotes(ctx.lead, est)
  const vsUnion = scoreNotes(ctx.union, est)
  const base = scoreNotes(ctx.union, shiftNotes(est, 1.37))
  const beatSec = 60 / ctx.align.bpmScore
  const estCells = assignFingering(
    est.map((n) => ({
      step: Math.max(0, Math.round(((n.start - ctx.align.offset) / beatSec) * 12)),
      dur: Math.max(1, Math.round((n.dur / beatSec) * 12)),
      midi: n.midi,
      conf: 1,
    })),
    STANDARD_TUNING,
    22,
  ).notes
  return {
    vsLead,
    vsUnion,
    baseline: { exactF1: base.f1, onsetOnlyF1: base.onsetOnlyF1, chromaF1: base.chromaF1 },
    tabStep: scoreTabCells(ctx.refTab, estCells, 'step'),
    tabMeasure: scoreTabCells(ctx.refTab, estCells, 'measure'),
  }
}

/** 渲染为 markdown 表(与 ref-compare 同版式,跨引擎可直接拼表) */
export function renderRefReport(title: string, rows: Array<{ desc: string; notes: number } & EstRowScore>, ctxNote: string): string {
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 指标口径:onset ±50ms;匹配 = 最大基数二分匹配(MIREX 风格);${ctxNote}`)
  lines.push('- 随机基线 = 同一输出整体平移 1.37s 后的指标(与参考完全错开);任何指标接近基线即无判别力')
  lines.push('')
  lines.push('## 音符级(尺子 A)')
  lines.push('')
  lines.push('| 参数组 | 音数 | 并集 exact F1 | P / R | onsetOnly | onset+offset | 音级 | ±12/24 | 主音 exact F1 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(
      `| ${r.desc} | ${r.notes} | **${pct(r.vsUnion.f1)}** | ${pct(r.vsUnion.precision)} / ${pct(r.vsUnion.recall)} | ${pct(r.vsUnion.onsetOnlyF1)} | ${pct(r.vsUnion.onsetOffsetF1)} | ${pct(r.vsUnion.chromaF1)} | ${pct(r.vsUnion.octaveTolF1)} | ${pct(r.vsLead.f1)} |`,
    )
  }
  const b = rows[0]?.baseline
  if (b) lines.push(`| (随机基线,以第一行为例) | — | ${pct(b.exactF1)} | — | ${pct(b.onsetOnlyF1)} | — | ${pct(b.chromaF1)} | — | — |`)
  lines.push('')
  lines.push('## 分数级(尺子 B:量化到网格后「×弦×品」一致率)')
  lines.push('')
  lines.push('| 参数组 | 格级 F1 | 小节级 F1 | 参考格数 | 输出格数 |')
  lines.push('|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(`| ${r.desc} | ${pct(r.tabStep.f1)} | ${pct(r.tabMeasure.f1)} | ${r.tabStep.refCount} | ${r.tabStep.estCount} |`)
  }
  return lines.join('\n')
}
