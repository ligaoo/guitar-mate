// 闭环调度器:一次推理 → 逐段自评 → 不合格就改参数重扒 → 组装 + 段级报告
//
// 架构要点(为什么这样做):
//   ① **推理只做一次**:Basic Pitch 的推理占整条链路 95% 的时间(整曲 10~15 分钟),
//      而"改参数"只影响后处理(秒级)。所以把整曲的帧矩阵缓存下来,逐段切出来反复后处理 ——
//      同一段可以试十几种参数组合而不额外付推理成本。这是闭环能跑起来的关键。
//   ② **以小节为单位分段**:段内质量能代表一段音乐,边界落在拍点上(不会切碎和弦)。
//   ③ **无标注自评**:用 quality.ts 的复合代理分(已用真实 GuitarSet 标定),合格就过,
//      不合格按"问题归因 → 参数动作"重试,而不是无脑网格搜索。
//   ④ **量化与指法在整曲上做一次**:保证全曲网格与把位连续,不会出现段与段之间节奏错位。
import {
  evaluateChunked,
  ensureBackend,
  getModel,
  postProcessFrames,
  bpFrameTimeSec,
  bpTimeToFrame,
  type BpOptions,
} from '../basicPitch'
import { estimateOnsets, resampleLinear, toMono, SR, type RawNote } from '../pipeline'
import { estimateTuningFromPcm } from '../tuning'
import { detectKey, type KeyGuess } from '../cleanup'
import { quantizeNotes, type QuantizedNote } from '../quantize'
import { assignFingering, type DroppedNote, type TabNote } from '../fingering'
import { assessSegment, type QualityAction, type QualityAssessment, type Verdict } from './quality'
import { applyActions, baseParams, distortionIndex, DISTORTION_ROUTE, paramsKey, planSegments, type AutoParams, type SegmentPlan } from './plan'

/** 切片上下文:模型感受野 2 秒,左右各留 1.5 秒,避免段落边界处的音被削掉 */
const SLICE_CONTEXT_SEC = 1.5

export interface AutoStage {
  phase: 'infer' | 'global' | 'segments' | 'assemble' | 'done'
  done: number
  total: number
  detail?: string
}

export interface AutoOptions {
  /** 模型地址:命令行/Node 下必须显式传(由 ensureModelServer 解析),页面里可省略 */
  modelUrl?: string
  /** 每段最多尝试几种参数组合(含首次) */
  maxAttempts?: number
  /** 闭环重试的总时间预算(毫秒),超了就停止重试并把剩余段标记为待复核 */
  budgetMs?: number
  /** 分段:每段几小节 */
  barsPerSegment?: number
  /** 指法最高品 */
  maxFret?: number
  /** 是否先做分轨预处理(实测默认不该开,见 ACCURACY.md) */
  separate?: boolean
  /** 原混音上测得的失真指数。输入若是分轨产物必须传:分轨会改写削波/压缩指纹,
   *  在分轨后的信号上测会把失真曲误判成干净(实测《God knows》0.98 → 0.00) */
  distortion?: number
  onStage?: (s: AutoStage) => void
}

export interface SegmentAttempt {
  params: AutoParams
  key: string
  score: number
  verdict: Verdict
  notes: number
  issues: string[]
}

export interface SegmentReport {
  index: number
  t0: number
  t1: number
  attempts: SegmentAttempt[]
  best: { params: AutoParams; notes: RawNote[]; assessment: QualityAssessment }
  /** 是否在预算内完成了重试 */
  exhausted: boolean
}

