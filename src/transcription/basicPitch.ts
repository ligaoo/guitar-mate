// Basic Pitch(Spotify 开源)复音识别引擎封装
// 三级执行策略,保证任何环境都能出结果且不冻结页面:
//   ① 常驻 Worker 全管线(正常桌面:Worker-WebGL,最佳)
//   ② 混合模式(虚拟显示器/远程控制环境 Worker-WebGL 挂起时):
//      主线程用真实 canvas 的 WebGL 分块推理(批间让出事件循环,进度可刷新),
//      重后处理(melodia O(音符×帧) )仍发回 Worker 执行
//   ③ Worker-CPU 兜底(慢,但一定有结果)
// 长音频按 60s 分块推理,避免一次性构建数百 MB 的帧张量
import { toMono, resampleLinear, estimateBpm, SR, type TranscribeResult, type RawNote } from './pipeline'

// 模型路径按运行上下文解析:页面里相对页面(支持子路径部署);
// Worker 里相对 worker 脚本(位于 assets/ 下,回退一级)
const MODEL_URL = (() => {
  const rel = 'vendor/basic-pitch/model.json'
  if (typeof window === 'undefined') {
    return new URL('../' + rel, self.location.href).href
  }
  return new URL(rel, document.baseURI).href
})()

type BpModule = typeof import('@spotify/basic-pitch')

export interface BpOptions {
  onsetThresh?: number // 起音阈值,越低越灵敏(默认 0.35)
  frameThresh?: number // 延音阈值(默认 0.2)
  minNoteLenFrames?: number // 最短音符(帧,86fps;默认 35 ≈ 0.4s,快句友好)
  removeOctaveGhosts?: boolean // 去除同时段的八度重影(默认开;和弦含真八度时应关闭)
  forceCpu?: boolean // 跳过 WebGL 直接用 CPU(看门狗回退 / 并行模式)
  modelUrl?: string // 模型地址:由主线程按页面地址解析后传给 worker(dev 与构建环境统一)
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

/** 分块推理:60s 一块,块间带一个窗口的重叠上下文并裁掉越界帧。
 *  避免长音频一次性构建 (总时长×86 帧) 的巨型张量;每块结束让出事件循环,
 *  主线程混合模式下进度得以刷新。 */
async function evaluateChunked(
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
  const events = m.outputToNotesPoly(
    frames,
    onsets,
    opts.onsetThresh ?? 0.35,
    opts.frameThresh ?? 0.2,
    opts.minNoteLenFrames ?? 35,
    true,
    null,
    null,
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
    .filter((n) => n.midi >= 40 && n.midi <= 88)
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi)
  if (opts.removeOctaveGhosts !== false) notes = removeOctaveGhosts(notes)
  const onsetsT = [...new Set(notes.map((n) => +n.start.toFixed(3)))].sort((a, b) => a - b)
  return {
    notes,
    onsets: onsetsT,
    bpm: estimateBpm(onsetsT).bpm,
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
  const result = await postProcessFrames(frames, onsets, req, req.duration)
  frames = []
  onsets = []
  return result
}

/**
 * 八度重影过滤:模型常见的「同一时间出现基频 + 高/低八度」幻觉。
 * 时间重叠超过较短音符 50% 且音高差恰为 12/24 半音 → 保留响度大的那个。
 */
function removeOctaveGhosts(notes: RawNote[]): RawNote[] {
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

// ---------- Worker 编排 ----------

let bpWorker: Worker | null = null
let jobSeq = 0

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
  const runMainFallback = async () => {
    dbg.__bpMode = 'main-fallback'
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
    return transcribeWithBasicPitchChannels(
      { ...opts, modelUrl, channels, sampleRate: buffer.sampleRate, duration: buffer.duration },
      onProgress,
      onStage,
    )
  }
  if (!getBpWorker()) return runMainFallback()
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
      // Worker 的 WebGL 挂死(远程桌面/虚拟显示驱动):换多 Worker 并行 CPU
      if (!getBpWorker()) return runMainFallback()
      dbg.__bpMode = 'parallel-cpu'
      onStage('model')
      onProgress(0)
      try {
        return await runParallelCpu(buffer, opts, modelUrl, onProgress, onStage)
      } catch (e2) {
        dbg.__bpMode = 'worker-cpu'
        onStage('model')
        onProgress(0)
        return runSingleCpu(buffer, opts, modelUrl, onProgress, onStage)
      }
    }
    throw e
  }
}
