// 段级质量评估(无人工标注)
//
// 闭环自动扒谱的核心难点:**没有标准答案时怎么判断这一段扒得好不好?**
// 这里用 7 个"可信度代理指标",它们的取值区间是我在真实 GuitarSet(有人工标注)上实测出来的,
// 并且用 scripts/eval/calibrate-quality.ts 把复合分标定到"真实音符级 F1",
// 所以系统报出的"预计准确率"不是拍脑袋,而是有回归依据的(标定系数见 CALIB 常量)。
//
// 指标与实测锚点(锚点 = 我在真实数据上量到的"差/好"两端):
//   onsetSupport  起音支撑率  差 0.20 / 好 0.75   干净独奏 ≈0.79,和弦伴奏 ≈0.45,密集混音 ≈0.29
//   gridFit       格内贴合    差 0.45 / 好 0.95   音符是否落在 BPM 网格上(BPM 错的直接体现)
//   inKey         调内音比例  差 0.75 / 好 0.98   低 = 大量差半音幻音
//   confMedian    置信度中位  差 0.30 / 好 0.65   低 = 模型整段没把握
//   lowConfShare  低置信占比  差 0.85 / 好 0.25   反向指标
//   feasibleRate  可弹性      差 0.85 / 好 1.00   指法阶段丢弃(超音域/同弦冲突)的比例
//   ghostRate     八度重影率  差 0.10 / 好 0.00   反向指标
import type { RawNote } from '../pipeline'
import { scoreBpmCandidate } from '../pipeline'
import { filterToKey, type KeyGuess } from '../cleanup'
import type { DroppedNote, TabNote } from '../fingering'

export interface SegmentMetrics {
  notes: number
  density: number
  onsetSupport: number
  gridFit: number
  inKey: number
  confMedian: number
  lowConfShare: number
  feasibleRate: number
  ghostRate: number
  polyphonyMax: number
}

export type Verdict = 'pass' | 'review' | 'fail'

export interface QualityAssessment {
  score: number
  /** 由复合分标定出的"预计音符级 F1";标定不可信时为 null(见 CALIB) */
  expectedF1: number | null
  /** 该段属于哪一档素材 */
  regime: Regime
  /** 该档的**实测平均**音符级 F1(区间先验,不是本段预测) */
  regimeF1: number
  verdict: Verdict
  metrics: SegmentMetrics
  /** 主要问题(按严重度排序,已转成中文说明) */
  issues: string[]
  /** 建议的参数动作,交给 plan.ts 执行 */
  actions: QualityAction[]
}

/** 可执行的调参动作(闭环里"审查不合格 → 改参数 → 重扒"的桥) */
export type QualityAction =
  | 'raise-onset-thresh'
  | 'raise-frame-thresh'
  | 'lower-min-note-len'
  | 'toggle-melodia-off'
  | 'toggle-melodia-on'
  | 'raise-min-conf'
  | 'lower-min-conf'
  | 'enable-key-filter'
  | 'lower-polyphony-cap'
  | 'retry-bpm'
  | 'mark-review'

const ramp = (v: number, bad: number, good: number) => {
  if (bad === good) return 0.5
  const t = (v - bad) / (good - bad)
  return Math.max(0, Math.min(1, t))
}

/** 复合质量分(0-1)。闭环里用它做**同一段的相对排序**(不同参数谁更好),
 *  以及"合格/待复核"的判定;它**不是**准确率的预测器(见 CALIB 的说明)。 */
export function qualityScore(m: SegmentMetrics): number {
  return (
    WEIGHTS.lowConfShare * (1 - ramp(m.lowConfShare, 0.25, 0.85)) +
    WEIGHTS.ghostRate * (1 - ramp(m.ghostRate, 0.0, 0.1)) +
    WEIGHTS.confMedian * ramp(m.confMedian, 0.3, 0.65) +
    WEIGHTS.onsetSupport * ramp(m.onsetSupport, 0.2, 0.75) +
    WEIGHTS.gridFit * ramp(m.gridFit, 0.45, 0.95) +
    WEIGHTS.inKey * ramp(m.inKey, 0.75, 0.98) +
    WEIGHTS.feasibleRate * ramp(m.feasibleRate, 0.85, 1.0)
  )
}

