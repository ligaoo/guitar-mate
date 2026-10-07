// Basic Pitch(Spotify 开源)复音识别引擎封装
// 四级执行策略,保证任何环境都能出结果且尽量不冻结页面:
//   ① 常驻 Worker 全管线(正常桌面:Worker-WebGL,最佳)
//   ② Worker-GL 挂死时:主线程 WebGL 分块推理(预检 + latch + 活动看门狗;
//      嵌入式浏览器如 ZCode 内嵌 WebView 的 Worker GL 回读挂死,但主线程 GL 正常)
//   ③ 多 Worker 并行 CPU(主线程 GL 也不可用时)
//   ④ 单 Worker CPU 兜底(慢,但一定有结果)
// 长音频按 60s 分块推理,避免一次性构建数百 MB 的帧张量
import { toMono, resampleLinear, estimateBpm, estimateBpmFromEnvelope, estimateOnsets, arbitrateBpm, SR, type TranscribeResult, type RawNote } from './pipeline'
import { estimateTuningFromPcm, shiftFramesPitch } from './tuning'
import { snapClustersToChords, fitsChord } from './cleanup'
import { retimeNotesToOnsets, pickAnchor } from './timing'

// 模型路径按运行上下文解析:页面里相对页面(支持子路径部署);
// Worker 里相对 worker 脚本(位于 assets/ 下,回退一级);
// Node(离线评估脚本)下无 document/self,退化为相对路径,由调用方传入 modelUrl
const MODEL_URL = (() => {
  const rel = 'vendor/basic-pitch/model.json'
  if (typeof document !== 'undefined') return new URL(rel, document.baseURI).href
  if (typeof self !== 'undefined' && self.location) return new URL('../' + rel, self.location.href).href
  return rel
})()

type BpModule = typeof import('@spotify/basic-pitch')

export interface BpOptions {
  onsetThresh?: number // 起音阈值,越低越灵敏(默认见 BP_PRESETS;真实录音 0.5 明显优于旧的 0.35)
  frameThresh?: number // 延音阈值(默认见 BP_PRESETS)
  minNoteLenFrames?: number // 最短音符(帧,86fps;默认见 BP_PRESETS)
  /** melodia 残差补音:在 onset 驱动之外再从剩余能量里补音符。
   *  实测(真实 GuitarSet):独奏录音上关掉更好(去伪音),混音上开更好(补同时发声)→ 按场景分流 */
  melodiaTrick?: boolean
  /** 召回优先提取(PLAN-90 阶段 2,失真混音用):不再用包内 outputToNotesPoly 的
   *  单帧双阈值,改为「帧激活分段(带 droop 容忍)+ onset 联合 + 持续门限」的聚合提取。
   *  依据:同一帧矩阵上阈值 oracle 能到 26% 而单阈值只有 ~15%(瓶颈是召回,见
   *  PLAN-90 §1.3);true = 用默认参数,也可显式传参。 */
  recallExtract?: boolean | RecallExtractParams
  /** 起音对时:用 DSP 起音检测(实测偏差 ≤3.4ms)修正 BP 的帧量化起点(默认开)。
   *  需要调用方通过 `retimeOnsets` 传入起音表;不传则自动在推理前用同一份音频算一次 */
  retime?: boolean
  /** 预计算的起音表(秒):由 transcribeWithBasicPitchChannels 自动填充,或调用方传入 */
  retimeOnsets?: number[]
  removeOctaveGhosts?: boolean // 去除同时段的八度重影(默认开;和弦含真八度时应关闭。
  // **召回提取模式下默认关**:该过滤器在干净独奏上标定,会把失真吉他和弦里的真实
  // 八度叠音当幻觉删掉——实测《God knows》并集 F1 20.6%(关)vs 18.2%(开),见 PLAN-90 阶段 2)
  /** 八度重影过滤的例外:弱八度音若处在"和弦形态的 ≥3 音同时发声簇"里,判为真实八度加倍而保留。
   *  默认开(ACCURACY.md §4.2);实测口径见 test-bp-post.ts 与 EVAL.md 复核表 */
  octaveChordKeep?: boolean
  mergeSplits?: boolean // 合并同一音高、首尾相接的被拆音符(默认开)
  forceCpu?: boolean // 跳过 WebGL 直接用 CPU(看门狗回退 / 并行模式)
  modelUrl?: string // 模型地址:由主线程按页面地址解析后传给 worker(dev 与构建环境统一)
  minHz?: number // 音域下限(默认 70Hz ≈ Drop D 的 D2):整曲混识别时切掉贝斯/底鼓
  lowestMidi?: number // MIDI 音域下限(默认 36):按调弦传入可保住 Drop D/DADGAD 的低音 D2=38
  highestMidi?: number // MIDI 音域上限(默认 90):按调弦+最高品传入
  maxHz?: number // 音域上限(默认 1350Hz ≈ 22 品高音弦):切掉镲片泛音等超声垃圾
  autoTune?: boolean // 全曲音准校准(默认开):估计整体音分偏移并在帧域移位校正,±50 音分内消除系统性半音错音
  tuningCents?: number // 实测的整体音分偏移(YIN 物理测量,由 transcribeWithBasicPitchChannels 自动填充或调用方传入);不传则不做帧移位
  bpmHint?: number // 分离鼓轨上估计的 BPM:自身包络锁定不住(strength<0.1)时采用
  bassNotes?: { start: number; end: number; midi: number }[] // 分离贝斯轨的单音线:bassGhostPrune 开启时用于修剪贝斯谐波幽灵
  bassGhostPrune?: boolean // 贝斯谐波幽灵修剪(默认关:合成样例上净收益 ≈ 0,真实数据评测后再默认开)
  chordSnap?: boolean // 和弦词典 snap(默认开):同时发音簇向可行和弦音级吸附,单音最多修 1 半音
}

