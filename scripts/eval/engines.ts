// 扒谱评估:在 Node 里驱动真实识别引擎
//
// 这里刻意复用 src/ 里的真实实现(transcribe / evaluateChunked / postProcessFrames),
// 而不是另写一份简化版——否则评估的是"我重写的东西",不是产品实际跑的东西。

import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { transcribe, toMono, resampleLinear, estimateOnsets, SR, type RawNote, type TranscribeOptions } from '../../src/transcription/pipeline'
import {
  evaluateChunked,
  postProcessFrames,
  ensureBackend,
  getModel,
  bpPreset,
  type BpOptions,
} from '../../src/transcription/basicPitch'
import { estimateTuningFromPcm } from '../../src/transcription/tuning'
import { refineBpm, quantizeNotes, type QuantizedNote } from '../../src/transcription/quantize'
import { assignFingering, type TabNote, type DroppedNote } from '../../src/transcription/fingering'
import { detectKey } from '../../src/transcription/cleanup'

export interface EngineOutput {
  notes: RawNote[]
  bpm: number
  offset: number
  duration: number
  bpmStrength?: number
  likelyPolyphonic?: boolean
  tuningCents?: number
  /** 起音对时实际移动的音符数(BP 路径) */
  retimed?: number
  /** 音符起点序列(量化锚点/产品链路用) */
  onsets?: number[]
}

export type EngineId = 'dsp' | 'bp' | 'ext'

/** DSP 单音管线(纯函数,直接调用) */
export function runDspEngine(channels: Float32Array[], sampleRate: number, opts: TranscribeOptions = {}): EngineOutput {
  const mono = toMono(channels, channels[0].length)
  const r = transcribe(mono, sampleRate, opts)
  return {
    notes: r.notes,
    bpm: r.bpm,
    offset: r.offset,
    duration: r.duration,
    bpmStrength: r.bpmStrength,
    likelyPolyphonic: r.likelyPolyphonic,
    tuningCents: r.tuningCents,
    onsets: r.onsets,
  }
}

// ---- Basic Pitch:Node 下用本地静态服务把模型喂给 tfjs ----

let modelServer: Server | null = null
let modelUrl = ''

/** 本地静态服务:把 public/vendor/basic-pitch 下的模型喂给 tfjs(Node 没有 fetch 相对路径的能力)。
 *  导出给离线扒谱命令复用,保证命令行与评测/页面走同一份模型加载逻辑。 */
export async function ensureModelServer(root: string): Promise<string> {
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
 * toMono → 重采样 22050 → 60s 分块推理 → 真实后处理(音域限频/八度重影/起音对时/包络 BPM)
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
  // 音准偏移在推理前物理测量(与 transcribeWithBasicPitchChannels 的做法一致)
  if (opts.autoTune !== false && opts.tuningCents === undefined) {
    const tune = estimateTuningFromPcm(resampled, SR)
    opts = { ...opts, tuningCents: tune ? Math.round(tune.semis * 100) : 0 }
  }
  // 起音对时:与产品一致,用同一份音频算 DSP 起音表(实测偏差 ≤3.4ms)
  if (opts.retime !== false && !opts.retimeOnsets) {
    opts = { ...opts, retimeOnsets: estimateOnsets(resampled, SR) }
  }
  const { frames, onsets } = await evaluateChunked(bp, resampled, () => {})
  const r = await postProcessFrames(frames, onsets, opts, duration)
  return {
    notes: r.notes,
    bpm: r.bpm,
    offset: r.offset,
    duration,
    bpmStrength: r.bpmStrength,
    tuningCents: r.tuningCents,
    retimed: r.retimed,
    onsets: r.onsets,
  }
}

/** 引擎默认参数(旧版):保留给"复现历史留档"用。
 *  新默认值起点是 BP_PRESETS(见 ACCURACY.md §2.1),页面与评测都从预设取。 */
export const BP_DEFAULTS: BpOptions = {
  onsetThresh: 0.35,
  frameThresh: 0.2,
  removeOctaveGhosts: true,
}