/**
 * 复合分 → 预计音符级 F1 的标定。
 *
 * **2026-10-06 扩样后标定成立,已启用;2026-10-07 参数寻优后重标定(v3)。**
 * 第一轮(2026-10-05)只有 16 个窗口且全来自同一演奏者,r=0.431 不可信,默认关闭。
 * 修复抽样分层 bug(60 片段覆盖全部 6 位演奏者)后扩到 **122 个窗口**,r=0.667;
 * 参数寻优(ot0.55/ft0.40/meloff)落地后重标定:**r=0.698,真实 F1 均值 74.3%**。
 * 单指标:confMedian(r=0.558)、ghostRate(−0.584)、lowConfShare(−0.548)、feasibleRate(0.523)为主信号;
 * onsetSupport 的负相关(旧 −0.222)消失归零 —— 印证那是"持续音段无起音"缺陷 + 小样本的伪相关;
 * gridFit / inKey 仍然无信号(权重已压到最低)。
 *
 * ⚠ 外推边界:回归数据全部是干净 GuitarSet 素材(solo/comp,无鼓贝人声),
 * 对 dense-mix 段落的预测是外推 —— conductor 已设**标定外推门控**(失真指数 ≥0.5 拒报,
 * 见 plan.DISTORTION_ROUTE 与 AUTO.md §7.5"自评 61% vs 真实 2%"案例)。
 *
 * 如实报数的门槛刻意设高:样本 <24 或相关性 <0.6 时 expectedF1From 直接返回 null。
 * 复现:npm run calibrate -- --clips=eval/real-clips-cal.json --out=eval/quality-calibration-v3.json
 */
export const CALIB = {
  a: -0.203,
  b: 1.119,
  samples: 122,
  r: 0.698,
  /** 是否允许用回归式报"预计准确率"(标定不可信时为 false) */
  enabled: true,
}

/** 修正后的权重:只保留实测有信号的指标,去掉无信号项(避免用噪声做决策)。
 *  onsetSupport 权重从 0.28 降到 0.08(相关性为负,只作为"是否有起音证据"的弱参考)。 */
const WEIGHTS = {
  lowConfShare: 0.34,
  ghostRate: 0.22,
  confMedian: 0.2,
  onsetSupport: 0.08,
  gridFit: 0.06,
  inKey: 0.06,
  feasibleRate: 0.04,
} as const

/** 档位:按实测代理指标把段落归到三类,给"该档实测平均准确率"(来自 eval/bp-real-v5.json 与 bp-report-v4.json) */
export type Regime = 'clean-solo' | 'chordal' | 'dense-mix'

/** 各档的**实测平均音符级 F1**(不是预测,是历史区间):
 *  clean-solo / chordal 取自真实 GuitarSet 8 片段(bp-real-v5.json:solo 均 81.0%、comp 均 64.2%);
 *  dense-mix 取自合成混音 7 样例(bp-report-v4.json:55.5%)。 */
export const REGIME_F1: Record<Regime, number> = { 'clean-solo': 0.81, chordal: 0.64, 'dense-mix': 0.55 }

export function classifyRegime(m: SegmentMetrics): Regime {
  if (m.lowConfShare > 0.6 || m.density > 6) return 'dense-mix'
  if (m.polyphonyMax >= 3 || m.lowConfShare > 0.4 || m.ghostRate > 0.03) return 'chordal'
  return 'clean-solo'
}

/** 用标定系数把质量分换成预计 F1;标定不可信时返回 null(宁可不报,不报假数) */
export function expectedF1From(score: number): number | null {
  if (!CALIB.enabled) return null
  if (CALIB.samples < 24 || CALIB.r < 0.6) return null
  return Math.max(0, Math.min(1, CALIB.a + CALIB.b * score))
}

