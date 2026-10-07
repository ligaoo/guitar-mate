// 谱面量化(BP/DSP 识别的原始音符 → 六线谱格点)
//
// 这一层原来长在 TranscribePage 的 rebuild() 里,导致评测**无法度量用户最终看到的谱面**
// (EVAL 的 quantF1 用的是真值 BPM + 真值锚点,是乐观上界)。抽成纯函数后:
//   · 页面与评测走同一段代码(评测的 --pipeline=product 变体);
//   · 量化误差可以单独度量、单独回归。
//
// 网格约定:每拍 SUBDIV=12 格,同一整数网格同时表达直音(16 分=3 格、8 分=6 格)
// 与三连音(3 连 8 分=4 格、3 连 16 分=2 格)。
import { capPolyphony, filterToKey, type KeyGuess } from './cleanup'

export const SUBDIV = 12
/** 时值吸附候选(格数):16分 → 3连8分 → 8分 → 4分 → 2分 → 全音符 … */
export const SNAP_DURS = [2, 3, 4, 6, 8, 9, 12, 16, 18, 24, 32, 36, 48]
/** 时值循环切换顺序(UI 的「时值切换」按钮) */
export const DUR_CYCLE = [3, 4, 6, 12, 24, 48]

export interface RawInputNote {
  start: number
  end: number
  midi: number
  confidence: number
}

export interface QuantizedNote {
  midi: number
  step: number
  dur: number
  conf: number
}

export interface QuantizeResult {
  notes: QuantizedNote[]
  /** 锚点(秒):step = round((start − anchor)/gridSec) */
  anchor: number
  /** 每格时长(秒) */
  gridSec: number
  /** 整体平移量(格;把 earliest 归一化到 0 用,渲染层不支持负 step) */
  shift: number
  /** 自动密度实际生效的响度阈值 */
  effMinConf: number
  /** 自动密度说明(未生效为 null) */
  autoDensityInfo: string | null
  /** swing 检测说明(未检测到为 null) */
  swingInfo: string | null
  /** 调外音过滤删掉的音符数 */
  keyDropCount: number
}

/** 用音符起点序列细化 BPM:在估计值 ½–2 倍范围搜索,字典序目标——
 *  ① 最优 60% 残差(RANSAC 式抗离群:伪起音造成的错位音不参与)尽量小;
 *  ② 残差近最优(≤ 最优×1.5 + 0.02)的候选里取最接近初估者;③ 间隔 <2 格硬淘汰。
 *  纯残差评分会退化地偏向慢速或任意倍速(均匀节奏在多个 BPM 下都是整数格),先验做最终裁决。 */
export function refineBpm(starts: number[], bpm0: number): number {
  if (starts.length < 4) return bpm0
  const t0 = starts[0]
  const evalAt = (c: number) => {
    const g = 60 / c / SUBDIV
    const residuals: number[] = []
    const rounded: number[] = []
    for (const t of starts) {
      const r = (t - t0) / g
      residuals.push(Math.abs(r - Math.round(r)))
      rounded.push(Math.round(r))
    }
    residuals.sort((a, b) => a - b)
    const k = Math.max(3, Math.floor(residuals.length * 0.6))
    const robust = residuals.slice(0, k).reduce((a, b) => a + b, 0) / k
    rounded.sort((a, b) => a - b)
    let tooClose = 0
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] - rounded[i - 1] < 2) tooClose++
    }
    return { robust, tooClose }
  }
  // 第一轮:最小 robust(忽略 tooClose,只作基准)
  let minRobust = Infinity
  for (let c = Math.max(40, bpm0 * 0.45); c <= bpm0 * 2.1 + 1e-9; c += 0.25) {
    const { robust } = evalAt(c)
    if (robust < minRobust) minRobust = robust
  }
  // 第二轮:残差近最优 + 无 tooClose 的候选里,取最接近初估者
  let best = bpm0
  let bestPrior = Infinity
  for (let c = Math.max(40, bpm0 * 0.45); c <= bpm0 * 2.1 + 1e-9; c += 0.25) {
    const { robust, tooClose } = evalAt(c)
    if (tooClose > 0) continue
    if (robust > minRobust * 1.5 + 0.02) continue
    const prior = Math.abs(Math.log2(c / bpm0))
    if (prior < bestPrior) {
      bestPrior = prior
      best = c
    }
  }
  return Math.max(40, Math.min(220, Math.round(best)))
}