export interface AutoResult {
  bpm: number
  bpmStrength: number
  tuningCents: number
  globalKey: KeyGuess | null
  /** 逐段结果(含每次尝试的分数 → 就是"审查-改参-重扒"的审计轨迹) */
  segments: SegmentReport[]
  /** 组装后的整曲谱面 */
  tab: TabNote[]
  dropped: DroppedNote[]
  quantized: QuantizedNote[]
  /** 逐段自评汇总 */
  summary: {
    pass: number
    review: number
    fail: number
    meanScore: number
    /** 按音符数加权的预计音符级 F1;**仅在标定可信时非 null**(见 quality.CALIB) */
    expectedF1: number | null
    /** 档位先验的加权平均(标定不可信时用这个给区间,而不是假装能预测) */
    regimeF1: number
    /** 素材失真指数(≥ DISTORTION_ROUTE 时自评/标定预测都只代表内部一致性,不代表真实准确率) */
    distortion: number
    notes: number
    /** 节奏落格差(疑似 BPM/第一拍不准)的段数:只标记、不自动重估(组装用全曲统一网格) */
    gridSuspectSegments: number
    /** 每段最多尝试次数(召回模式为 1:闭环动作改不动交付结果) */
    attemptsPerSegment: number
    totalAttempts: number
  }
}

interface Slice {
  frames: number[][]
  onsets: number[][]
  retimeOnsets: number[]
  /** 切片起点相对整曲的时间偏移(秒),用于把结果时间搬回绝对时间 */
  offset: number
  duration: number
}

/** 从整曲帧矩阵里切一段(时间以整曲为准),并把起音表也搬到切片时间轴上。
 *  帧↔时间换算一律用真实时基 bpTimeToFrame/bpFrameTimeSec(≈86.58fps,见 basicPitch.ts 注释)。 */
function sliceFrames(
  frames: number[][],
  onsets: number[][],
  allRetimeOnsets: number[],
  t0: number,
  t1: number,
): Slice {
  const a = Math.max(0, t0 - SLICE_CONTEXT_SEC)
  const b = t1 + SLICE_CONTEXT_SEC
  const f0 = Math.max(0, bpTimeToFrame(a))
  const f1 = Math.min(frames.length, bpTimeToFrame(b) + 1)
  const tStart = bpFrameTimeSec(f0)
  const retime = allRetimeOnsets.filter((t) => t >= a && t <= b).map((t) => t - tStart)
  return {
    frames: frames.slice(f0, f1),
    onsets: onsets.slice(f0, f1),
    retimeOnsets: retime,
    offset: tStart,
    duration: bpFrameTimeSec(f1) - tStart,
  }
}

const shiftNotes = (notes: RawNote[], off: number) => notes.map((n) => ({ ...n, start: n.start + off, end: n.end + off }))

/** 把一个音符列表量化成指定段的谱面(与整曲用同一个 BPM 与锚点,保证网格一致) */
function quantizeSegment(
  notes: RawNote[],
  duration: number,
  bpm: number,
  anchor: number,
  tuning: number[],
  maxFret: number,
  p: AutoParams,
) {
  const q = quantizeNotes(
    notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi, confidence: n.confidence })),
    duration,
    { bpm, anchor, minConf: p.minConf, autoDensity: false, maxPolyphony: p.maxPolyphony, keyFilter: null },
  )
  const { notes: tab, dropped } = assignFingering(q.notes, tuning, maxFret)
  return { tab, dropped, quant: q.notes }
}