export interface AssessInput {
  /** 该段的识别结果(带置信度) */
  notes: RawNote[]
  /** 该段量化+指法后的谱面 */
  tab: TabNote[]
  dropped: DroppedNote[]
  /** 该段的起音(DSP 检测,秒;绝对时间) */
  onsets: number[]
  bpm: number
  /** 全局检测到的调性(段内音符太少时不单独检测,避免不稳定) */
  globalKey: KeyGuess | null
  duration: number
}

export function segmentMetrics(inp: AssessInput): SegmentMetrics {
  const { notes, tab, dropped, onsets, bpm, duration } = inp
  if (notes.length === 0) {
    return {
      notes: 0, density: 0, onsetSupport: 0, gridFit: 0, inKey: 0,
      confMedian: 0, lowConfShare: 1, feasibleRate: 1, ghostRate: 0, polyphonyMax: 0,
    }
  }
  // 起音支撑率:起点 ±40ms 内有真实起音的比例。
  // ⚠ 关键修正:如果这一段本来就几乎没有起音(持续音/长和弦),这个比例**没有意义** ——
  // 旧写法会把它算成 0%,把"延音段"误判成"识别错误"。
  // (标定时 onsetSupport 与真实 F1 呈负相关 r=-0.22,很可能就是被这类段落带偏的。)
  const spanStart = Math.min(...notes.map((n) => n.start))
  const spanEnd = Math.max(...notes.map((n) => n.end))
  const onsetsInSpan = onsets.filter((t) => t >= spanStart - 0.1 && t <= spanEnd + 0.1).length
  let supported = 0
  for (const n of notes) {
    for (const t of onsets) {
      const d = Math.abs(t - n.start)
      if (d <= 0.04) {
        supported++
        break
      }
      if (t > n.start + 0.04) break
    }
  }
  const onsetSupport = onsetsInSpan < 3 ? 0.5 : supported / notes.length
  // 格内贴合:复用 BPM 打分里的 gridFit(与速度仲裁同一套标准)
  const gridFit = scoreBpmCandidate(notes.map((n) => ({ start: n.start, confidence: n.confidence })), bpm, 12).gridFit
  // 调内音
  const inKey = inp.globalKey && notes.length >= 8 ? filterToKey(notes, inp.globalKey).length / notes.length : 1
  // 置信度
  const confs = notes.map((n) => n.confidence).sort((a, b) => a - b)
  const confMedian = confs[confs.length >> 1]
  const lowConfShare = confs.filter((c) => c < 0.5).length / confs.length
  // 可弹性:指法阶段丢了多少
  const total = tab.length + dropped.length
  const feasibleRate = total > 0 ? tab.length / total : 1
  // 八度重影率
  let ghosts = 0
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start >= sorted[i].end) break
      const ov = Math.min(sorted[i].end, sorted[j].end) - Math.max(sorted[i].start, sorted[j].start)
      const shorter = Math.min(sorted[i].end - sorted[i].start, sorted[j].end - sorted[j].start)
      const d = Math.abs(sorted[i].midi - sorted[j].midi)
      if ((d === 12 || d === 24) && ov > shorter * 0.5) ghosts++
    }
  }
  // 复音度(同一起音最多几个音)
  const byOnset = new Map<number, number>()
  for (const n of notes) {
    const k = Math.round(n.start * 16) / 16
    byOnset.set(k, (byOnset.get(k) ?? 0) + 1)
  }
  const polyphonyMax = Math.max(...byOnset.values())
  return {
    notes: notes.length,
    density: duration > 0 ? notes.length / duration : 0,
    onsetSupport,
    gridFit,
    inKey,
    confMedian,
    lowConfShare,
    feasibleRate,
    ghostRate: ghosts / notes.length,
    polyphonyMax,
  }
}