/** 识别预设:把"独奏"与"混音"两组实测最优参数固化下来,UI 一键切换。
 *  数据来源 ACCURACY.md §2.1 / §8(真实 GuitarSet 独奏 + 合成混音复核):
 *   · 阈值 0.35/0.2 → 0.5/0.3:两个数据集上都是正收益(独奏 +6.6 点、混音 +6.6 点音符级 F1)
 *   · 独奏关掉 melodia 补音:真实独奏 +1.4 点且精确率 89.8 → 92.0
 *   · 最短音长:独奏 6 帧(24% 的标注音短于默认的 12 帧),混音按和弦切分缩短
 *  2026-10-07 v2(60 片段扩界寻优 + holdout 留出集,eval/param-sweep-v2.json):
 *   · **ft 0.40 → 0.60**:两档最大单项收益,且 holdout 确认(solo 85.0→85.7 / comp 65.8→71.1);
 *     物理直觉:真实吉他录音的帧激活远高于幻觉,抬帧阈值主要删伪音。
 *     注意 0.60 仍落在网格边界(0.3→0.6 单调上升),再往上未搜。
 *   · comp 档最短音长 ×0.3(快和弦敲击)与 ot0.50;solo 档 ot0.55(平台区,0.5/0.55/0.6 差 <0.3pt)。
 *   · melodia 真实数据全面无益(第 3 次确认),保持关。 */
export const BP_PRESETS = {
  /** 干净独奏 / 单吉他录音 */
  solo: { onsetThresh: 0.55, frameThresh: 0.6, minNoteLenFrames: 6, melodiaTrick: false, recallExtract: false },
  /** 通用混音(整曲导入,无削波指纹) */
  mix: { onsetThresh: 0.5, frameThresh: 0.6, minNoteLenFrames: 4, melodiaTrick: false, recallExtract: false },
  /** 失真混音·召回优先(PLAN-90 阶段 2):瓶颈是召回不是精度,阈值收紧只会把真音
   *  连同幻觉一起删掉(实测保守档 5.9% vs 召回优先 14.8%+);聚合提取把帧矩阵里
   *  被单阈值丢掉的证据捞回来,产物定位「草稿中的草稿」,靠置信度着色 + 人工修。 */
  dist: { onsetThresh: 0.35, frameThresh: 0.3, minNoteLenFrames: 6, melodiaTrick: false, recallExtract: true },
} as const satisfies Record<string, Required<Pick<BpOptions, 'onsetThresh' | 'frameThresh' | 'minNoteLenFrames' | 'melodiaTrick' | 'recallExtract'>>>

export type BpPresetId = keyof typeof BP_PRESETS

/** 召回优先聚合提取的参数(2026-10-07 在《God knows》帧缓存上网格寻优,取平台区
 *  而非单点最优:frameGate 0.22/0.25/0.28 三档 F1 相差 <0.5pt,孤本样本上的尖峰无意义)。
 *  实测(并集 6911 参考音,onset ±50ms + 音高全等,最大二分匹配):全链路 F1 20.6%、
 *  输出 4072 音(vs 单帧双阈值最优 15.4%、阈值 oracle 26%)——满足 PLAN-90 阶段 2
 *  出口判据(F1 ≥20%、≥3000 音)。消融:强制八度过滤 −2.4pt(失真吉他和弦内真八度
 *  叠音被误删)→ 召回模式下该过滤默认关。 */
export interface RecallExtractParams {
  /** 段落门限:帧激活 ≥ 此值开始记段(段内跌破后仍有 droopFrames 的容忍) */
  frameGate: number
  /** onset 联合门限:段首附近的 onset 峰值 ≥ 此值 → 接受该音(起音证据) */
  onsetGate: number
  /** 持续门限:无 onset 支撑时,段内峰值激活需 ≥ 此值才接受(延音证据) */
  sustainGate: number
  /** 段内激活跌破段落门限的容忍帧数(melodia 式 droop,把被掩蔽的持续音接回来) */
  droopFrames: number
}

export const RECALL_EXTRACT_DEFAULTS: RecallExtractParams = {
  frameGate: 0.22,
  onsetGate: 0.25,
  sustainGate: 0.35,
  droopFrames: 3,
}

/**
 * 召回优先聚合提取:帧+onset 矩阵 → 音符(不经包内 outputToNotesPoly)。
 *
 * 与单帧双阈值(onsetThresh/frameThresh 各卡一道)的区别:
 *   ① 分段用**低门限 + droop 容忍**——失真混音里真实音的帧激活常被掩蔽得忽高忽低,
 *      单阈值会把它拆碎或整段丢掉;
 *   ② 接受判据是**聚合证据**:段首 onset 峰值(起音)或段内持续峰值(延音)二选一达标,
 *      而不是每一帧各自过线;
 *   ③ conf 是聚合分(0.55×onset 峰 + 0.45×段均值),下游的置信过滤/八度清理仍可用。
 * 时值先验由调用方的 minNoteLenFrames 承担(BPM 推导,见 plan.baseParams)。
 */
