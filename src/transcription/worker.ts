// 扒谱 Worker:接收音频,返回识别结果(避免 DSP 卡 UI)
import { transcribe } from './pipeline'

self.onmessage = (e: MessageEvent) => {
  const { type, channel, sampleRate, bpmHint, lowestMidi, highestMidi } = e.data
  if (type !== 'transcribe') return
  try {
    const result = transcribe(channel as Float32Array, sampleRate as number, {
      bpmHint: bpmHint as number | undefined,
      // 音域按当前调弦 + 最高品传入:旧实现硬编码 40..88,把 Drop D 的 D2 变成了 E2
      lowestMidi: lowestMidi as number | undefined,
      highestMidi: highestMidi as number | undefined,
    })
    ;(self as unknown as Worker).postMessage({ type: 'done', result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ type: 'error', message: String(err) })
  }
}