/** 归因:按"对分数的加权亏损"排序,报告最拖后腿的项目。
 *
 *  ⚠ 这里必须用**加权亏损**(weight × (1−归一化值)),不能用原始偏差 ——
 *  否则会出现"分数 0.60 的段落却把权重只有 0.08 的起音支撑率列为主要问题"这种误导
 *  (第一版实测就出现了,原因是起音支撑率的偏差天然接近 1)。 */
export function diagnose(m: SegmentMetrics): { issues: string[]; actions: QualityAction[] } {
  const items: { deficit: number; text: string; acts: QualityAction[] }[] = [
    {
      deficit: WEIGHTS.lowConfShare * (1 - (1 - ramp(m.lowConfShare, 0.25, 0.85))),
      text: `低置信音符占比高(${(m.lowConfShare * 100).toFixed(0)}%):模型整段没把握`,
      acts: ['raise-min-conf', 'mark-review'],
    },
    {
      deficit: WEIGHTS.ghostRate * (1 - (1 - ramp(m.ghostRate, 0.0, 0.1))),
      text: `八度幻觉偏多(${(m.ghostRate * 100).toFixed(1)}%)`,
      acts: ['raise-frame-thresh'],
    },
    {
      deficit: WEIGHTS.confMedian * (1 - ramp(m.confMedian, 0.3, 0.65)),
      text: `置信度中位偏低(${m.confMedian.toFixed(2)}):模型对这段没把握`,
      acts: ['raise-min-conf', 'mark-review'],
    },
    {
      deficit: WEIGHTS.gridFit * (1 - ramp(m.gridFit, 0.45, 0.95)),
      text: `节奏落格差(贴合 ${(m.gridFit * 100).toFixed(0)}%):BPM 或锚点可能错`,
      acts: ['retry-bpm'],
    },
    {
      deficit: WEIGHTS.inKey * (1 - ramp(m.inKey, 0.75, 0.98)),
      text: `调外音偏多(调内 ${(m.inKey * 100).toFixed(0)}%):差半音伪音多`,
      acts: ['enable-key-filter', 'raise-onset-thresh'],
    },
    {
      deficit: WEIGHTS.onsetSupport * (1 - ramp(m.onsetSupport, 0.2, 0.75)),
      text: `起音支撑率低(${(m.onsetSupport * 100).toFixed(0)}%):识别的音在真实起音处找不到对应(弱信号,仅供参考)`,
      acts: ['toggle-melodia-off', 'raise-frame-thresh'],
    },
    {
      deficit: WEIGHTS.feasibleRate * (1 - ramp(m.feasibleRate, 0.85, 1.0)),
      text: `有 ${((1 - m.feasibleRate) * 100).toFixed(0)}% 的音排不上指板(超音域/同弦冲突)`,
      acts: ['lower-polyphony-cap'],
    },
  ]
  items.sort((a, b) => b.deficit - a.deficit)
  const issues: string[] = []
  const actions: QualityAction[] = []
  for (const it of items.slice(0, 3)) {
    if (it.deficit < 0.04) continue
    issues.push(`${it.text}(拖低分数约 ${(it.deficit * 100).toFixed(0)}%)`)
    actions.push(...it.acts)
  }
  return { issues, actions: [...new Set(actions)] }
}

/** 判定阈值:pass/review 的分界来自标定(见 calibrate-quality 的输出) */
export const GATES = { pass: 0.62, review: 0.45 }

export function assessSegment(inp: AssessInput): QualityAssessment {
  const metrics = segmentMetrics(inp)
  const score = qualityScore(metrics)
  const { issues, actions } = diagnose(metrics)
  const verdict: Verdict = score >= GATES.pass ? 'pass' : score >= GATES.review ? 'review' : 'fail'
  const regime = classifyRegime(metrics)
  return {
    score,
    expectedF1: expectedF1From(score),
    regime,
    regimeF1: REGIME_F1[regime],
    verdict,
    metrics,
    issues,
    actions: verdict === 'pass' ? [] : actions,
  }
}