export function extractNotesAggressive(
  frames: number[][],
  onsets: number[][],
  params: RecallExtractParams,
  opts: { minNoteLenFrames?: number; lowestMidi?: number; highestMidi?: number } = {},
): RawNote[] {
  const nFrames = frames.length
  if (!nFrames) return []
  const nBins = frames[0]?.length ?? 88
  const p = { ...RECALL_EXTRACT_DEFAULTS, ...params }
  const mnl = Math.max(1, opts.minNoteLenFrames ?? 4)
  const lo = Math.max(0, (opts.lowestMidi ?? 36) - 21)
  const hi = Math.min(nBins - 1, (opts.highestMidi ?? 90) - 21)
  const out: RawNote[] = []
  const droorFloor = p.frameGate * 0.5
  for (let b = lo; b <= hi; b++) {
    let f = 0
    while (f < nFrames) {
      if (frames[f][b] < p.frameGate) {
        f++
        continue
      }
      // ---- 一段的开始:带 droop 容忍地向后扩展 ----
      let end = f
      let gap = 0
      let peak = frames[f][b]
      let sum = 0
      let cnt = 0
      let g = f
      while (g < nFrames) {
        const v = frames[g][b]
        if (v >= p.frameGate) {
          end = g
          gap = 0
          if (v > peak) peak = v
          sum += v
          cnt++
        } else if (v >= droorFloor && gap < p.droopFrames) {
          gap++
        } else {
          break
        }
        g++
      }
      const len = end - f + 1
      // 段首 onset 峰值(起音头常先于帧激活 1~3 帧,前后都搜)
      let onsetPeak = 0
      let onsetAt = f
      for (let k = Math.max(0, f - 3); k <= Math.min(nFrames - 1, f + 4); k++) {
        const ov = onsets[k]?.[b] ?? 0
        if (ov > onsetPeak) {
          onsetPeak = ov
          onsetAt = k
        }
      }
      const accept = onsetPeak >= p.onsetGate || (peak >= p.sustainGate && len >= mnl)
      if (accept && len >= Math.min(3, mnl)) {
        const meanAct = cnt > 0 ? sum / cnt : peak
        const conf = Math.max(0, Math.min(1, 0.55 * onsetPeak + 0.45 * meanAct))
        const startF = onsetPeak >= p.onsetGate ? Math.min(f, onsetAt) : f
        out.push({
          start: bpFrameTimeSec(startF),
          end: bpFrameTimeSec(end + 1),
          midi: b + 21,
          confidence: conf,
          velocity: conf,
        })
      }
      f = Math.max(g, f + 1)
    }
  }
  out.sort((a, b2) => a.start - b2.start || a.midi - b2.midi)
  return mergeAdjacentSamePitch(out, 0.06)
}

/** 取预设(带缺省),供页面与评测共用,避免两边默认值再次漂移 */
export function bpPreset(id: BpPresetId): Required<Pick<BpOptions, 'onsetThresh' | 'frameThresh' | 'minNoteLenFrames' | 'melodiaTrick' | 'recallExtract'>> {
  return { ...BP_PRESETS[id] }
}

/** 初始化 TF.js 后端:优先 WebGL;虚拟显示驱动下 GL 推理会挂死,由看门狗回退并行 CPU */
export async function ensureBackend(forceCpu = false): Promise<string> {
  const tf = await import('@tensorflow/tfjs')
  if (!forceCpu) {
    try {
      await tf.setBackend('webgl')
      await tf.ready()
      if (tf.getBackend() === 'webgl') return 'webgl'
    } catch {
      /* 回退 CPU */
    }
  }
  await tf.setBackend('cpu')
  await tf.ready()
  return tf.getBackend()
}

export type BpStage = 'model' | 'infer' | 'notes'
export type BpProgress = (p: number) => void
export type BpStageFn = (stage: BpStage, info?: string) => void

interface BpChannelsRequest extends BpOptions {
  channels: Float32Array[]
  sampleRate: number
  duration: number
  postOnWorker?: boolean // 重后处理(melodia)发回常驻 Worker:主线程 GL 路径下避免长音频提取阶段冻结页面
}

const FPS = Math.floor(22050 / 256) // 名义 86(只用于"名义帧数"换算;真实时基见下方工具函数)
const WINDOW_SAMPLES = 22050 * 2 - 256 // 模型窗口 2s
const CHUNK_SAMPLES = 60 * 22050 // 每块 60s

// ---- BP 帧轴的**真实**时基(2026-10-07 修复,背景见 PLAN-90 阶段 0 / AUTO.md §7.5)----
// 包内滑窗:每窗输入 43844 采样、步进 HOP_SIZE=36164 采样,unwrap 后每窗贡献 142 帧
// → 有效帧率 22050×142/36164 ≈ **86.582**,不是名义 86。
// 音符时间由 toMidi.modelFrameToTime 生成:帧 k → k×256/22050 − 窗偏移×⌊k/172⌋。
// 旧分块按名义 60s 推进,但保留的 5160 帧只覆盖 59.609s → 每块边界丢 0.391s,
// 块 c 的音符整体提前 0.391×c 秒(>60s 音频全错位;评测片段均 <60s 故从未暴露)。
const BP_WIN_FRAMES = 172 // toMidi 的窗口帧数(ANNOT_N_FRAMES = 86×2)
const BP_WIN_OFFSET = (256 / 22050) * (BP_WIN_FRAMES - 43844 / 256) + 0.0018 // ≈0.010327s,与 toMidi.ts 同式
/** 帧轴真实帧率(≈86.582)——凡"帧数↔秒"换算一律用它或下面两个函数,禁止再用名义 86 */
export const BP_FPS_TRUE = (22050 * 142) / 36164
/** 帧 k 对应的真实音频时间(秒),与包内 modelFrameToTime 一致 */
export function bpFrameTimeSec(k: number): number {
  return (k * 256) / 22050 - BP_WIN_OFFSET * Math.floor(k / BP_WIN_FRAMES)
}
/** 前 n 帧覆盖的真实音频时长(秒)。分块推进必须用它,而不是名义 n/86 */
export function bpFrameSpanSec(n: number): number {
  return n > 0 ? bpFrameTimeSec(n) : 0
}
/** 音频时间(秒)→ 帧序号(modelFrameToTime 的数值逆,一次迭代收敛到 ±1 帧) */
export function bpTimeToFrame(t: number): number {
  let k = Math.round((t * 22050) / 256)
  k = Math.round(((t + BP_WIN_OFFSET * Math.floor(k / BP_WIN_FRAMES)) * 22050) / 256)
  return Math.max(0, k)
}

let modulePromise: Promise<BpModule> | null = null
let modelPromise: Promise<InstanceType<BpModule['BasicPitch']>> | null = null

export async function getModule(): Promise<BpModule> {
  if (!modulePromise) {
    modulePromise = import('@spotify/basic-pitch')
  }
  return modulePromise
}

export async function getModel(modelUrl?: string) {
  if (!modelPromise) {
    const url = modelUrl ?? MODEL_URL
    modelPromise = (async () => {
      const m = await getModule()
      return new m.BasicPitch(url)
    })()
    modelPromise.catch(() => {
      modelPromise = null
    })
  }
  return modelPromise
}

/** 推理异常后重置引擎,允许重试 */
function resetEngine() {
  modelPromise = null
}

const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0))

