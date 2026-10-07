// 数据工厂对齐消歧自测(PLAN-90 §7.2 第 6 条):
//  · 真偏移远在旧 ±3 拍之外(翻唱版实测偏 7 拍)也要找对
//  · 谱与录音不对应时必须判"不可信",不能照常产出训练样本
//  · 落在搜索边界判"不可信"
//  · 半拍偏移(弱起/切分)可以找到
import { disambiguateByPitch, DISAMB_MAX_BEATS } from './scripts/ref-core'
import { bpTimeToFrame } from './src/transcription/basicPitch'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const NB = 88
const BEAT = 0.4 // 150 BPM
const DUR = 120

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 不重复的"谱":每半拍一个音,音高随机(不循环,避免重复段落造成的天然歧义)
const r = rng(5)
const events: { t: number; midi: number }[] = []
for (let t = 0; t < DUR - 10; t += BEAT / 2) events.push({ t, midi: 45 + Math.floor(r() * 30) })

/** 按给定的真实偏移把谱"渲染"成帧激活:谱音处 0.6,其余是 0~0.12 的底噪 */
function render(trueOffset: number, evs: { t: number; midi: number }[], seed: number) {
  const nFrames = bpTimeToFrame(DUR) + 1
  const framesF = new Float32Array(nFrames * NB)
  const nr = rng(seed)
  for (let i = 0; i < framesF.length; i++) framesF[i] = nr() * 0.12
  for (const e of evs) {
    const f0 = bpTimeToFrame(trueOffset + e.t)
    for (let f = f0; f < Math.min(nFrames, f0 + 8); f++) framesF[f * NB + (e.midi - 21)] = 0.6
  }
  return { framesF, nFrames, nBins: NB }
}

// 1) 真偏移 = 起音估计 + 7 拍(旧 ±3 拍搜不到)
{
  const est = 1.0
  const cache = render(est + 7 * BEAT, events, 11)
  const d = disambiguateByPitch({ offset: est, scale: 1 }, BEAT, events, cache)
  ok(d.k === 7 && d.ok, `偏 7 拍也能找对且判可信(k=${d.k},对比度 ${d.contrast.toFixed(2)},区分度 ${d.margin.toFixed(3)})`)
}

// 2) 半拍偏移
{
  const est = 2.0
  const cache = render(est - 2.5 * BEAT, events, 12)
  const d = disambiguateByPitch({ offset: est, scale: 1 }, BEAT, events, cache)
  ok(d.k === -2.5 && d.ok, `半拍步进:偏 −2.5 拍找对(k=${d.k})`)
}

// 3) 谱与录音不对应(录音里是另一份随机谱):必须判不可信
{
  const r2 = rng(99)
  const other = events.map((e) => ({ t: e.t, midi: 45 + Math.floor(r2() * 30) }))
  const cache = render(1.0, other, 13)
  const d = disambiguateByPitch({ offset: 1.0, scale: 1 }, BEAT, events, cache)
  ok(!d.ok && d.reason !== null, `谱与录音不对应 → 判不可信(对比度 ${d.contrast.toFixed(2)};原因:${d.reason})`)
}

// 4) 真值超出搜索范围:最优落在边界 → 判不可信(而不是像旧实现那样停在边界照常出结果)
{
  const est = 1.0
  const cache = render(est + (DISAMB_MAX_BEATS + 3) * BEAT, events, 14)
  const d = disambiguateByPitch({ offset: est, scale: 1 }, BEAT, events, cache)
  ok(!d.ok, `真值在搜索范围外 → 判不可信(k=${d.k},边界=${d.atEdge},原因:${d.reason})`)
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
