// 音源分离:扒谱前置处理
//
// 目标不是"高保真分轨",而是给识别引擎一个更干净的输入。三条互补的手段:
//
//   ① HPSS(谐波/打击乐中值滤波分离)
//      鼓是宽带瞬态,是伪起音的主要来源;吉他/贝斯/人声是稳态谐波。
//      在幅度谱上分别沿时间轴(谐波)与频率轴(打击乐)取中值,得到软掩码。
//
//   ② 中/侧(M/S)分解
//      真实混音里双轨吉他分居左右,居中的是人声/贝斯/底鼓/军鼓。
//      侧向信号天然压低居中内容,且能完整保留硬左右的内容。
//
//   ③ 分段频谱整形
//      贝斯基频(E1≈41Hz)本身超出模型音域会被直接切掉,但它的 2-5 次谐波
//      正落在吉他音区,会变成"高八度幽灵音"——这是"调性过滤"之前最大的错音来源。
//      这里对吉他轨做低频切除,并把低频成分单独导出。
//
// 局限(必须说清楚):把"居中的人声"和"居中的吉他"真正分开需要学习型模型
// (Demucs/htdemucs 等)。本模块给出 SeparationBackend 接口,模型后端可后插;
// 离线 DSP 后端不需要任何模型下载,今天就能用,对"去鼓 / 降贝斯 / 恢复双轨吉他"有效。
//
// M/S↔L/R 是严格无损的(L=M+S, R=M-S):掩码对 M 与 S 分别施加后合成,
// 因此对硬左右声像的内容不会引入增益或相位误差。

import { fftInPlace } from './pipeline'

function ifftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]
  fftInPlace(re, im)
  for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] = -im[i] / n
  }
}

/** FFT 尺寸取「不小于 sr/21.5 的 2 的幂」:22050 → 2048(≈10.8Hz),44100/48000 → 4096 */
function stftSizeFor(sampleRate: number): number {
  const want = sampleRate / 21.5
  let n = 256
  while (n < want && n < 8192) n <<= 1
  return n
}

const TIME_WIN = 17 // 谐波方向中值窗(帧)
const FREQ_WIN = 17 // 打击乐方向中值窗(频点)
const BLOCK_SEC = 30 // 分块处理时长,控制单块内存

export interface SeparationOptions {
  /** 中置抑制强度 0-1(默认 0.6):双轨吉他分居左右的混音开启;居中吉他/独奏请设为 0 */
  centerSuppress?: number
  /** 谐波/打击乐分离(去鼓),默认 true */
  percussiveRemoval?: boolean
  /** 吉他轨低频切除(Hz,默认 70):去掉贝斯基频与隆隆声 */
  lowCutHz?: number
  /** 低频成分上界(Hz,默认 250):bass 轨的频段 */
  bassBandHz?: number
  onProgress?: (p: number) => void
}

export interface Stems {
  /** 吉他优先信号 [L, R] */
  guitar: Float32Array[]
  /** 打击乐成分 [L, R]:鼓,可用于节奏轨 */
  percussive: Float32Array[]
  /** 低频谐波成分 [L, R]:贝斯(近似) */
  bass: Float32Array[]
  info: {
    sampleRate: number
    fftSize: number
    frames: number
    centerSuppress: number
    percussiveRemoval: boolean
    lowCutHz: number
  }
}

/** 可插拔后端:离线 DSP 后端已实现;模型后端(Demucs ONNX)按同一接口接入 */
export interface SeparationBackend {
  id: string
  label: string
  requiresModel: boolean
  separate(channels: Float32Array[], sampleRate: number, opts?: SeparationOptions): Promise<Stems>
}

/** 小数组中值(插入排序);n 通常 ≤17 */
function medianInPlace(buf: Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buf[i]
    let j = i - 1
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j]
      j--
    }
    buf[j + 1] = v
  }
  return buf[n >> 1]
}

/** 平滑阶跃:窗口 [lo, hi] 从 0 升到 1,避免砖墙掩码造成振铃 */
function ramp(x: number, lo: number, hi: number): number {
  if (x <= lo) return 0
  if (x >= hi) return 1
  const t = (x - lo) / (hi - lo)
  return t * t * (3 - 2 * t)
}

function fillHermitian(
  re: Float32Array,
  im: Float32Array,
  br: Float32Array,
  bi: Float32Array,
  N: number,
  bins: number,
): void {
  for (let k = 0; k < bins; k++) {
    br[k] = re[k]
    bi[k] = im[k]
  }
  for (let k = bins; k < N; k++) {
    const m = N - k
    br[k] = re[m]
    bi[k] = -im[m]
  }
}

