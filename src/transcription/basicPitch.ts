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
  forceBackend?: 'wasm' | 'cpu' // 看门狗重试时指定的回退后端
  modelUrl?: string // 模型地址:由主线程按页面地址解析后传给 worker(dev 与构建环境统一)
  wasmBase?: string // WASM 文件目录地址(同上)
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

async function getModule(): Promise<BpModule> {
  if (!modulePromise) {
    modulePromise = import('@spotify/basic-pitch')
  }
  return modulePromise
}

/** 初始化 TF.js 后端。优先级:
 *  auto: webgl → wasm(SIMD 纯 CPU,虚拟显示驱动下 GL 推理挂死时的最优解)→ cpu;
 *  force 指定时直接用对应后端。返回实际后端名 */
async function ensureBackend(force?: 'wasm' | 'cpu', wasmBase?: string): Promise<string> {
  const tf = await import('@tensorflow/tfjs')
  if (force !== 'cpu') {
    if (force === 'wasm') {
      return await initWasm(wasmBase)
    }
    try {
      await tf.setBackend('webgl')
      await tf.ready()
      if (tf.getBackend() === 'webgl') return 'webgl'
    } catch {
      /* 落到 wasm */
    }
    try {
      return await initWasm(wasmBase)
    } catch {
      /* 落到 cpu */
    }
  }
  await tf.setBackend('cpu')
  await tf.ready()
  return tf.getBackend()
}

/** WASM 后端:纯 SIMD CPU 计算,不碰 GL——向日葵/ToDesk 虚拟显示驱动下
 *  Worker-GL 初始化能过但真实推理提交会挂死,WASM 是这类环境的可靠提速方案 */
async function initWasm(wasmBase?: string): Promise<string> {
  const tf = await import('@tensorflow/tfjs')
  const wasm = await import('@tensorflow/tfjs-backend-wasm')
  if (wasmBase) wasm.setWasmPaths(wasmBase)
  await tf.setBackend('wasm')
  await tf.ready()
  const be = tf.getBackend()
  if (be !== 'wasm') throw new Error('wasm backend unavailable')
  return be
}

async function getModel(modelUrl?: string) {
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
  const backend = await ensureBackend(req.forceBackend, req.wasmBase)
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

/** 对 AudioBuffer 跑 Basic Pitch。
 *  顺序:Worker 全管线(WebGL)→ (GL 挂起,虚拟显示器/远程控制环境)Worker-CPU 兜底 → 报错。
 *  实测这类环境下页面内 GL 也是软件渲染,速度与 CPU 相当还会占用主线程,故不做页面内推理。 */
export async function transcribeWithBasicPitch(
  buffer: AudioBuffer,
  opts: BpOptions,
  onProgress: BpProgress,
  onStage: BpStageFn,
): Promise<TranscribeResult> {
  const dbg = (globalThis as unknown as Record<string, unknown>)
  // 模型/WASM 地址在主线程按页面地址解析(可靠),随任务传给 worker
  // ——dev 里 worker 脚本位于 /src/transcription/,自行相对解析会指错位置
  const modelUrl = new URL('vendor/basic-pitch/model.json', document.baseURI).href
  const wasmBase = new URL('vendor/tfjs-wasm/', document.baseURI).href
  const runMainFallback = async () => {
    dbg.__bpMode = 'main-fallback'
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
    return transcribeWithBasicPitchChannels(
      { ...opts, modelUrl, wasmBase, channels, sampleRate: buffer.sampleRate, duration: buffer.duration },
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
        opts: { ...opts, modelUrl, wasmBase },
        channels,
        sampleRate: buffer.sampleRate,
        duration: buffer.duration,
      },
      onProgress,
      onStage,
    )
  } catch (e) {
    if (String((e as Error)?.message).includes('WEBGL_HANG')) {
      // Worker 的 WebGL 挂死(远程桌面/虚拟显示驱动):整杀重建,先试 WASM(SIMD,不碰 GL),
      // WASM 也不可用再退纯 JS CPU
      if (!getBpWorker()) return runMainFallback()
      dbg.__bpMode = 'worker-wasm'
      onStage('model')
      onProgress(0)
      const channels: Float32Array[] = []
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
      try {
        return await runWorkerJob(
          { type: 'run', opts: { ...opts, modelUrl, wasmBase, forceBackend: 'wasm' }, channels, sampleRate: buffer.sampleRate, duration: buffer.duration },
          onProgress,
          onStage,
        )
      } catch (e2) {
        ;(globalThis as unknown as Record<string, unknown>).__wasmErr = String(e2) + ' | ' + String((e2 as Error)?.stack ?? '').slice(0, 300)
        dbg.__bpMode = 'worker-cpu'
        onStage('model')
        onProgress(0)
        const channels2: Float32Array[] = []
        for (let c = 0; c < buffer.numberOfChannels; c++) channels2.push(buffer.getChannelData(c).slice())
        return runWorkerJob(
          { type: 'run', opts: { ...opts, modelUrl, wasmBase, forceBackend: 'cpu' }, channels: channels2, sampleRate: buffer.sampleRate, duration: buffer.duration },
          onProgress,
          onStage,
        )
      }
    }
    throw e
  }
}