export interface QuantizeOptions {
  bpm: number
  /** 量化锚点(秒);不传则用第一个音符起点 */
  anchor?: number
  /** 用全部音符的相位峰细化锚点。**默认关**:实测有害(见 refineGridPhase 注释) */
  refineAnchor?: boolean
  /** 用户「整体左右移动」的格数(默认 0) */
  offsetSteps?: number
  /** 响度/置信度下限(默认 0) */
  minConf?: number
  /** 自动密度:音符总量超过「时长 × 3」时按响度升阈值,只保留最响的主声部。
   *  ACCURACY.md §3/D8:该行为会按设计删掉大批弱奏音,因此
   *   · 只对长素材(>90s)生效——短片段/单段扒谱绝不删音;
   *   · 阈值上限 0.6,强音(>0.6)永远不会因为"太密"被删。 */
  autoDensity?: boolean
  /** 调外音过滤的调性(不传则不过滤) */
  keyFilter?: KeyGuess | null
  /** 步进吸附:±1 格内把起点吸附到最近的直音(3 的倍数)或三连音(4 的倍数)。
   *  实测(ACCURACY.md §4.6):该规则会**摧毁合法的三连 16 分(第 2/10 格)与 32 分位置**,
   *  在真实 GuitarSet 上让"用户看到的谱面"掉约 19 个点 → 默认关闭。
   *  12 细分网格本身已经同时表达直音(3k)与三连音(4m),不需要再粗化。 */
  snapSteps?: boolean
  /** 复音上限(同一格最多保留几个音,默认 6 = 吉他弦数) */
  maxPolyphony?: number
}

/** 用全部音符估计网格相位:把锚点在 ±半格内微调到"音符最贴合网格线"的位置。
 *
 *  ⚠ **默认关闭,实测有害**(ACCURACY.md §4.6):在真实 GuitarSet 上,把锚点从
 *  "第一个检出音符"改成"相位直方图峰"后,产品谱面 F1 在完整改动下从 57.5% 掉到 48.1%
 *  (逐样例波动可达 −33 点)。原因:量化评分中标注与识别结果投到**同一个**锚点网格,
 *  全局相位在很大程度上会相互抵消;此时按"识别结果的相位分布"去优化锚点,只是把
 *  网格对到识别误差的分布上,反而偏离标注。保留此函数是为了后续做"绝对时间对齐"
 *  (A/B 对比、与原音频对拍)时可用,量化路径不要开。 */
export function refineGridPhase(starts: number[], gridSec: number, anchor: number, weights?: number[]): number {
  if (starts.length < 4 || !(gridSec > 0)) return anchor
  const BINS = 24
  const hist = new Float64Array(BINS)
  for (let i = 0; i < starts.length; i++) {
    const ph = (((starts[i] - anchor) % gridSec) + gridSec) % gridSec // [0, grid)
    const b = Math.min(BINS - 1, Math.floor((ph / gridSec) * BINS))
    hist[b] += weights ? Math.max(0.05, weights[i]) : 1
  }
  // 圆周平滑(相位是周期量,首尾相连)后取峰
  let best = 0
  let bestV = -1
  for (let i = 0; i < BINS; i++) {
    const v = hist[(i - 1 + BINS) % BINS] + 2 * hist[i] + hist[(i + 1) % BINS]
    if (v > bestV) {
      bestV = v
      best = i
    }
  }
  // 峰附近(±1 桶)加权均值细化,并把相位折到 [-半格, 半格)
  let sum = 0
  let w = 0
  for (let d = -1; d <= 1; d++) {
    const i = (best + d + BINS) % BINS
    let c = ((i + 0.5) / BINS) * gridSec
    if (c > gridSec / 2) c -= gridSec
    sum += c * hist[i]
    w += hist[i]
  }
  const phase = w > 0 ? sum / w : 0
  return anchor + phase
}

