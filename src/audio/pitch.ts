// YIN 音高检测(单音,适合调音器与逐帧 f0 跟踪)
export interface PitchResult {
  freq: number // Hz,0 表示无
  prob: number // 0-1 置信度
  rms: number
}

export function rms(buf: Float32Array): number {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

/** YIN 复用暂存区:高频调用(调音器/逐帧跟踪)时避免每次分配两个大数组 */
export interface YinScratch {
  d: Float32Array
  dp: Float32Array
}

export function makeYinScratch(frameLength: number, sr: number, fmin = 65): YinScratch {
  const tauMax = Math.min(Math.floor(frameLength / 2) - 1, Math.ceil(sr / fmin))
  return { d: new Float32Array(tauMax + 1), dp: new Float32Array(tauMax + 1) }
}

export function yin(
  buf: Float32Array,
  sr: number,
  threshold = 0.15,
  fmin = 65,
  fmax = 1400,
  scratch?: YinScratch,
): PitchResult {
  const r = rms(buf)
  if (r < 1e-4) return { freq: 0, prob: 0, rms: r }
  const tauMin = Math.max(2, Math.floor(sr / fmax))
  const tauMax = Math.min(Math.floor(buf.length / 2) - 1, Math.ceil(sr / fmin))
  if (tauMax <= tauMin) return { freq: 0, prob: 0, rms: r }

  // 差分函数 d(tau) —— 复用调用方提供的暂存区
  const d = scratch && scratch.d.length > tauMax ? scratch.d : new Float32Array(tauMax + 1)
  const W = buf.length - tauMax
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau]
      sum += diff * diff
    }
    d[tau] = sum
  }
  // 累积均值归一化 d'(tau)
  const dp = scratch && scratch.dp.length > tauMax ? scratch.dp : new Float32Array(tauMax + 1)
  dp[tauMin] = 1
  let running = 0
  for (let tau = tauMin + 1; tau <= tauMax; tau++) {
    running += d[tau]
    dp[tau] = (d[tau] * (tau - tauMin + 1)) / running || 1
  }
  // 绝对阈值:第一个低于 threshold 的局部最小
  let tauEst = -1
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (dp[tau] < threshold) {
      while (tau + 1 < tauMax && dp[tau + 1] < dp[tau]) tau++
      tauEst = tau
      break
    }
  }
  if (tauEst < 0) {
    // 退而求其次:全局最小(置信度打折)
    let best = tauMin + 1
    for (let tau = tauMin + 1; tau < tauMax; tau++) if (dp[tau] < dp[best]) best = tau
    if (dp[best] > 0.6) return { freq: 0, prob: 0, rms: r }
    tauEst = best
  }
  // 抛物线插值细化
  let betterTau = tauEst
  if (tauEst > tauMin && tauEst < tauMax) {
    const s0 = dp[tauEst - 1]
    const s1 = dp[tauEst]
    const s2 = dp[tauEst + 1]
    const denom = 2 * (2 * s1 - s2 - s0)
    if (denom !== 0) betterTau = tauEst + (s2 - s0) / denom
  }
  const freq = sr / betterTau
  if (freq < fmin || freq > fmax) return { freq: 0, prob: 0, rms: r }
  const prob = Math.max(0, Math.min(1, 1 - dp[tauEst]))
  return { freq, prob, rms: r }
}
