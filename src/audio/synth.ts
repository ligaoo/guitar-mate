// Karplus-Strong 拨弦合成器:离线生成波形 buffer,音色接近吉他拨弦
import { midiToFreq } from '../theory/notes'
import { getCtx, getMaster } from './engine'

export interface PluckOptions {
  when?: number // 绝对开始时间(秒);默认立即
  dur?: number // 持续(秒)
  gain?: number // 0-1
  brightness?: number // 0-1 初始噪声亮度
  dir?: number // 扫弦方向:1 下行(低→高),-1 上行
}

const bufferCache = new Map<string, AudioBuffer>()
const CACHE_LIMIT = 220

function makePluckBuffer(freq: number, sr: number, dur: number, brightness: number): AudioBuffer {
  const N = Math.max(2, Math.round(sr / freq))
  const total = Math.floor(dur * sr)
  const buf = new Float32Array(total)
  // 阻尼随频率变化:高音弦衰减更快(真实弦的高频耗散更大)
  // 幅度按 damping^(t*freq) 衰减,解出 T60 对应的每周期阻尼
  const T60 = Math.max(1.2, 5.5 * Math.pow(100 / freq, 0.35)) // 低音约 5.5s,高音约 2s
  const damping = Math.exp(-6.9078 / (T60 * freq))
  // 初始激励:白噪声过一阶低通,截止随音高走(约 8 次谐波),低音相对更暗
  const delay = new Float32Array(N)
  let lp = 0
  const a = Math.min(0.9, Math.max(0.06, (2 * Math.PI * 8 * freq) / sr)) * (0.2 + 0.8 * brightness)
  for (let i = 0; i < N; i++) {
    const w = Math.random() * 2 - 1
    lp += a * (w - lp)
    delay[i] = brightness > 0.98 ? w : lp
  }
  let idx = 0
  for (let n = 0; n < total; n++) {
    const cur = delay[idx]
    const nxt = delay[(idx + 1) % N]
    buf[n] = cur
    delay[idx] = damping * 0.5 * (cur + nxt)
    idx = (idx + 1) % N
  }
  // 尾部 60ms 线性淡出
  const fade = Math.min(Math.floor(sr * 0.06), Math.floor(total / 2))
  for (let i = 0; i < fade; i++) {
    const g = 1 - i / fade
    buf[total - 1 - i] *= g
  }
  const out = getCtx().createBuffer(1, total, sr)
  out.copyToChannel(buf, 0)
  return out
}

function pluckBuffer(freq: number, dur: number, brightness: number): AudioBuffer {
  const sr = getCtx().sampleRate
  const key = `${freq.toFixed(2)}|${sr}|${dur}|${brightness}`
  let b = bufferCache.get(key)
  if (!b) {
    b = makePluckBuffer(freq, sr, dur, brightness)
    if (bufferCache.size >= CACHE_LIMIT) {
      const first = bufferCache.keys().next().value
      if (first) bufferCache.delete(first)
    }
    bufferCache.set(key, b)
  }
  return b
}

export class GuitarSynth {
  /** 拨一个频率,返回可提前 stop 的源节点 */
  static pluck(freq: number, opts: PluckOptions = {}): AudioBufferSourceNode {
    const ctx = getCtx()
    const dur = opts.dur ?? 2.5
    const brightness = opts.brightness ?? 0.7
    const buf = pluckBuffer(freq, dur, brightness)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.value = opts.gain ?? 0.5
    src.connect(g)
    g.connect(getMaster())
    src.start(opts.when ?? ctx.currentTime + 0.01)
    return src
  }

  static pluckMidi(midi: number, opts: PluckOptions = {}): AudioBufferSourceNode {
    return GuitarSynth.pluck(midiToFreq(midi), opts)
  }

  /** 扫弦:多个频率按顺序错开触发。dir=1 从低到高,-1 从高到低 */
  static strum(freqs: number[], when?: number, spread = 0.012, opts: PluckOptions = {}) {
    const ctx = getCtx()
    const t0 = when ?? ctx.currentTime + 0.02
    const list = opts.dir === -1 ? [...freqs].reverse() : freqs
    list.forEach((f, i) => {
      GuitarSynth.pluck(f, { ...opts, when: t0 + i * spread, gain: (opts.gain ?? 0.4) * (1 - i * 0.03) })
    })
  }

  static strumMidis(midis: number[], when?: number, spread = 0.012, opts: PluckOptions = {}) {
    GuitarSynth.strum(midis.map(midiToFreq), when, spread, opts)
  }

  /** 简单节拍器咔哒声,返回可提前 stop 的振荡器 */
  static click(when?: number, strong = false, gain = 0.5): OscillatorNode {
    const ctx = getCtx()
    const t = when ?? ctx.currentTime + 0.01
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = strong ? 1600 : 1100
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035)
    osc.connect(g)
    g.connect(getMaster())
    osc.start(t)
    osc.stop(t + 0.05)
    return osc
  }
}
