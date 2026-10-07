// 扒谱前置编排:把 AudioBuffer 送进分离 Worker,取「吉他优先」stem 回来
//
// 关键约束:输出 AudioBuffer 与输入的 长度 / 采样率 完全一致,
// 这样下游所有时间换算(A/B 对比、定位选中音、片段偏移)不需要任何改动。

import { getCtx } from '../audio/engine'
import type { SeparationOptions, Stems } from './separation'
import { compensateLevelInPlace, extractBassNotes, percussiveBpmHint, type BassNote } from './separation'

export interface SeparatedBuffer {
  /** 吉他优先信号(等长、等采样率,已峰值归一) */
  buffer: AudioBuffer
  /** 各 stem 的能量占比,用于 UI 提示分离是否真的起作用 */
  energy: { guitar: number; percussive: number; bass: number; total: number }
  info: Stems['info']
  /** 鼓茎包络自相关估出的 BPM(锁定不住时为 undefined):传给识别引擎作 bpmHint */
  bpmHint?: number
  /** 贝斯茎的单音线:传给识别引擎修剪贝斯谐波造成的八度幽灵 */
  bassNotes?: BassNote[]
  /** 施加的电平补偿增益(1 = 未补偿),用于 UI 提示 */
  levelGain: number
}

function rms(chs: Float32Array[]): number {
  let s = 0
  let n = 0
  for (const ch of chs) {
    for (let i = 0; i < ch.length; i++) {
      s += ch[i] * ch[i]
      n++
    }
  }
  return n > 0 ? Math.sqrt(s / n) : 0
}

/** 在 Worker 中做音源分离。取消时传 signal 更干净,这里用 terminate 由调用方负责。 */
export function separateBuffer(
  source: AudioBuffer,
  opts: SeparationOptions,
  onProgress: (p: number) => void,
): { promise: Promise<SeparatedBuffer>; cancel: () => void } {
  const channels: Float32Array[] = []
  for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c).slice())

  let worker: Worker
  try {
    worker = new Worker(new URL('./separateWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return { promise: Promise.reject(new Error('WORKER_UNAVAILABLE')), cancel: () => {} }
  }

  const promise = new Promise<SeparatedBuffer>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const { type, p, guitar, percussive, bass, info, message } = e.data ?? {}
      if (type === 'progress') {
        onProgress(typeof p === 'number' ? p : 0)
        return
      }
      worker.terminate()
      if (type === 'error') {
        reject(new Error(message))
        return
      }
      const g = guitar as Float32Array[]
      const pStem = percussive as Float32Array[]
      const bStem = bass as Float32Array[]
      const eG = rms(g)
      const eP = rms(pStem)
      const eB = rms(bStem)
      // 只在电平明显偏轻时向上补偿(条件式;正常素材恒等变换,实测峰值归一是负收益)
      const gain = compensateLevelInPlace(g)
      const ctx = getCtx()
      const out = ctx.createBuffer(Math.max(1, g.length), g[0]?.length ?? 0, source.sampleRate)
      for (let c = 0; c < out.numberOfChannels; c++) out.copyToChannel(g[Math.min(c, g.length - 1)], c)
      // 分离副产品就地再利用:鼓轨 → BPM 提示,贝斯轨 → 八度幽灵参照。
      // 都在主线程做(分离已在 Worker 完成重活,这两步是轻量扫描)。
      const sr = (info as Stems['info']).sampleRate || source.sampleRate
      resolve({
        buffer: out,
        energy: { guitar: eG, percussive: eP, bass: eB, total: eG + eP + eB },
        info: info as Stems['info'],
        bpmHint: percussiveBpmHint(pStem, sr) ?? undefined,
        bassNotes: extractBassNotes(bStem, sr),
        levelGain: gain,
      })
    }
    worker.onerror = (err) => {
      worker.terminate()
      reject(new Error(err.message || '分离 Worker 崩溃'))
    }
    worker.postMessage(
      { type: 'separate', channels, sampleRate: source.sampleRate, opts },
      channels.map((c) => c.buffer),
    )
  })

  return { promise, cancel: () => worker.terminate() }
}