export async function autoTranscribe(
  pcm22: Float32Array,
  tuning: number[],
  opts: AutoOptions = {},
): Promise<AutoResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const budgetMs = opts.budgetMs ?? 8 * 60 * 1000
  const maxFret = opts.maxFret ?? 15
  const stage = opts.onStage ?? (() => {})
  const duration = pcm22.length / SR
  const distortion = opts.distortion ?? distortionIndex(pcm22)

  // ---- 一次推理 ----
  stage({ phase: 'infer', done: 0, total: 1 })
  await ensureBackend(true)
  const bp = await getModel(opts.modelUrl)
  let lastPct = -1
  const { frames, onsets: onsetFrames } = await evaluateChunked(bp, pcm22, (p) => {
    const pct = Math.floor(p * 10) * 10
    if (pct !== lastPct) {
      lastPct = pct
      stage({ phase: 'infer', done: pct, total: 100, detail: `${pct}%` })
    }
  })
  const tuningCents = (() => {
    const t = estimateTuningFromPcm(pcm22, SR)
    return t ? Math.round(t.semis * 100) : 0
  })()
  const allOnsets = estimateOnsets(pcm22, SR)

  // ---- 全局探测:用便宜的后处理拿 BPM / 复音度 / 置信度(不跑 melodia,避免慢) ----
  stage({ phase: 'global', done: 0, total: 1 })
  const probeParams: AutoParams = {
    onsetThresh: 0.5,
    frameThresh: 0.3,
    minNoteLenFrames: 6,
    melodiaTrick: false,
    recallExtract: false,
    minConf: 0.2,
    maxPolyphony: 6,
    keyFilter: false,
  }
  const probe = await postProcessFrames(
    frames,
    onsetFrames,
    {
      onsetThresh: probeParams.onsetThresh,
      frameThresh: probeParams.frameThresh,
      minNoteLenFrames: probeParams.minNoteLenFrames,
      melodiaTrick: false,
      removeOctaveGhosts: true,
      retime: true,
      retimeOnsets: allOnsets,
      tuningCents,
      lowestMidi: tuning[0],
      highestMidi: tuning[tuning.length - 1] + 22,
    },
    duration,
  )
  const confs = probe.notes.map((n) => n.confidence).sort((a, b) => a - b)
  const confMedian = confs.length ? confs[confs.length >> 1] : 0
  const density = duration > 0 ? probe.notes.length / duration : 0
  const polyphonyMax = (() => {
    const m = new Map<number, number>()
    for (const n of probe.notes) {
      const k = Math.round(n.start * 16) / 16
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m.size ? Math.max(...m.values()) : 1
  })()
  const globalParams = baseParams({
    bpm: probe.bpm,
    polyphonic: polyphonyMax >= 2,
    confMedian,
    density,
    distortion,
  })
  const globalKey = detectKey(probe.notes)
  const anchor = probe.offset
  // 召回模式(失真档)下闭环改不动交付结果:聚合提取器不读 onset/frame 阈值与 melodia,
  // 而 minConf/复音上限/调性过滤只作用于段内自评(组装时按 minConf 0 重新量化,与标定口径一致)。
  // 旧实现每段照样试 3 次——《God knows》22 段 × 3 = 66 次尝试,交付音符与每段只试 1 次逐位相同。
  const attemptsPerSegment = globalParams.recallExtract ? 1 : maxAttempts

  // ---- 逐段自评循环 ----
  const plans = planSegments(duration, probe.bpm, opts.barsPerSegment ?? 8)
  stage({ phase: 'segments', done: 0, total: plans.length })
  const reports: SegmentReport[] = []
  const tStart = Date.now()
  let totalAttempts = 0
  let gridSuspect = 0

  for (const plan of plans) {
    const sl = sliceFrames(frames, onsetFrames, allOnsets, plan.t0, plan.t1)
    const attempts: SegmentAttempt[] = []
    let params = { ...globalParams }
    let best: SegmentReport['best'] | null = null
    let exhausted = false

    for (let k = 0; k < attemptsPerSegment; k++) {
      const r = await postProcessFrames(
        sl.frames,
        sl.onsets,
        {
          onsetThresh: params.onsetThresh,
          frameThresh: params.frameThresh,
          minNoteLenFrames: params.minNoteLenFrames,
          melodiaTrick: params.melodiaTrick,
          recallExtract: params.recallExtract,
          removeOctaveGhosts: params.recallExtract ? false : true, // 召回模式下八度过滤有害(实测 −2.4pt)
          retime: true,
          retimeOnsets: sl.retimeOnsets,
          tuningCents,
          lowestMidi: tuning[0],
          highestMidi: tuning[tuning.length - 1] + 22,
        } as BpOptions,
        sl.duration,
      )
      const notes = shiftNotes(r.notes, sl.offset).filter((n) => n.start >= plan.t0 - 0.05 && n.start < plan.t1)
      totalAttempts++
      const q = quantizeSegment(notes, plan.t1 - plan.t0, probe.bpm, anchor, tuning, maxFret, params)
      const assess = assessSegment({
        notes,
        tab: q.tab,
        dropped: q.dropped,
        onsets: allOnsets,
        bpm: probe.bpm,
        globalKey,
        duration: plan.t1 - plan.t0,
      })
      attempts.push({
        params,
        key: paramsKey(params),
        score: assess.score,
        verdict: assess.verdict,
        notes: notes.length,
        issues: assess.issues,
      })
      if (!best || assess.score > best.assessment.score) {
        best = { params: { ...params }, notes, assessment: assess }
      }
      if (assess.verdict === 'pass') break
      if (k === attemptsPerSegment - 1) break
      // 时间预算:超了就停止重试,把这一段标为"未充分重试"
      if (Date.now() - tStart > budgetMs) {
        exhausted = true
        break
      }
      params = applyActions(params, assess.actions)
    }
    if (best) {
      // 落格差的段只做标记、不自动重估:组装用全曲统一的 BPM 与锚点量化(网格必须全曲连续),
      // 段内单独改 BPM 改不到交付的谱面
      if (best.assessment.actions.includes('retry-bpm')) gridSuspect++
      reports.push({ index: plan.index, t0: plan.t0, t1: plan.t1, attempts, best, exhausted })
    }
    stage({ phase: 'segments', done: plan.index + 1, total: plans.length, detail: `段 ${plan.index + 1}/${plans.length}` })
  }

  // ---- 组装:整曲量化 + 指法一次(网格与把位全曲连续) ----
  stage({ phase: 'assemble', done: 0, total: 1 })
  const allNotes: RawNote[] = []
  for (const rep of reports) allNotes.push(...rep.best.notes)
  allNotes.sort((a, b) => a.start - b.start || a.midi - b.midi)
  // 段边界的重复音去重
  const merged: RawNote[] = []
  for (const n of allNotes) {
    const last = merged[merged.length - 1]
    if (last && last.midi === n.midi && Math.abs(last.start - n.start) < 0.03) {
      last.end = Math.max(last.end, n.end)
      continue
    }
    merged.push(n)
  }
  const finalQ = quantizeNotes(
    merged.map((n) => ({ start: n.start, end: n.end, midi: n.midi, confidence: n.confidence })),
    duration,
    { bpm: probe.bpm, anchor, minConf: 0, autoDensity: false, maxPolyphony: 6, keyFilter: null },
  )
  const { notes: tab, dropped } = assignFingering(finalQ.notes, tuning, maxFret)

  // ---- 汇总 ----
  const pass = reports.filter((r) => r.best.assessment.verdict === 'pass').length
  const review = reports.filter((r) => r.best.assessment.verdict === 'review').length
  const fail = reports.filter((r) => r.best.assessment.verdict === 'fail').length
  const totalNotes = reports.reduce((a, r) => a + r.best.notes.length, 0)
  const weighted = reports.reduce((a, r) => a + r.best.assessment.score * r.best.notes.length, 0)
  const meanScore = totalNotes > 0 ? weighted / totalNotes : 0
  const expected = reports.length
    ? reports.reduce((a, r) => a + (r.best.assessment.expectedF1 ?? r.best.assessment.regimeF1) * r.best.notes.length, 0) / Math.max(1, totalNotes)
    : 0
  const anyCalibrated = reports.some((r) => r.best.assessment.expectedF1 !== null)
  // 标定外推门控:回归式是在**干净 GuitarSet** 上拟合的,对高失真混音外推会严重虚高
  // (实测:失真整曲自评 0.69/预计 61%,对人工参考的真实一致度仅 2%)。
  // 失真素材拒报"预计准确率",只给档位区间 + 警示。
  const trustCalibration = distortion < DISTORTION_ROUTE
  stage({ phase: 'done', done: 1, total: 1 })

  return {
    bpm: probe.bpm,
    bpmStrength: probe.bpmStrength ?? 0,
    tuningCents,
    globalKey,
    segments: reports,
    tab,
    dropped,
    quantized: finalQ.notes,
    summary: {
      pass,
      review,
      fail,
      meanScore,
      expectedF1: anyCalibrated && trustCalibration ? expected : null,
      /** 档位先验的加权平均(标定不可信时用它给区间,而不是假装能预测) */
      regimeF1: expected,
      /** 素材失真指数(≥DISTORTION_ROUTE 时自评与标定预测都只代表内部一致性,不代表真实准确率) */
      distortion,
      notes: tab.length,
      gridSuspectSegments: gridSuspect,
      attemptsPerSegment,
      totalAttempts,
    },
  }
}