/** 把掩码同时施加到 M 与 S,逆变换后分别加窗重叠累加到 accM / accS */
function applyMask(
  reM: Float32Array,
  imM: Float32Array,
  reS: Float32Array,
  imS: Float32Array,
  base: number,
  bins: number,
  mask: Float32Array,
  accM: Float32Array,
  accS: Float32Array,
  off: number,
  padLen: number,
  win: Float32Array,
  N: number,
  mre: Float32Array,
  mim: Float32Array,
  sre: Float32Array,
  sim: Float32Array,
  br: Float32Array,
  bi: Float32Array,
): void {
  for (let k = 0; k < bins; k++) {
    const g = mask[k]
    mre[k] = reM[base + k] * g
    mim[k] = imM[base + k] * g
    sre[k] = reS[base + k] * g
    sim[k] = imS[base + k] * g
  }
  fillHermitian(mre, mim, br, bi, N, bins)
  ifftInPlace(br, bi)
  for (let i = 0; i < N; i++) {
    const idx = off + i
    if (idx >= padLen) break
    accM[idx] += br[i] * win[i]
  }
  fillHermitian(sre, sim, br, bi, N, bins)
  ifftInPlace(br, bi)
  for (let i = 0; i < N; i++) {
    const idx = off + i
    if (idx >= padLen) break
    accS[idx] += br[i] * win[i]
  }
}

/**
 * 离线 DSP 分离:HPSS + 中侧 + 分段整形。纯函数,可在 Worker / Node 中运行。
 * channels 为各声道 PCM(等长),返回等长的三个 stem。
 */
