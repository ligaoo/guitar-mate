// Basic Pitch 常驻 Worker:接收 PCM 通道数据,回传进度/阶段/结果
// 模型与 TF.js 后端在 worker 内只初始化一次,后续任务复用
import { transcribeWithBasicPitchChannels, type BpOptions } from './basicPitch'

self.onmessage = async (e: MessageEvent) => {
  const { type, id, opts, channels, sampleRate, duration } = e.data ?? {}
  if (type !== 'run') return
  const post = (msg: object) => (self as unknown as Worker).postMessage({ id, ...msg })
  try {
    const result = await transcribeWithBasicPitchChannels(
      { ...(opts as BpOptions), channels, sampleRate, duration },
      (p) => post({ type: 'progress', p }),
      (stage, info) => post({ type: 'stage', stage, info }),
    )
    post({ type: 'done', result })
  } catch (err) {
    post({ type: 'error', message: String(err) })
  }
}