/** 主线程 GL 健康预检:微型矩阵乘 + 回读,3 秒竞速。
 *  部分嵌入浏览器(如 ZCode 内嵌 WebView)Worker 内的 GL 回读会永久挂死,
 *  但主线程 GL 正常——本预检通过才走主线程 GPU 救援路径。 */
async function mainGlHealthCheck(): Promise<boolean> {
  try {
    const backend = await ensureBackend(false)
    if (backend !== 'webgl') return false
    const tf = await import('@tensorflow/tfjs')
    const a = tf.randomNormal([128, 128])
    const b = tf.matMul(a, a)
    const ok = await Promise.race([
      b.data().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ])
    a.dispose()
    b.dispose()
    return ok
  } catch {
    return false
  }
}

/** 分块推理:60s 一块,块间带一个窗口的重叠上下文并裁掉越界帧。
 *  避免长音频一次性构建 (总时长×86 帧) 的巨型张量;每块结束让出事件循环,
 *  主线程混合模式下进度得以刷新。 */
export async function evaluateChunked(
  bp: InstanceType<BpModule['BasicPitch']>,
  pcm: Float32Array,
  onProgress: BpProgress,
): Promise<{ frames: number[][]; onsets: number[][] }> {
  const frames: number[][] = []
  const onsets: number[][] = []
  const total = pcm.length
  const nChunks = Math.max(1, Math.ceil(total / CHUNK_SAMPLES))
  let start = 0
  let ci = 0
  while (start < total) {
    const span = Math.min(CHUNK_SAMPLES, total - start) // 本块的"名义"时长
    const input = pcm.subarray(start, Math.min(total, start + span + WINDOW_SAMPLES)) // 多带一个窗口的上下文
    const cf: number[][] = []
    const co: number[][] = []
    await bp.evaluateModel(
      input,
      (f, o) => {
        for (let i = 0; i < f.length; i++) {
          cf.push(f[i])
          co.push(o[i])
        }
      },
      (p) => onProgress((ci + p) / nChunks),
    )
    const nominal = Math.floor((span * FPS) / SR)
    const kept = Math.min(nominal, cf.length)
    for (let i = 0; i < kept; i++) {
      frames.push(cf[i])
      onsets.push(co[i])
    }
    // 块推进 = 保留帧覆盖的**真实**时长(名义 60s 的块实际覆盖 59.609s)。
    // 差值部分由下一块的重叠上下文覆盖;末块尾部 <0.4% 音频不出帧(可忽略)。
    start += Math.max(1, Math.round(bpFrameSpanSec(kept) * SR))
    ci++
    await yieldToEventLoop()
  }
  return { frames, onsets }
}

/** 重后处理:帧矩阵 → 音符(melodia O(音符×帧) 的大头,Worker 与页面内结果共用) */
export async function postProcessFrames(
  frames: number[][],
  onsets: number[][],
  opts: BpOptions,
  duration: number,
): Promise<TranscribeResult> {
  const m = loadedModule ?? (await getModule())
  loadedModule = m
  // 未指定场景时按"通用混音"预设兜底(页面/评测都会显式传预设值)
  const preset: Required<Pick<BpOptions, 'onsetThresh' | 'frameThresh' | 'minNoteLenFrames' | 'melodiaTrick'>> = BP_PRESETS.mix
  const onsetThresh = opts.onsetThresh ?? preset.onsetThresh
  const frameThresh = opts.frameThresh ?? preset.frameThresh
  const minNoteLenFrames = opts.minNoteLenFrames ?? preset.minNoteLenFrames
  const melodiaTrick = opts.melodiaTrick ?? preset.melodiaTrick
  // 全曲音准校准:帧域分数半音移位(±50 音分内)。等价于先把音频校准再推理,
  // 但省掉重采样/重推理,且完全不碰时间轴(起音、节拍、A/B 对比不受影响)。
  // 偏移量由调用方用 YIN 物理测量并经 opts.tuningCents 传入——BP 帧激活是
  // 分类器输出,会向半音格收缩,不能用来测自身偏移(见 tuning.ts 注释)。
  let framesUse = frames
  let tuningCents: number | undefined
  if (opts.autoTune !== false && opts.tuningCents !== undefined && Number.isFinite(opts.tuningCents) && opts.tuningCents !== 0) {
    framesUse = shiftFramesPitch(frames, opts.tuningCents / 100)
    onsets = shiftFramesPitch(onsets, opts.tuningCents / 100)
    tuningCents = Math.round(opts.tuningCents)
  }
  // 音域限频在音符生成之前生效(constrainFrequency 直接抹掉帧矩阵):整曲混识别时
  // 贝斯/底鼓(<70Hz)与镲片泛音(>1350Hz)不会变成音符。
  // 召回优先分支(失真混音)不经 outputToNotesPoly:单帧双阈值会把被掩蔽的真实音
  // 整段丢掉,改用聚合提取(帧分段+onset联合+持续门限,见 extractNotesAggressive)。
  let notes: RawNote[]
  if (opts.recallExtract) {
    const rp = opts.recallExtract === true ? RECALL_EXTRACT_DEFAULTS : opts.recallExtract
    notes = extractNotesAggressive(framesUse, onsets, rp, {
      minNoteLenFrames,
      lowestMidi: opts.lowestMidi ?? 36,
      highestMidi: opts.highestMidi ?? 90,
    })
  } else {
    const events = m.outputToNotesPoly(
      framesUse,
      onsets,
      onsetThresh,
      frameThresh,
      minNoteLenFrames,
      true,
      opts.maxHz ?? 1350,
      opts.minHz ?? 70,
      melodiaTrick,
    )
    const timed = m.noteFramesToTime(events)
    notes = timed
      .map((n) => ({
        start: n.startTimeSeconds,
        end: n.startTimeSeconds + Math.max(0.08, n.durationSeconds),
        midi: n.pitchMidi,
        confidence: Math.max(0, Math.min(1, n.amplitude)),
        velocity: Math.max(0, Math.min(1, n.amplitude)),
      }))
      .filter((n) => n.midi >= (opts.lowestMidi ?? 36) && n.midi <= (opts.highestMidi ?? 90))
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi)
  if (opts.mergeSplits !== false) notes = mergeAdjacentSamePitch(notes)
  // 八度重影过滤:干净素材默认开;召回提取模式默认关(在失真混音上会删掉和弦内
  // 真实八度叠音,实测 −2.4pt F1,见 removeOctaveGhosts 注释)
  const ghostDefault = opts.recallExtract ? false : true
  if ((opts.removeOctaveGhosts ?? ghostDefault) !== false) {
    notes = removeOctaveGhosts(notes, { keepChordOctaves: opts.octaveChordKeep !== false })
  }
  // 贝斯谐波幽灵修剪(默认关):贝斯基频被 minHz 切掉后,其 2×/4× 谐波会以
  // "孤立的低音区八度音"残留。合成样例上净收益 ≈ 0(见 EVAL.md),真实数据评测后再默认开。
  if (opts.bassGhostPrune && opts.bassNotes?.length) notes = pruneBassHarmonicGhosts(notes, opts.bassNotes, opts.lowestMidi ?? 36)
  // 和弦词典 snap:同时发音簇吸附到可行和弦音级(每簇最多修一个音、最多 1 半音,保守)
  if (opts.chordSnap !== false) notes = snapClustersToChords(notes)
  // 起音对时:BP 的起点是 86fps 帧量化(11.6ms),用 DSP 起音(实测偏差 ≤3.4ms)修正。
  // 放在所有"删音/改音"之后做,避免把已经被删掉的音符也算进吸附竞争者。
  let retimed = 0
  let anchor: number | undefined
  if (opts.retime !== false && opts.retimeOnsets && opts.retimeOnsets.length) {
    const r = retimeNotesToOnsets(notes, opts.retimeOnsets)
    notes = r.notes
    retimed = r.moved
    anchor = pickAnchor(notes, opts.retimeOnsets)
  }
  const onsetsT = [...new Set(notes.map((n) => +n.start.toFixed(3)))].sort((a, b) => a - b)
  // 整曲节拍:起音包络自相关(跟全曲律动,含鼓点驱动的起音),锁定不住再退回音符间隔直方图
  const env = new Float32Array(onsets.length)
  for (let f = 0; f < onsets.length; f++) {
    let s = 0
    const of = onsets[f]
    for (let i = 0; i < of.length; i++) s += of[i]
    env[f] = s
  }
  const envBpm = estimateBpmFromEnvelope(env, BP_FPS_TRUE)
  const guessed =
    envBpm.strength > 0.1
      ? envBpm.bpm
      : opts.bpmHint && opts.bpmHint > 0
        ? opts.bpmHint
        : estimateBpm(onsetsT).bpm
  // 保守仲裁:包络在"只弹八分/分解和弦"的素材上会锁错周期(实测合成混音 4/7 把 100 读成
  // 164/50/165/164,直接毁掉谱面网格)。用音符的"格内贴合 + 重音落拍"改写,但只在明确更优时。
  const arb = arbitrateBpm(guessed, notes, { hint: opts.bpmHint })
  const bpm = arb.bpm
  return {
    notes,
    onsets: onsetsT,
    bpm,
    bpmStrength: arb.strength > 0 ? Math.max(arb.strength, envBpm.strength) : envBpm.strength,
    offset: anchor ?? (onsetsT.length ? onsetsT[0] : 0),
    duration,
    f0Track: new Float32Array(0),
    tuningCents,
    retimed,
  }
}

