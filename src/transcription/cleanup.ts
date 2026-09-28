// 扒谱后整理:调性检测 / 调外音过滤 / 复音上限修剪
// 整曲识别的输出是全部乐器的"音符汤",这三步把它修剪成吉他可弹的谱
import { mod12 } from '../theory/notes'

export interface KeyGuess {
  rootPc: number
  mode: 'major' | 'minor'
  name: string // 如 "C 大调"
}

// Krumhansl-Schmuckler 音级稳定性轮廓
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']

/** 用(时长加权的)音级直方图与 24 个大/小调轮廓做皮尔逊相关,取最优 */
export function detectKey(notes: { midi: number; start: number; end: number }[]): KeyGuess | null {
  if (notes.length < 12) return null
  const hist = new Array(12).fill(0)
  for (const n of notes) hist[mod12(n.midi)] += Math.max(0.08, n.end - n.start)
  const total = hist.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  const mean = total / 12
  const norm = hist.map((h) => h - mean)
  let best = { corr: -Infinity, rootPc: 0, mode: 'major' as 'major' | 'minor' }
  for (const mode of ['major', 'minor'] as const) {
    const prof = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
    const pm = prof.reduce((a, b) => a + b, 0) / 12
    const pn = prof.map((p) => p - pm)
    for (let r = 0; r < 12; r++) {
      let num = 0
      let d1 = 0
      let d2 = 0
      for (let i = 0; i < 12; i++) {
        const h = norm[(i + r) % 12]
        num += h * pn[i]
        d1 += h * h
        d2 += pn[i] * pn[i]
      }
      const corr = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : -1
      if (corr > best.corr) best = { corr, rootPc: r, mode }
    }
  }
  return { ...best, name: `${KEY_NAMES[best.rootPc]}${best.mode === 'major' ? ' 大调' : ' 小调'}` }
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]

/** 过滤调外音:整曲混识别里大量"差半音"的幻觉音会落在调外,一刀切掉(布鲁斯音也会被滤,慎用) */
export function filterToKey<T extends { midi: number }>(notes: T[], key: KeyGuess): T[] {
  const steps = key.mode === 'major' ? MAJOR_STEPS : MINOR_STEPS
  const inKey = new Set(steps.map((s) => mod12(key.rootPc + s)))
  return notes.filter((n) => inKey.has(mod12(n.midi)))
}

/** 同一量化格内最多保留 K 个最响的音:吉他只有 6 根弦,同时发声数是硬上限,
 *  混音识别(人声+键盘+吉他叠在一起)的密集簇在这一步被裁掉 */
export function capPolyphony<T extends { step: number; conf: number }>(notes: T[], max = 6): T[] {
  const byStep = new Map<number, T[]>()
  for (const n of notes) {
    const g = byStep.get(n.step) ?? []
    g.push(n)
    byStep.set(n.step, g)
  }
  const out: T[] = []
  for (const [, g] of byStep) {
    if (g.length <= max) out.push(...g)
    else {
      // 稳定排序:响度相同的保持原相对顺序(音高升序),结果确定
      const kept = [...g].sort((a, b) => b.conf - a.conf).slice(0, max)
      out.push(...kept)
    }
  }
  return out.sort((a, b) => a.step - b.step)
}
