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

/** 纯 DSP:渲染一个拨弦波形(供 makePluckBuffer 与测试使用,不依赖 AudioContext) */
export function renderPluckSamples(freq: number, sr: number, dur: number, brightness: number): Float32Array {
  // 延迟线长度取整会带来最高十几个音分的失谐(多弦和弦时会"发酸"),
  // 改用小数周期 + 线性插值读出;0.5 为回写一阶平均滤波的群延迟,预先补偿
  const period = sr / freq - 0.5
  const N = Math.max(2, Math.floor(period))
  const frac = Math.min(1, Math.max(0, period - N))
  const total = Math.floor(dur * sr)
  const buf = new Float32Array(total)
  // 阻尼随频率变化:高音弦衰减更快(真实弦的高频耗散更大)
  // 幅度按 damping^(t*freq) 衰减,解出 T60 对应的每周期阻尼
  const T60 = Math.max(1.2, 5.5 * Math.pow(100 / freq, 0.35)) // 低音约 5.5s,高音约 2s
  const damping = Math.exp(-6.9078 / (T60 * freq))
  // 初始激励:白噪声过一阶低通,截止随音高走(约 8 次谐波),低音相对更暗
  const delay = new Float32Array(N + 1)
  let lp = 0
  const a = Math.min(0.9, Math.max(0.06, (2 * Math.PI * 8 * freq) / sr)) * (0.2 + 0.8 * brightness)
  for (let i = 0; i <= N; i++) {
    const w = Math.random() * 2 - 1
    lp += a * (w - lp)
    delay[i] = brightness > 0.98 ? w : lp
  }
  // 激励归一 + 尖峰抑制:高音一个周期只有几十个样本,随机种子的能量/尖峰差异大
  // (输出波峰因子 4-8 随机波动,响度归一化被峰值帽反复打断)。按单位 RMS 归一,
  // 再削掉 ±3σ 外的孤立尖峰;并混入约 1/3 能量的基频正弦——纯噪声对基频的投影
  // 随机起伏会让共鸣能量忽大忽小(响度不稳的根源),正弦成分保证每次都充分起振
  {
    let ex = 0
    for (let i = 0; i <= N; i++) ex += delay[i] * delay[i]
    const exRms = Math.sqrt(ex / (N + 1))
    if (exRms > 1e-9) {
      const g = 1 / exRms
      for (let i = 0; i <= N; i++) {
        let v = delay[i] * g
        if (v > 3) v = 3
        else if (v < -3) v = -3
        delay[i] = v + Math.sin((2 * Math.PI * freq * i) / sr)
      }
      let ex2 = 0
      for (let i = 0; i <= N; i++) ex2 += delay[i] * delay[i]
      const g2 = 1 / Math.sqrt(ex2 / (N + 1))
      for (let i = 0; i <= N; i++) delay[i] *= g2
    }
  }
  let idx = 0
  let prev = delay[N] // 上一圈末位,保证首个样本的回写滤波连续
  for (let n = 0; n < total; n++) {
    const i0 = idx
    const i1 = idx + 1 <= N ? idx + 1 : 0
    const cur = delay[i0] + frac * (delay[i1] - delay[i0])
    buf[n] = cur
    delay[i0] = damping * 0.5 * (cur + prev)
    prev = cur
    idx = i1
  }
  // 去直流:噪声激励原始峰值接近 ±1,六弦扫弦叠加会把限幅器打满造成破音
  let mean = 0
  for (let i = 0; i < total; i++) mean += buf[i]
  mean /= total
  let peak = 0
  // 响度归一化:感知响度 ∝ 起振段 RMS,而非峰值。高音的激励噪声更亮、波形更"尖"
  // (波峰因子大),同等峰值下 RMS 偏低——练耳里"第二个音总偏小"的根源。
  // 统一按前 250ms 的 RMS 归一,并用峰值帽防止个别尖波炸限幅器。
  const win = Math.min(total, Math.floor(sr * 0.25))
  let sumSq = 0
  for (let i = 0; i < total; i++) {
    buf[i] -= mean
    if (i < win) sumSq += buf[i] * buf[i]
    const ab = Math.abs(buf[i])
    if (ab > peak) peak = ab
  }
  const rms = Math.sqrt(sumSq / win)
  // 目标 RMS 要留足峰值余量:KS 高音激励的波峰因子(峰值/RMS)可达 7-8,
  // 目标×波峰因子一旦超过峰值帽,帽子介入会把 RMS 压低且随随机性大幅波动
  const TARGET_RMS = 0.095
  const PEAK_CAP = 0.85
  const scale = Math.min(TARGET_RMS / Math.max(1e-9, rms), PEAK_CAP / Math.max(1e-9, peak))
  if (scale > 0 && isFinite(scale)) {
    for (let i = 0; i < total; i++) buf[i] *= scale
  }
  // 起振 ~2.5ms 软化(消除爆点但保留拨弦瞬态)+ 尾部 60ms 线性淡出
  const fadeIn = Math.min(Math.floor(sr * 0.0025), Math.floor(total / 8))
  for (let i = 0; i < fadeIn; i++) buf[i] *= i / fadeIn
  const fade = Math.min(Math.floor(sr * 0.06), Math.floor(total / 2))
  for (let i = 0; i < fade; i++) {
    const g = 1 - i / fade
    buf[total - 1 - i] *= g
  }
  return buf
}

function makePluckBuffer(freq: number, sr: number, dur: number, brightness: number): AudioBuffer {
  const buf = renderPluckSamples(freq, sr, dur, brightness)
  const out = getCtx().createBuffer(1, buf.length, sr)
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

  /** 扫弦:多个频率按顺序错开触发。dir=1 从低到高,-1 从高到低;带轻微时间/力度抖动模拟手感 */
  static strum(freqs: number[], when?: number, spread = 0.012, opts: PluckOptions = {}) {
    const ctx = getCtx()
    const t0 = when ?? ctx.currentTime + 0.02
    const list = opts.dir === -1 ? [...freqs].reverse() : freqs
    list.forEach((f, i) => {
      const tj = i === 0 ? 0 : (Math.random() - 0.5) * 0.006
      const gj = 1 + (Math.random() - 0.5) * 0.15
      GuitarSynth.pluck(f, {
        ...opts,
        when: t0 + i * spread + tj,
        gain: (opts.gain ?? 0.4) * (1 - i * 0.04) * gj,
      })
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