let loadedModule: BpModule | null = null

/** 核心管线:多通道 PCM → TranscribeResult(worker 与主线程兜底共用) */
export async function transcribeWithBasicPitchChannels(
  req: BpChannelsRequest,
  onProgress: BpProgress,
  onStage: BpStageFn,
): Promise<TranscribeResult> {
  onStage('model')
  const backend = await ensureBackend(req.forceCpu)
  const m = await getModule()
  loadedModule = m
  const bp = await getModel(req.modelUrl)
  onStage('model', backend)
  const mono = toMono(req.channels, req.channels[0].length)
  const resampled = resampleLinear(mono, req.sampleRate, SR)
  // 全曲音准校准的偏移量:YIN 物理测量(在此处统一计算,worker/主线程兜底/eval 三条路径共用)
  if (req.autoTune !== false && req.tuningCents === undefined) {
    const tune = estimateTuningFromPcm(resampled, SR)
    req.tuningCents = tune ? Math.round(tune.semis * 100) : 0
  }
  // 起音对时:用同一份 22050Hz 音频跑 DSP 起音检测(与 DSP 引擎同款,实测偏差 ≤3.4ms),
  // 后续在 postProcessFrames 里把 BP 的帧量化起点逐音吸附过去
  if (req.retime !== false && !req.retimeOnsets) {
    req.retimeOnsets = estimateOnsets(resampled, SR)
  }
  let frames: number[][] = []
  let onsets: number[][] = []
  try {
    const r = await evaluateChunked(bp, resampled, (p) => {
      onStage('infer')
      onProgress(p)
    })
    frames = r.frames
    onsets = r.onsets
  } catch (err) {
    resetEngine()
    throw err
  }
  onProgress(1)
  onStage('notes')
  await yieldToEventLoop()
  // 重后处理是 O(音符×帧) 的纯 JS:长音频在主线程要跑数分钟会冻结页面,发回常驻 Worker
  if (req.postOnWorker && getBpWorker()) {
    return runWorkerJob(
      { type: 'postFrames', opts: req, frames, onsets, duration: req.duration },
      onProgress,
      onStage,
      30 * 60000,
    )
  }
  const result = await postProcessFrames(frames, onsets, req, req.duration)
  frames = []
  onsets = []
  return result
}

/**
 * 八度重影过滤:模型常见的「同一时间出现基频 + 高/低八度」幻觉。
 * 时间重叠超过较短音符 50% 且音高差恰为 12/24 半音 → 保留响度大的那个。
 *
 * 例外(可关):**真实和弦里的八度加倍**是吉他最常见的按法之一
 * (如 E2+B2+E3 的 E 和弦把位)。若较弱的那个八度音同时与 ≥2 个其它音发声、
 * 且这一簇的音级能落进和弦词典,则判为"和弦音"而不是幽灵,整簇保留。
 * 双音(根音+八度)仍按原规则处理 —— 这是实测净收益 +5 点的行为,不冒险放宽。
 */
