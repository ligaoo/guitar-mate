// 麦克风录音与音频文件解码
import { getCtx } from './engine'

export class MicRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  analyser: AnalyserNode | null = null
  private srcNode: MediaStreamAudioSourceNode | null = null

  async start(): Promise<void> {
    const ctx = getCtx()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    this.srcNode = ctx.createMediaStreamSource(this.stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.5
    this.srcNode.connect(this.analyser) // 只接 analyser,避免监听回环
    this.chunks = []
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined)
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.start(200)
  }

  get running(): boolean {
    return this.recorder?.state === 'recording'
  }

  async stop(): Promise<AudioBuffer> {
    const rec = this.recorder
    if (!rec) throw new Error('未在录音')
    const done = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }))
    })
    rec.stop()
    const blob = await done
    this.cleanup()
    return await decodeBlob(blob)
  }

  /** 只停流不取结果(取消录音) */
  abort(): void {
    try {
      this.recorder?.stop()
    } catch {
      /* ignore */
    }
    this.cleanup()
  }

  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.recorder = null
    this.srcNode?.disconnect()
    this.srcNode = null
  }
}

export async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const arr = await blob.arrayBuffer()
  return await getCtx().decodeAudioData(arr)
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  return await decodeBlob(file)
}