/** 按样例构成挑预设:含非吉他轨(鼓/贝斯/人声)→ 混音预设,否则独奏预设。
 *  真实 GuitarSet 是无伴奏独奏,合成 fixture 的 full-mix 族含其它乐器。 */
export function presetForClip(hasOtherInstruments: boolean): BpOptions {
  const p = bpPreset(hasOtherInstruments ? 'mix' : 'solo')
  return {
    onsetThresh: p.onsetThresh,
    frameThresh: p.frameThresh,
    minNoteLenFrames: p.minNoteLenFrames,
    melodiaTrick: p.melodiaTrick,
    removeOctaveGhosts: true,
    retime: true,
  }
}

// ---------- 产品链路(与 TranscribePage.rebuild 同构)----------

export interface ProductPipelineResult {
  /** 量化后的格点音符(时间轴被吸附) */
  quant: QuantizedNote[]
  /** 指法分配结果(用户看到的六线谱) */
  tab: TabNote[]
  dropped: DroppedNote[]
  /** 实际用于量化的 BPM(引擎值或 refineBpm 细化值) */
  bpmUsed: number
  /** 量化锚点(秒) */
  anchor: number
}

/**
 * 把引擎输出走一遍产品链路:refineBpm → quantizeNotes → assignFingering。
 * 评测里用它报告"用户最终看到的谱面"准确率(而不是识别阶段的乐观上界)。
 */
export function runProductPipeline(
  out: EngineOutput,
  tuning: number[],
  maxFret: number,
  opts: { minConf?: number; autoDensity?: boolean; keyFilter?: boolean; preset?: boolean } = {},
): ProductPipelineResult {
  const starts = out.notes.map((n) => n.start)
  // 与页面一致:节拍锁定度高就用引擎 BPM,否则用网格搜索细化
  const bpmUsed = out.bpmStrength && out.bpmStrength > 0.2 ? out.bpm : refineBpm(starts, out.bpm)
  const key = opts.keyFilter === false ? null : detectKey(out.notes)
  const q = quantizeNotes(
    out.notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi, confidence: n.confidence })),
    out.duration,
    {
      bpm: bpmUsed,
      anchor: out.offset,
      minConf: opts.minConf ?? 0,
      autoDensity: opts.autoDensity ?? false,
      keyFilter: opts.keyFilter ? key : null,
    },
  )
  const { notes: tab, dropped } = assignFingering(q.notes, tuning, maxFret)
  return { quant: q.notes, tab, dropped, bpmUsed, anchor: q.anchor }
}

/**
 * 外部引擎适配器:评分「在别处推理」的结果(MT3 / 微调模型 / 任何转录器)。
 * 目录下放 <clipId>.<variant>.json,格式:
 *   { "notes": [{ "start": 秒, "end": 秒, "midi": 整数 }], "bpm"?: 数字 }
 * 用 --export-wav 导出音频 → 外部引擎吃 WAV → 结果放回本目录 → --engine=ext 评分。
 */
export async function runExtEngine(clipId: string, variant: string, dir: string): Promise<EngineOutput> {
  const p = join(dir, `${clipId}.${variant}.json`)
  let raw: string
  try {
    raw = await readFile(p, 'utf8')
  } catch {
    throw new Error(`缺少外部引擎结果 ${p}`)
  }
  const parsed = JSON.parse(raw) as {
    notes: { start: number; end?: number; midi: number; confidence?: number }[]
    bpm?: number
  }
  const notes: RawNote[] = parsed.notes
    .map((n) => ({
      start: n.start,
      end: n.end ?? n.start + 0.2,
      midi: Math.round(n.midi),
      confidence: n.confidence ?? 0.7,
      velocity: n.confidence ?? 0.7,
    }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi)
  return {
    notes,
    bpm: parsed.bpm ?? 0,
    offset: notes.length ? notes[0].start : 0,
    duration: 0,
  }
}
