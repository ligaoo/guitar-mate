// 迭代 radix-2 FFT 与频谱特征
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  // 位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  return w
}

/** 单帧幅度谱(长度 n/2) */
export function frameSpectrum(buf: Float32Array, win: Float32Array): Float32Array {
  const n = win.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let i = 0; i < Math.min(n, buf.length); i++) re[i] = buf[i] * win[i]
  fft(re, im)
  const mag = new Float32Array(n / 2)
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (n / 4)
  return mag
}

/** 频谱质心 (Hz) */
export function spectralCentroid(mag: Float32Array, sr: number, fftSize: number): number {
  let num = 0
  let den = 0
  for (let i = 1; i < mag.length; i++) {
    const f = (i * sr) / fftSize
    num += f * mag[i]
    den += mag[i]
  }
  return den > 0 ? num / den : 0
}

/** 频谱滚降点 (Hz):累计能量达到总能量 ratio 的频率 */
export function spectralRolloff(mag: Float32Array, sr: number, fftSize: number, ratio = 0.85): number {
  let total = 0
  for (let i = 1; i < mag.length; i++) total += mag[i]
  if (total <= 0) return 0
  let acc = 0
  for (let i = 1; i < mag.length; i++) {
    acc += mag[i]
    if (acc >= total * ratio) return (i * sr) / fftSize
  }
  return ((mag.length - 1) * sr) / fftSize
}

/** 频谱平坦度(几何均值/算术均值) */
export function spectralFlatness(mag: Float32Array): number {
  let logSum = 0
  let sum = 0
  let n = 0
  for (let i = 1; i < mag.length; i++) {
    const v = mag[i] + 1e-12
    logSum += Math.log(v)
    sum += v
    n++
  }
  if (n === 0 || sum === 0) return 0
  return Math.exp(logSum / n) / (sum / n)
}

/** 在频谱中找最接近目标频率的局部峰值幅度。
 * 搜索窗随谐波收紧:高次谐波间隔不变,窗过宽会跨到相邻谐波 */
export function harmonicAmplitude(mag: Float32Array, sr: number, fftSize: number, freq: number, f0 = freq): number {
  const bin = Math.round((freq * fftSize) / sr)
  // 窗口上限取 0.45*f0(对应频宽),避免高次谐波互相污染
  const maxSpan = Math.max(1, Math.round(((0.45 * f0) * fftSize) / sr))
  const search = Math.max(1, Math.min(Math.round(bin * 0.08), maxSpan))
  let best = 0
  for (let i = Math.max(1, bin - search); i <= Math.min(mag.length - 1, bin + search); i++) {
    if (mag[i] > best) best = mag[i]
  }
  return best
}
