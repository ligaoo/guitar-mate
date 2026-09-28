// 全局 AudioContext 单例与主输出链
let ctx: AudioContext | null = null
let masterGain: GainNode | null = null

export function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    masterGain = ctx.createGain()
    masterGain.gain.value = 0.9
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 6
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.15
    masterGain.connect(limiter)
    limiter.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export function getMaster(): GainNode {
  getCtx()
  return masterGain!
}

export function setMasterVolume(v: number) {
  getMaster().gain.value = v
}
