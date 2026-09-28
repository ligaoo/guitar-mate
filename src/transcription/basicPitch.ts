// Basic Pitch(Spotify 开源)复音识别引擎封装
// 四级执行策略,保证任何环境都能出结果且尽量不冻结页面:
//   ① 常驻 Worker 全管线(正常桌面:Worker-WebGL,最佳)
//   ② Worker-GL 挂死时:主线程 WebGL 分块推理(预检 + latch + 活动看门狗;
//      嵌入式浏览器如 ZCode 内嵌 WebView 的 Worker GL 回读挂死,但主线程 GL 正常)
//   ③ 多 Worker 并行 CPU(主线程 GL 也不可用时)
//   ④ 单 Worker CPU 兜底(慢,但一定有结果)
// 长音频按 60s 分块推理,避免一次性构建数百 MB 的帧张量
import { toMono, resampleLinear, estimateBpm, estimateBpmFromEnvelope, SR, type TranscribeResult, type RawNote } from './pipeline'

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
  onsetThresh?: number // 起音阈值,越低越灵敏(默认 0.35)
  frameThresh?: number // 延音阈值(默认 0.2)
  minNoteLenFrames?: number // 最短音符(帧,86fps;默认 12 ≈ 140ms,16 分音符可检出)
  removeOctaveGhosts?: boolean // 去除同时段的八度重影(默认开;和弦含真八度时应关闭)
  mergeSplits?: boolean // 合并同一音高、首尾相接的被拆音符(默认开)
  forceCpu?: boolean // 跳过 WebGL 直接用 CPU(看门狗回退 / 并行模式)
  modelUrl?: string // 模型地址:由主线程按页面地址解析后传给 worker(dev 与构建环境统一)
  minHz?: number // 音域下限(默认 70Hz ≈ Drop D 的 D2):整曲混识别时切掉贝斯/底鼓
  lowestMidi?: number // MIDI 音域下限(默认 36):按调弦传入可保住 Drop D/DADGAD 的低音 D2=38
  highestMidi?: number // MIDI 音域上限(默认 90):按调弦+最高品传入
  maxHz?: number // 音域上限(默认 1350Hz ≈ 22 品高音弦):切掉镲片泛音等超声垃圾
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

const FPS = Math.floor(22050 / 256) // 86 帧/秒
const WINDOW_SAMPLES = 22050 * 2 - 256 // 模型窗口 2s
const CHUNK_SAMPLES = 60 * 22050 // 每块 60s

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
    for (let i = 0; i < Math.min(nominal, cf.length); i++) {
      frames.push(cf[i])
      onsets.push(co[i])
    }
    start += span
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
  // 音域限频在音符生成之前生效(constrainFrequency 直接抹掉帧矩阵):整曲混识别时
  // 贝斯/底鼓(<70Hz)与镲片泛音(>1350Hz)不会变成音符
  const events = m.outputToNotesPoly(
    frames,
    onsets,
    opts.onsetThresh ?? 0.35,
    opts.frameThresh ?? 0.2,
    opts.minNoteLenFrames ?? 12,
    true,
    opts.maxHz ?? 1350,
    opts.minHz ?? 70,
    true,
  )
  const timed = m.noteFramesToTime(events)
  let notes: RawNote[] = timed
    .map((n) => ({
      start: n.startTimeSeconds,
      end: n.startTimeSeconds + Math.max(0.08, n.durationSeconds),
      midi: n.pitchMidi,
      confidence: Math.max(0, Math.min(1, n.amplitude)),
      velocity: Math.max(0, Math.min(1, n.amplitude)),
    }))
    .filter((n) => n.midi >= (opts.lowestMidi ?? 36) && n.midi <= (opts.highestMidi ?? 90))
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi)
  if (opts.mergeSplits !== false) notes = mergeAdjacentSamePitch(notes)
  if (opts.removeOctaveGhosts !== false) notes = removeOctaveGhosts(notes)
  const onsetsT = [...new Set(notes.map((n) => +n.start.toFixed(3)))].sort((a, b) => a - b)
  // 整曲节拍:起音包络自相关(跟全曲律动,含鼓点驱动的起音),锁定不住再退回音符间隔直方图
  const env = new Float32Array(onsets.length)
  for (let f = 0; f < onsets.length; f++) {
    let s = 0
    const of = onsets[f]
    for (let i = 0; i < of.length; i++) s += of[i]
    env[f] = s
  }
  const envBpm = estimateBpmFromEnvelope(env, FPS)
  const bpm = envBpm.strength > 0.1 ? envBpm.bpm : estimateBpm(onsetsT).bpm
  return {
    notes,
    onsets: onsetsT,
    bpm,
    bpmStrength: envBpm.strength,
    offset: onsetsT.length ? onsetsT[0] : 0,
    duration,
    f0Track: new Float32Array(0),
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
 */
export function removeOctaveGhosts(notes: RawNote[]): RawNote[] {
  const dead = new Set<number>()
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
        if (a.velocity >= b.velocity) dead.add(j)
        else dead.add(i)
      }
    }
  }
  return notes.filter((_, i) => !dead.has(i))
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
  // 切块(与 evaluateChunked 同规则:块尾多带一个 2s 窗口上下文,汇总时裁掉越界帧)
  const chunkTarget = Math.ceil(resampled.length / N)
  const chunks: { start: number; span: number }[] = []
  for (let start = 0; start < resampled.length; start += chunkTarget) {
    chunks.push({ start, span: Math.min(chunkTarget, resampled.length - start) })
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