/** 量化主流程(纯函数,页面与评测共用) */
export function quantizeNotes(raw: RawInputNote[], duration: number, opts: QuantizeOptions): QuantizeResult {
  const bpm = Math.max(40, Math.min(220, opts.bpm || 90))
  const gridSec = 60 / bpm / SUBDIV
  const offsetSteps = opts.offsetSteps ?? 0
  const baseAnchor = opts.anchor ?? (raw.length ? Math.min(...raw.map((n) => n.start)) : 0)
  const minConf = opts.minConf ?? 0

  // ---- 自动密度(只在长素材上生效,且不删强音)----
  let effMinConf = minConf
  let autoDensityInfo: string | null = null
  if (opts.autoDensity && duration > 90 && raw.length > duration * 3) {
    const target = Math.max(60, Math.ceil(duration * 3))
    const sorted = raw.map((n) => n.confidence).sort((a, b) => b - a)
    const keep = Math.min(target, sorted.length)
    effMinConf = Math.max(minConf, Math.min(0.6, sorted[keep - 1]))
    autoDensityInfo = `自动密度:响度阈值 ${minConf.toFixed(2)} → ${effMinConf.toFixed(2)},保留 ${raw.filter((n) => n.confidence >= effMinConf).length}/${raw.length} 个最响的音符`
  }

  const filtered = raw.filter((n) => n.confidence >= effMinConf)
  // 锚点:默认直接用引擎给的首个起音(实测比"相位细化"更准,见 refineGridPhase);
  // 再叠加用户的手动整格偏移
  const anchor =
    (opts.refineAnchor === true
      ? refineGridPhase(
          filtered.map((n) => n.start),
          gridSec,
          baseAnchor,
          filtered.map((n) => n.confidence),
        )
      : baseAnchor) -
    offsetSteps * gridSec
  const q: QuantizedNote[] = []
  for (const n of filtered) {
    // 不 clamp 到 0:起音检测滞后时音符可以在锚点之前(往左对齐的物理基础)
    const step = Math.round((n.start - anchor) / gridSec)
    let dur = Math.round((n.end - n.start) / gridSec)
    dur = SNAP_DURS.reduce((best, d) => (Math.abs(d - dur) < Math.abs(best - dur) ? d : best), 3)
    dur = Math.max(2, dur)
    q.push({ midi: n.midi, step, dur, conf: n.confidence })
  }
  q.sort((a, b) => a.step - b.step)
  // 去掉完全同 step 同 midi 的重复
  const dedup = q.filter((n, i) => !(i > 0 && n.step === q[i - 1].step && n.midi === q[i - 1].midi))
  // 负步整体归一:最早音符落在 step 0(渲染层不支持负步)
  const shift = Math.min(0, ...dedup.map((n) => n.step))
  const shifted0 = shift < 0 ? dedup.map((n) => ({ ...n, step: n.step - shift })) : dedup
  // 步进吸附清理(默认关,见 snapSteps 的说明):±1 格内吸附到 3/4 的倍数网格
  const shifted =
    opts.snapSteps === true
      ? shifted0.map((n) => {
          const near3 = Math.round(n.step / 3) * 3
          const near4 = Math.round(n.step / 4) * 4
          const d3 = Math.abs(n.step - near3)
          const d4 = Math.abs(n.step - near4)
          let step = n.step
          if (d3 <= 1 && d3 < d4) step = near3
          else if (d4 <= 1 && d4 <= d3) step = near4
          return { ...n, step }
        })
      : shifted0
  // 吸附后可能撞出重复(同 step 同 midi),再去重
  const dedup2 = shifted.filter((n, i) => !(i > 0 && n.step === shifted[i - 1].step && n.midi === shifted[i - 1].midi))

  // ---- swing/shuffle 检测:拍内位置(模 12)集中于 7-9(三连音反拍)即有 swing 感 ----
  let swingInfo: string | null = null
  const modCounts = new Array(SUBDIV).fill(0)
  for (const n of dedup2) modCounts[((n.step % SUBDIV) + SUBDIV) % SUBDIV]++
  const totalN = dedup2.length
  const swung = modCounts[7] + modCounts[8] + modCounts[9]
  if (totalN >= 6 && swung / totalN >= 0.25) {
    const mode = [7, 8, 9].reduce((a, b) => (modCounts[b] > modCounts[a] ? b : a), 7)
    swingInfo =
      mode === 8
        ? '检测到 shuffle/swing 节奏(反拍落在三连音位置,≈67%)—— 12 细分网格已自动对齐三连音'
        : `检测到轻微 swing(反拍偏移至 ${Math.round((mode / 6) * 100)}%)`
  }

  // ---- 复音上限:同一格最多 6 个音(吉他弦数),密集簇保留最响的 ----
  let out: QuantizedNote[] = capPolyphony(dedup2, opts.maxPolyphony ?? 6)

  // ---- 调外音过滤(可选)----
  let keyDropCount = 0
  if (opts.keyFilter) {
    const before = out.length
    out = filterToKey(out, opts.keyFilter)
    keyDropCount = before - out.length
  }

  return { notes: out, anchor, gridSec, shift, effMinConf, autoDensityInfo, swingInfo, keyDropCount }
}