export function removeOctaveGhosts(notes: RawNote[], opts: { keepChordOctaves?: boolean } = {}): RawNote[] {
  const keepChordOctaves = opts.keepChordOctaves !== false
  const dead = new Set<number>()
  // 预计算每个音所在的同时发声音簇(起音相差 ≤60ms),用于"这是和弦不是幽灵"的判据
  const clusterOf = (i: number): RawNote[] => {
    const a = notes[i]
    const out = [a]
    for (let k = 0; k < notes.length; k++) {
      if (k === i) continue
      const b = notes[k]
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start)
      if (overlap <= 0) continue
      if (Math.abs(b.start - a.start) <= 0.06) out.push(b)
    }
    return out
  }
  for (let i = 0; i < notes.length; i++) {
    if (dead.has(i)) continue
    for (let j = i + 1; j < notes.length; j++) {
      if (dead.has(j)) continue
      const a = notes[i]
      const b = notes[j]
      if (b.start >= a.end) break
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start)
      const shorter = Math.min(a.end - a.start, b.end - b.start)
      const dOctave = Math.abs(a.midi - b.midi)
      if ((dOctave === 12 || dOctave === 24) && overlap > shorter * 0.5) {
        const weakIdx = a.velocity >= b.velocity ? j : i
        // 单八度差:若弱音处在"和弦形态的同时发声音簇"里,它更可能是真实的八度加倍
        if (dOctave === 12 && keepChordOctaves) {
          const cl = clusterOf(weakIdx)
          if (cl.length >= 3 && fitsChord(cl.map((n) => n.midi))) continue
        }
        dead.add(weakIdx)
        if (weakIdx === i) break
      }
    }
  }
  return notes.filter((_, i) => !dead.has(i))
}

/**
 * 贝斯谐波幽灵修剪:混音里贝斯基频(常 <70Hz)被音域下限切掉后,其 2×/4× 谐波
 * 会被模型当成"孤立的低音区音符"残留——它们与贝斯线成 ±12/24 半音且时间对齐。
 *
 * 两道防线防止误伤(独奏/贝斯茎被吉他低音弦污染时会反噬,实测 solo-guitar 曾被
 * 剪掉 40% 的真实音符):
 *   ① 只认「低于吉他音域」的贝斯参照音(真贝斯 E1~B1 区)。独奏吉他漏进贝斯茎
 *      的成分都在吉他音域内,整批参照作废,修剪自动关闭;
 *   ② 双重置信度门槛:既低于全体中位、也低于绝对值 0.35——真实拨弦音通常更响,
 *      谐波残留是弱激活(实测 0.45 会误伤弱奏真音,guitar-bass 上净收益转负)。
 */
export function pruneBassHarmonicGhosts(
  notes: RawNote[],
  bass: { start: number; end: number; midi: number }[],
  lowestGuitarMidi = 36,
): RawNote[] {
  // 只保留低到不可能是吉他的参照(贝斯基频区)
  const refs = bass.filter((b) => b.midi < lowestGuitarMidi)
  if (refs.length === 0 || notes.length === 0) return notes
  const confs = notes.map((n) => n.confidence).sort((a, b) => a - b)
  const medConf = confs[confs.length >> 1]
  return notes.filter((n) => {
    if (n.confidence >= medConf || n.confidence >= 0.35) return true
    for (const b of refs) {
      const d = n.midi - b.midi
      if (d !== 12 && d !== 24) continue
      // 起音对齐(而非时间重叠):谐波幽灵与贝斯基频同帧出现;
      // 真实吉他双打即便同和声,拨弦时刻通常错开,且贝斯音可持续 1s+,重叠判据会大面积误伤
      if (Math.abs(n.start - b.start) <= 0.08) return false
    }
    return true
  })
}

/**
 * 合并「同一音高、首尾相接」的相邻音符。
 *
 * 动机(实测):melodia 后处理会把一个持续音拆成两段——音尾衰减时该音高的帧激活
 * 跌破阈值、随后又回升,于是同一个音在谱面上被写成两个。合成单声部样例上
 * 56 个标注音被输出成 114 个,其中绝大多数就是这种同音高紧邻的碎片。
 *
 * 判据刻意保守:音高完全相同、后段起点不早于前段起点、且间隔 ≤ gapSec。
 * 真正的同音重复(re-articulation)会因起音与衰减包络留下明显间隔,不会被并入。
 */
export function mergeAdjacentSamePitch(notes: RawNote[], gapSec = 0.03): RawNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi)
  const out: RawNote[] = []
  // 按音高各自记录"最近一段"的位置:若只跟排序后紧邻的上一个音比较,
  // 中间夹进一个别的音高就会断链(延音 A 还没结束时 B 起音,再出现 A 的碎片)。
  const lastIdxByMidi = new Map<number, number>()
  for (const n of sorted) {
    const li = lastIdxByMidi.get(n.midi)
    if (li !== undefined) {
      const last = out[li]
      if (n.start >= last.start && n.start - last.end <= gapSec) {
        last.end = Math.max(last.end, n.end)
        last.confidence = Math.max(last.confidence, n.confidence)
        last.velocity = Math.max(last.velocity, n.velocity)
        continue
      }
    }
    out.push({ ...n })
    lastIdxByMidi.set(n.midi, out.length - 1)
  }
  return out
}

// ---------- Worker 编排 ----------

let bpWorker: Worker | null = null
let jobSeq = 0
// 本页面会话内 Worker-GL 已确认挂死:后续任务跳过 45s 看门狗等待,直接走回退链
let workerGlDead = false

interface PendingJob {
  resolve: (r: TranscribeResult) => void
  reject: (e: Error) => void
  onProgress: BpProgress
  onStage: BpStageFn
}
const pendingJobs = new Map<number, PendingJob>()

