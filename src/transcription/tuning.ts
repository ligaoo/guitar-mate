// 全曲音准校准:估计整段音频相对 A4=440 半音网格的整体偏移(音分),并校正后再取音
//
// 动机(见 EVAL.md §4.5):吉他录音整体偏 ±10~30 音分很常见,变速翻录可达 50~80 音分。
// 链路按 A4=440 直接算 MIDI,偏过 ±50 音分就系统性产生半音错音(评测里 55 音分
// 让 F1 从 30.8% 掉到 12.4%)。这里先估计整体偏移、再统一修正。
//
// 假设与边界:偏移按 ±50 音分内的假设估计(与主流校音工具一致)。超过 ±50 音分的
// 录音在声学上等价于「低半个音演奏、整体调高」的另一份谱——没有绝对参考无法区分,
// 属于原理性盲区,不是实现缺陷。
import { yin, makeYinScratch } from '../audio/pitch'
import type { RawNote } from './pipeline'

export interface TuningEstimate {
  /** 实际音高 − 半音网格,单位半音,范围 [-0.5, 0.5)。正 = 整体偏高 */
  semis: number
  /** 落在峰 ±15 音分内的观测权重占比(0-1):高 = 偏移是系统性的而非噪声 */
  support: number
  /** 参与估计的观测数(帧数) */
  count: number
}

/** 直方图峰估计:devs 是每帧「实测音高小数部分」相对网格的偏差(半音,已折到 [-0.5, 0.5)) */
export function estimateTuningOffsetSemis(devs: number[], weights: number[]): TuningEstimate | null {
  const n = devs.length
  if (n < 30) return null
  let wTotal = 0
  for (const w of weights) wTotal += w
  if (wTotal <= 0) return null
  // 5 音分一桶,覆盖 [-0.5, 0.5) 半音
  const CENTS = 100 // 半音折音分
  const BIN = 5
  const nb = Math.ceil((CENTS * 2) / BIN) // 40 桶
  const hist = new Float64Array(nb)
  for (let i = 0; i < n; i++) {
    const b = Math.min(nb - 1, Math.max(0, Math.floor(((devs[i] + 0.5) * CENTS) / BIN)))
    hist[b] += weights[i]
  }
  // 三点平滑抑制单桶毛刺
  const sm = new Float64Array(nb)
  for (let i = 0; i < nb; i++) {
    const a = hist[Math.max(0, i - 1)]
    const c = hist[Math.min(nb - 1, i + 1)]
    sm[i] = (a + 2 * hist[i] + c) / 4
  }
  let best = 0
  for (let i = 1; i < nb; i++) if (sm[i] > sm[best]) best = i
  // 峰位置用桶内(含相邻桶)观测的加权均值细化,而不是桶几何中心
  let sum = 0
  let wsum = 0
  for (let i = Math.max(0, best - 1); i <= Math.min(nb - 1, best + 1); i++) {
    if (hist[i] <= 0) continue
    const center = (i + 0.5) * BIN / CENTS - 0.5
    sum += center * hist[i]
    wsum += hist[i]
  }
  const semis = wsum > 0 ? sum / wsum : 0
  // 支持度:峰 ±15 音分内的权重占比
  let near = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(devs[i] - semis) <= 0.15) near += weights[i]
  }
  return { semis, support: near / wTotal, count: n }
}

/** 门控后的可用估计:峰必须确实聚了一批观测,否则视为「没有系统性偏移」。
 *  0.55 的依据:干净独奏(含 ±25¢ 偏移)实测 support ≥ 0.7,而混音上 YIN 被
 *  多声部拉散后 support ≤ 0.45——按此分层,混音上的噪声读数会被拒绝而不是被错误应用 */
const gate = (t: TuningEstimate | null): TuningEstimate | null =>
  t && t.support >= 0.55 && Math.abs(t.semis) >= 0.02 ? t : null

/** DSP 路径:YIN f0 轨迹 → 每有声帧的小数偏差 → 直方图峰 */
export function estimateTuningFromF0(f0: Float32Array): TuningEstimate | null {
  const devs: number[] = []
  const weights: number[] = []
  for (let f = 0; f < f0.length; f++) {
    const hz = f0[f]
    if (hz <= 0) continue
    const mf = 69 + 12 * Math.log2(hz / 440)
    devs.push(mf - Math.round(mf)) // 折到 [-0.5, 0.5]:准确调音 → 0
    weights.push(1)
  }
  return gate(estimateTuningOffsetSemis(devs, weights))
}

/**
 * 直接对 PCM 估整体音准(Basic Pitch 路径用:BP 的帧激活是分类器输出,
 * 会向半音格收缩,小偏移在帧质心上读不出来——必须用物理测量)。
 * 与 pipeline.trackF0 同参数(YIN 1536/256,prob>0.55)。
 */
export function estimateTuningFromPcm(pcm: Float32Array, sr: number): TuningEstimate | null {
  const frame = 1536
  const hop = 256
  const n = Math.max(0, Math.floor((pcm.length - frame) / hop) + 1)
  if (n < 30) return null
  const buf = new Float32Array(frame)
  const scratch = makeYinScratch(frame, sr, 70)
  const f0 = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < frame; i++) buf[i] = pcm[f * hop + i] || 0
    const { freq, prob } = yin(buf, sr, 0.14, 70, 1200, scratch)
    f0[f] = prob > 0.55 ? freq : 0
  }
  return estimateTuningFromF0(f0)
}

/**
 * 把帧激活矩阵整体移 pitch:delta > 0 = 移低(用于扣除「整体偏高 delta 半音」)。
 * 相邻桶线性插值实现分数半音移位;不碰时间轴,起音/节拍完全不受影响。
 * (等价于先把音频校准再推理,但省掉重采样与推理开销,且不引入时移。)
 * 偏移量必须来自物理测量(estimateTuningFromPcm):BP 帧激活是分类器输出,
 * 会向半音格收缩,帧质心读不出真实偏移(实测 +25¢ 样例只读到 +2~3¢)。
 */
export function shiftFramesPitch(frames: number[][], delta: number): number[][] {
  const d = Math.max(-0.5, Math.min(0.5, delta))
  const base = Math.floor(d)
  const frac = d - base
  return frames.map((fr) => {
    const out = new Array<number>(fr.length).fill(0)
    for (let b = 0; b < fr.length; b++) {
      const src = b + base // 新桶 b 的能量来自原 b+base 与 b+base+1 的插值
      const v0 = src >= 0 && src < fr.length ? fr[src] : 0
      const v1 = src + 1 >= 0 && src + 1 < fr.length ? fr[src + 1] : 0
      out[b] = (1 - frac) * v0 + frac * v1
    }
    return out
  })
}

/** 按估计偏移整体修音(DSP 路径在音符取整前调用) */
export function applyTuningToMidi(med: number, semis: number): number {
  return Math.round(med - semis)
}

/** 音分 → 显示用字符串 */
export const centsLabel = (cents: number): string =>
  `${cents > 0 ? '+' : ''}${cents.toFixed(0)} 音分`

export type TunedNote = RawNote