export function separateDsp(channels: Float32Array[], sampleRate: number, opts: SeparationOptions = {}): Stems {
  const centerSuppress = Math.max(0, Math.min(1, opts.centerSuppress ?? 0.6))
  const percussiveRemoval = opts.percussiveRemoval !== false
  const lowCutHz = opts.lowCutHz ?? 70
  const bassBandHz = opts.bassBandHz ?? 250
  const onProgress = opts.onProgress

  const len = channels[0]?.length ?? 0
  const L = channels[0]
  const R = channels.length >= 2 ? channels[1] : channels[0]

  const outGuitarL = new Float32Array(len)
  const outGuitarR = new Float32Array(len)
  const outPercL = new Float32Array(len)
  const outPercR = new Float32Array(len)
  const outBassL = new Float32Array(len)
  const outBassR = new Float32Array(len)

  const N = stftSizeFor(sampleRate)
  const hop = N / 4
  const bins = N / 2 + 1
  const binHz = sampleRate / N

  const info = { sampleRate, fftSize: N, frames: 0, centerSuppress, percussiveRemoval, lowCutHz }

  if (len === 0 || !L) {
    return { guitar: [outGuitarL, outGuitarR], percussive: [outPercL, outPercR], bass: [outBassL, outBassR], info }
  }

  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)))

  // 复用缓冲:全部分配在帧循环之外,避免逐帧 GC
  const br = new Float32Array(N)
  const bi = new Float32Array(N)
  const mre = new Float32Array(bins)
  const mim = new Float32Array(bins)
  const sre = new Float32Array(bins)
  const sim = new Float32Array(bins)
  const maskG = new Float32Array(bins)
  const maskP = new Float32Array(bins)
  const maskB = new Float32Array(bins)
  const colScratch = new Float32Array(TIME_WIN)
  const rowScratch = new Float32Array(FREQ_WIN)

  const half = TIME_WIN >> 1
  const fhalf = FREQ_WIN >> 1
  const lowLo = lowCutHz * 0.6
  const lowHi = lowCutHz * 1.6
  const bassLo = bassBandHz * 0.6
  const bassHi = bassBandHz * 1.6

  const blockLen = Math.max(1, Math.floor(BLOCK_SEC * sampleRate))
  const nBlocks = Math.max(1, Math.ceil(len / blockLen))
  let totalFrames = 0

  const mid = new Float32Array(blockLen + N)
  const sid = new Float32Array(blockLen + N)

  for (let b = 0; b < nBlocks; b++) {
    const b0 = b * blockLen
    const b1 = Math.min(len, b0 + blockLen)
    const segLen = b1 - b0
    const padLen = segLen + N
    for (let i = 0; i < padLen; i++) {
      const idx = b0 + i
      const l = idx < len ? L[idx] : 0
      const r = idx < len ? R[idx] : 0
      mid[i] = (l + r) * 0.5
      sid[i] = (l - r) * 0.5
    }
    const nFrames = Math.max(1, Math.ceil(padLen / hop))

    // ---- 1) 复谱(M/S)与幅度谱 ----
    const reM = new Float32Array(nFrames * bins)
    const imM = new Float32Array(nFrames * bins)
    const reS = new Float32Array(nFrames * bins)
    const imS = new Float32Array(nFrames * bins)
    const magM = new Float32Array(nFrames * bins)
    const magS = new Float32Array(nFrames * bins)
    const wsum = new Float32Array(padLen)

    for (let f = 0; f < nFrames; f++) {
      const off = f * hop
      const base = f * bins
      for (let i = 0; i < N; i++) {
        br[i] = (mid[off + i] ?? 0) * win[i]
        bi[i] = 0
      }
      fftInPlace(br, bi)
      for (let k = 0; k < bins; k++) {
        reM[base + k] = br[k]
        imM[base + k] = bi[k]
        magM[base + k] = Math.hypot(br[k], bi[k])
      }
      for (let i = 0; i < N; i++) {
        br[i] = (sid[off + i] ?? 0) * win[i]
        bi[i] = 0
      }
      fftInPlace(br, bi)
      for (let k = 0; k < bins; k++) {
        reS[base + k] = br[k]
        imS[base + k] = bi[k]
        magS[base + k] = Math.hypot(br[k], bi[k])
      }
      for (let i = 0; i < N; i++) {
        const idx = off + i
        if (idx < padLen) wsum[idx] += win[i] * win[i]
      }
    }

    // ---- 2) 谐波中值(沿时间轴):必须整块算完再进入逐帧掩码 ----
    const harmStore = new Float32Array(nFrames * bins)
    for (let k = 0; k < bins; k++) {
      for (let f = 0; f < nFrames; f++) {
        const a = Math.max(0, f - half)
        const c = Math.min(nFrames - 1, f + half)
        let n = 0
        for (let t = a; t <= c; t++) colScratch[n++] = magM[t * bins + k] + magS[t * bins + k]
        harmStore[f * bins + k] = medianInPlace(colScratch, n)
      }
    }

    const accGM = new Float32Array(padLen)
    const accGS = new Float32Array(padLen)
    const accPM = new Float32Array(padLen)
    const accPS = new Float32Array(padLen)
    const accBM = new Float32Array(padLen)
    const accBS = new Float32Array(padLen)

    // ---- 3) 逐帧:打击乐中值(沿频率轴)→ 三个掩码 → 掩蔽 + 重叠累加 ----
    for (let f = 0; f < nFrames; f++) {
      const base = f * bins
      const off = f * hop
      for (let k = 0; k < bins; k++) {
        const m = magM[base + k]
        const s = magS[base + k]
        let harmonic = 1
        if (percussiveRemoval) {
          const a = Math.max(0, k - fhalf)
          const c = Math.min(bins - 1, k + fhalf)
          let n = 0
          for (let q = a; q <= c; q++) rowScratch[n++] = magM[base + q] + magS[base + q]
          const perc = medianInPlace(rowScratch, n)
          const h = harmStore[base + k]
          // 软掩码指数 p=2(Wiener 式)
          const hp = h * h
          const pp = perc * perc
          harmonic = hp + pp > 1e-12 ? hp / (hp + pp) : 1
        }
        // 中置度:1 = 完全居中(mid 全部由居中内容贡献),0 = 硬左右
        const centeredness = Math.max(0, Math.min(1, (m / (m + s + 1e-9) - 0.5) / 0.5))
        const keepCenter = 1 - centerSuppress * centeredness
        const hz = k * binHz
        const lowGain = ramp(hz, lowLo, lowHi)
        const bassGain = 1 - ramp(hz, bassLo, bassHi)

        maskG[k] = harmonic * keepCenter * lowGain
        maskP[k] = 1 - harmonic
        maskB[k] = harmonic * bassGain
      }
      applyMask(reM, imM, reS, imS, base, bins, maskG, accGM, accGS, off, padLen, win, N, mre, mim, sre, sim, br, bi)
      applyMask(reM, imM, reS, imS, base, bins, maskP, accPM, accPS, off, padLen, win, N, mre, mim, sre, sim, br, bi)
      applyMask(reM, imM, reS, imS, base, bins, maskB, accBM, accBS, off, padLen, win, N, mre, mim, sre, sim, br, bi)
    }

    // ---- 4) 归一化,M/S → L/R(L = M+S, R = M-S,严格无损) ----
    for (let i = 0; i < segLen; i++) {
      const w = wsum[i] > 1e-8 ? 1 / wsum[i] : 0
      const gm = accGM[i] * w
      const gs = accGS[i] * w
      const pm = accPM[i] * w
      const ps = accPS[i] * w
      const bm = accBM[i] * w
      const bs = accBS[i] * w
      const o = b0 + i
      outGuitarL[o] = gm + gs
      outGuitarR[o] = gm - gs
      outPercL[o] = pm + ps
      outPercR[o] = pm - ps
      outBassL[o] = bm + bs
      outBassR[o] = bm - bs
    }

    totalFrames += nFrames
    info.frames = totalFrames
    onProgress?.((b + 1) / nBlocks)
  }

  return { guitar: [outGuitarL, outGuitarR], percussive: [outPercL, outPercR], bass: [outBassL, outBassR], info }
}

/** 离线 DSP 后端包装(与将来的模型后端同接口) */
export const dspSeparationBackend: SeparationBackend = {
  id: 'dsp-hpss',
  label: '内置 DSP(HPSS + 中侧 · 离线)',
  requiresModel: false,
  async separate(channels, sampleRate, opts) {
    return separateDsp(channels, sampleRate, opts)
  },
}