function getBpWorker(): Worker | null {
  if (bpWorker) return bpWorker
  try {
    bpWorker = new Worker(new URL('./bpWorker.ts', import.meta.url), { type: 'module' })
    bpWorker.onmessage = (e: MessageEvent) => {
      const { type, id, p, stage, info, result, message } = e.data ?? {}
      const job = pendingJobs.get(id)
      if (!job) return
      if (type === 'progress') job.onProgress(p)
      else if (type === 'stage') job.onStage(stage, info)
      else if (type === 'done') {
        pendingJobs.delete(id)
        job.resolve(result)
      } else if (type === 'error') {
        pendingJobs.delete(id)
        job.reject(new Error(message))
      }
    }
    bpWorker.onerror = (e) => {
      console.error('[BP Worker] error', e.message ?? e)
      for (const [, job] of pendingJobs) job.reject(new Error('AI 引擎 Worker 崩溃'))
      pendingJobs.clear()
      bpWorker?.terminate()
      bpWorker = null
    }
    return bpWorker
  } catch {
    return null
  }
}

function runWorkerJob(
  payload: Record<string, unknown>,
  onProgress: BpProgress,
  onStage: BpStageFn,
  timeoutMs = 45000,
): Promise<TranscribeResult> {
  const worker = getBpWorker()
  if (!worker) return Promise.reject(new Error('WORKER_UNAVAILABLE'))
  const id = ++jobSeq
  return new Promise<TranscribeResult>((resolve, reject) => {
    let lastActivity = Date.now()
    let stage = ''
    const watchdog = window.setInterval(() => {
      // 'notes' 阶段是纯 JS 的 melodia 后处理,长音频本身就要数分钟且无中间消息,不做超时
      if (stage === 'notes') return
      if (Date.now() - lastActivity > timeoutMs) {
        window.clearInterval(watchdog)
        pendingJobs.delete(id)
        // WebGL 挂死在 GPU 调用里,worker 事件循环已冻结,只能整杀
        worker.terminate()
        if (bpWorker === worker) bpWorker = null
        reject(new Error('WEBGL_HANG'))
      }
    }, 5000)
    pendingJobs.set(id, {
      resolve: (r) => {
        window.clearInterval(watchdog)
        resolve(r)
      },
      reject: (e) => {
        window.clearInterval(watchdog)
        reject(e)
      },
      onProgress: (p) => {
        lastActivity = Date.now()
        onProgress(p)
      },
      onStage: (s, info) => {
        lastActivity = Date.now()
        stage = s
        onStage(s, info)
      },
    })
    worker.postMessage({ id, ...payload })
  })
}

/** 单 Worker CPU 推理(短音频,或并行不可用时的回退) */
async function runSingleCpu(
  buffer: AudioBuffer,
  opts: BpOptions,
  modelUrl: string,
  onProgress: BpProgress,
  onStage: BpStageFn,
): Promise<TranscribeResult> {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
  return runWorkerJob(
    { type: 'run', opts: { ...opts, forceCpu: true, modelUrl }, channels, sampleRate: buffer.sampleRate, duration: buffer.duration },
    onProgress,
    onStage,
  )
}

/** 并行 CPU 推理:音频切成 N 块,分给 N 个临时 Worker 同时跑(各自加载模型,CPU 后端),
 *  顺序汇总帧矩阵后交给常驻 Worker 做音符提取。GL 挂死环境(向日葵/ToDesk 虚拟显示驱动)的多核提速。 */
async function runParallelCpu(
  buffer: AudioBuffer,
  opts: BpOptions,
  modelUrl: string,
  onProgress: BpProgress,
  onStage: BpStageFn,
): Promise<TranscribeResult> {
  const cores = navigator.hardwareConcurrency || 4
  const N = Math.max(1, Math.min(4, Math.floor(cores / 3)))
  if (N < 2 || buffer.duration < 24) return runSingleCpu(buffer, opts, modelUrl, onProgress, onStage)
  onStage('model')
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
  const mono = toMono(channels, buffer.length)
  const resampled = resampleLinear(mono, buffer.sampleRate, SR)
  // 起音对时表在此算一次(并行 CPU 路径也要,否则后处理拿不到时间基准)
  if (opts.retime !== false && !opts.retimeOnsets) {
    opts = { ...opts, retimeOnsets: estimateOnsets(resampled, SR) }
  }
  // 切块(与 evaluateChunked 同规则:块尾多带一个 2s 窗口上下文,汇总时裁掉越界帧;
  // 推进按"保留帧的真实时长"而非名义时长,否则每块边界丢 0.391s —— 见 bpFrameSpanSec 注释)
  const chunkTarget = Math.ceil(resampled.length / N)
  const chunks: { start: number; span: number }[] = []
  for (let start = 0; start < resampled.length; ) {
    const span = Math.min(chunkTarget, resampled.length - start)
    chunks.push({ start, span })
    const nominal = Math.floor((span * FPS) / SR)
    start += Math.max(1, Math.round(bpFrameSpanSec(nominal) * SR))
  }
  const total = chunks.length
  const results: { frames: number[][]; onsets: number[][] }[] = []
  let done = 0
  const spawned: Worker[] = []
  const jobs = chunks.map(
    (c, idx) =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL('./bpWorker.ts', import.meta.url), { type: 'module' })
        spawned.push(w)
        const input = resampled.subarray(c.start, Math.min(resampled.length, c.start + c.span + WINDOW_SAMPLES))
        const pcm = new Float32Array(input)
        const nominal = Math.floor((c.span * FPS) / SR)
        w.onmessage = (e: MessageEvent) => {
          const { type, p, stage, info, frames, onsets, message } = e.data ?? {}
          if (type === 'progress') {
            onStage('infer')
            onProgress(Math.min(0.99, (done + (p ?? 0)) / total))
          } else if (type === 'stage' && stage === 'model') {
            onStage('model', (info ?? 'cpu') + '·并行×' + total)
          } else if (type === 'done') {
            results[idx] = { frames: frames.slice(0, nominal), onsets: onsets.slice(0, nominal) }
            done++
            onProgress(done / total)
            w.terminate()
            resolve()
          } else if (type === 'error') {
            w.terminate()
            reject(new Error(message))
          }
        }
        w.onerror = () => {
          w.terminate()
          reject(new Error('并行 Worker 崩溃'))
        }
        w.postMessage({ type: 'runChunk', opts: { ...opts, forceCpu: true, modelUrl }, pcm }, [pcm.buffer])
      }),
  )
  try {
    await Promise.all(jobs)
  } finally {
    spawned.forEach((w) => w.terminate())
  }
  // 按顺序拼接帧矩阵
  const frames: number[][] = []
  const onsets: number[][] = []
  for (const r of results) {
    for (const f of r.frames) frames.push(f)
    for (const o of r.onsets) onsets.push(o)
  }
  onProgress(1)
  onStage('notes')
  // 重后处理(纯 JS)交回常驻 Worker
  return runWorkerJob({ type: 'postFrames', opts, frames, onsets, duration: buffer.duration }, onProgress, onStage, 30 * 60000)
}

