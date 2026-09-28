// Basic Pitch 常驻 Worker:
//   'run'       = 全管线(推理 + 后处理)
//   'runChunk'  = 仅推理一块 PCM(并行 CPU 模式,临时 worker 调用)
//   'postFrames'= 仅重后处理(并行模式汇总帧矩阵后调用)
import { transcribeWithBasicPitchChannels, postProcessFrames, ensureBackend, getModule, getModel, type BpOptions } from './basicPitch'

self.onmessage = async (e: MessageEvent) => {
  const { type, id, opts, channels, sampleRate, duration, pcm, frames, onsets } = e.data ?? {}
  const post = (msg: object) => (self as unknown as Worker).postMessage({ id, ...msg })
  try {
    if (type === 'run') {
      const result = await transcribeWithBasicPitchChannels(
        { ...(opts as BpOptions), channels, sampleRate, duration },
        (p) => post({ type: 'progress', p }),
        (stage, info) => post({ type: 'stage', stage, info }),
      )
      post({ type: 'done', result })
    } else if (type === 'runChunk') {
      // 并行分块推理:CPU 后端 + 单块 PCM,直接返回帧矩阵(名义帧裁剪由主线程做)
      const backend = await ensureBackend(true)
      await getModule()
      const bp = await getModel((opts as BpOptions)?.modelUrl)
      post({ type: 'stage', stage: 'model', info: backend })
      const cf: number[][] = []
      const co: number[][] = []
      await bp.evaluateModel(
        pcm,
        (f, o) => {
          for (let i = 0; i < f.length; i++) {
            cf.push(f[i])
            co.push(o[i])
          }
        },
        (p) => post({ type: 'progress', p }),
      )
      post({ type: 'done', frames: cf, onsets: co })
    } else if (type === 'postFrames') {
      post({ type: 'stage', stage: 'notes' })
      const result = await postProcessFrames(frames, onsets, opts as BpOptions, duration)
      post({ type: 'done', result })
    }
  } catch (err) {
    post({ type: 'error', message: String(err) })
  }
}
