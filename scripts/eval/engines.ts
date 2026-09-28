// 扒谱评估:在 Node 里驱动真实识别引擎
//
// 这里刻意复用 src/ 里的真实实现(transcribe / evaluateChunked / postProcessFrames),
// 而不是另写一份简化版——否则评估的是"我重写的东西",不是产品实际跑的东西。

import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { transcribe, toMono, resampleLinear, SR, type RawNote } from '../../src/transcription/pipeline'
import {
  evaluateChunked,
  postProcessFrames,
  ensureBackend,
  getModel,
  type BpOptions,
} from '../../src/transcription/basicPitch'

export interface EngineOutput {
  notes: RawNote[]
  bpm: number
  offset: number
  duration: number
  bpmStrength?: number
  likelyPolyphonic?: boolean
}

export type EngineId = 'dsp' | 'bp'

/** DSP 单音管线(纯函数,直接调用) */
export function runDspEngine(channels: Float32Array[], sampleRate: number): EngineOutput {
  const mono = toMono(channels, channels[0].length)
  const r = transcribe(mono, sampleRate)
  return {
    notes: r.notes,
    bpm: r.bpm,
    offset: r.offset,
    duration: r.duration,
    bpmStrength: r.bpmStrength,
    likelyPolyphonic: r.likelyPolyphonic,
  }
}

// ---- Basic Pitch:Node 下用本地静态服务把模型喂给 tfjs ----

let modelServer: Server | null = null
let modelUrl = ''

async function ensureModelServer(root: string): Promise<string> {
  if (modelServer) return modelUrl
  const dir = join(root, 'public', 'vendor', 'basic-pitch')
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '')
    try {
      const buf = await readFile(join(dir, rel))
      res.setHeader('content-type', rel.endsWith('.json') ? 'application/json' : 'application/octet-stream')
      res.end(buf)
    } catch {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  modelServer = server
  modelUrl = `http://127.0.0.1:${port}/model.json`
  return modelUrl
}

export function closeModelServer() {
  modelServer?.close()
  modelServer = null
  modelUrl = ''
}

/**
 * Basic Pitch 全链路(与 transcribeWithBasicPitchChannels 同构):
 * toMono → 重采样 22050 → 60s 分块推理 → 真实后处理(音域限频/八度重影/包络 BPM)
 */
export async function runBpEngine(
  channels: Float32Array[],
  sampleRate: number,
  root: string,
  opts: BpOptions = {},
): Promise<EngineOutput> {
  const url = await ensureModelServer(root)
  await ensureBackend(true) // Node 无 WebGL,走 CPU
  const bp = await getModel(url)
  const mono = toMono(channels, channels[0].length)
  const resampled = resampleLinear(mono, sampleRate, SR)
  const duration = resampled.length / SR
  const { frames, onsets } = await evaluateChunked(bp, resampled, () => {})
  const r = await postProcessFrames(frames, onsets, opts, duration)
  return {
    notes: r.notes,
    bpm: r.bpm,
    offset: r.offset,
    duration,
    bpmStrength: r.bpmStrength,
  }
}

/** 引擎默认参数:与页面默认值保持一致(TranscribePage 的 onsetThresh 0.35 / frameThresh 0.2) */
export const BP_DEFAULTS: BpOptions = {
  onsetThresh: 0.35,
  frameThresh: 0.2,
  removeOctaveGhosts: true,
}