/** 对 AudioBuffer 跑 Basic Pitch。
 *  顺序:Worker 全管线(WebGL)→ (GL 挂起,虚拟显示驱动)并行 CPU(多 Worker 分块)→ 单 Worker CPU → 报错。 */
export async function transcribeWithBasicPitch(
  buffer: AudioBuffer,
  opts: BpOptions,
  onProgress: BpProgress,
  onStage: BpStageFn,
): Promise<TranscribeResult> {
  const dbg = (globalThis as unknown as Record<string, unknown>)
  // 模型地址在主线程按页面地址解析(可靠),随任务传给 worker
  // ——dev 里 worker 脚本位于 /src/transcription/,自行相对解析会指错位置
  const modelUrl = new URL('vendor/basic-pitch/model.json', document.baseURI).href
  const runMainFallback = async (
    onP: BpProgress = onProgress,
    onS: BpStageFn = onStage,
  ) => {
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
    return transcribeWithBasicPitchChannels(
      { ...opts, modelUrl, channels, sampleRate: buffer.sampleRate, duration: buffer.duration, postOnWorker: true },
      onP,
      onS,
    )
  }
  if (!getBpWorker()) {
    dbg.__bpMode = 'main-fallback'
    return runMainFallback()
  }
  // Worker-GL 的回退链:① 主线程 GL(预检+latch+看门狗)→ ② 并行 CPU → ③ 单 Worker CPU
  const runFallbackChain = async (): Promise<TranscribeResult> => {
    // 主线程 GPU 救援:Worker-GL 挂死的环境里主线程 GL 往往仍可用(ZCode 内嵌 WebView 实测如此),
    // 预检通过才走;先落 latch 再尝试,若主线程 GL 也把页面冻死,重载后凭 latch 永久跳过
    const GL_LATCH = 'gm-bp-main-gl-dead'
    let mainGlDead = false
    try {
      mainGlDead = localStorage.getItem(GL_LATCH) === '1'
    } catch {
      /* ignore */
    }
    if (!mainGlDead && (await mainGlHealthCheck())) {
      dbg.__bpMode = 'main-webgl'
      onStage('model', 'webgl·主线程')
      onProgress(0)
      try {
        localStorage.setItem(GL_LATCH, '1')
      } catch {
        /* ignore */
      }
      try {
        // 活动看门狗:90s 无进度判定挂死,回退 CPU;notes 阶段在 Worker 跑且无中间消息,豁免
        const r = await new Promise<TranscribeResult>((resolve, reject) => {
          let last = Date.now()
          let settled = false
          let stage: BpStage | '' = ''
          const wd = window.setInterval(() => {
            if (settled || stage === 'notes') return
            if (Date.now() - last > 90000) {
              settled = true
              window.clearInterval(wd)
              reject(new Error('MAIN_GL_HANG'))
            }
          }, 5000)
          const mark = () => {
            last = Date.now()
          }
          runMainFallback(
            (p) => {
              mark()
              onProgress(p)
            },
            (s, info) => {
              mark()
              stage = s
              onStage(s, info)
            },
          ).then(
            (v) => {
              if (!settled) {
                settled = true
                window.clearInterval(wd)
                resolve(v)
              }
            },
            (err) => {
              if (!settled) {
                settled = true
                window.clearInterval(wd)
                reject(err)
              }
            },
          )
        })
        try {
          localStorage.removeItem(GL_LATCH)
        } catch {
          /* ignore */
        }
        return r
      } catch (e2) {
        // 主线程 GL 也失败(保持 latch,今后直接走 CPU)
        ;(globalThis as unknown as Record<string, unknown>).__mainGlErr =
          String(e2) + ' | ' + String((e2 as Error)?.stack ?? '').slice(0, 400)
      }
    }
    // 并行 CPU
    if (!getBpWorker()) {
      dbg.__bpMode = 'main-fallback'
      return runMainFallback()
    }
    dbg.__bpMode = 'parallel-cpu'
    onStage('model')
    onProgress(0)
    try {
      return await runParallelCpu(buffer, opts, modelUrl, onProgress, onStage)
    } catch (e2) {
      ;(globalThis as unknown as Record<string, unknown>).__parErr = String(e2) + ' | ' + String((e2 as Error)?.stack ?? '').slice(0, 400)
      dbg.__bpMode = 'worker-cpu'
      onStage('model')
      onProgress(0)
      return runSingleCpu(buffer, opts, modelUrl, onProgress, onStage)
    }
  }
  // 本会话已确认 Worker-GL 挂死:不再白等 45s 看门狗,直接进回退链
  if (workerGlDead) {
    onStage('model')
    onProgress(0)
    return runFallbackChain()
  }
  dbg.__bpMode = 'worker'
  try {
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
    return await runWorkerJob(
      {
        type: 'run',
        opts: { ...opts, modelUrl },
        channels,
        sampleRate: buffer.sampleRate,
        duration: buffer.duration,
      },
      onProgress,
      onStage,
    )
  } catch (e) {
    if (String((e as Error)?.message).includes('WEBGL_HANG')) {
      workerGlDead = true
      return runFallbackChain()
    }
    throw e
  }
}
