// 扒谱 Worker:接收音频,返回识别结果(避免 DSP 卡 UI)
import { transcribe } from './pipeline'

self.onmessage = (e: MessageEvent) => {
  const { type, channel, sampleRate } = e.data
  if (type !== 'transcribe') return
  try {
    const result = transcribe(channel as Float32Array, sampleRate as number)
    ;(self as unknown as Worker).postMessage({ type: 'done', result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ type: 'error', message: String(err) })
  }
}
