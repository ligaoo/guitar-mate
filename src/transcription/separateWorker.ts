// 音源分离 Worker:整首歌 → 吉他优先信号 / 打击乐 / 低频 三个 stem
// 跑在 Worker 里,避免 HPSS 的中值滤波(~秒级)冻结页面
import { separateDsp, type SeparationOptions } from './separation'

self.onmessage = (e: MessageEvent) => {
  const { type, channels, sampleRate, opts } = e.data ?? {}
  if (type !== 'separate') return
  const post = (msg: object, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? [])
  try {
    const stems = separateDsp(channels as Float32Array[], sampleRate as number, {
      ...(opts as SeparationOptions),
      onProgress: (p) => post({ type: 'progress', p }),
    })
    post(
      { type: 'done', guitar: stems.guitar, percussive: stems.percussive, bass: stems.bass, info: stems.info },
      [...stems.guitar, ...stems.percussive, ...stems.bass].map((a) => a.buffer),
    )
  } catch (err) {
    post({ type: 'error', message: String(err) })
  }
}
