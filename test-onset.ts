// 扒谱起音时间回归:识别出的音符起始时间必须与音频真实位置一致
//
// 回归背景:DSP 管线在分析前会给信号补 WIN=1024 个采样,但"帧序号 → 时间"的换算
// 原先按补齐后的坐标计算,导致整谱起音系统性偏晚 1024/22050 ≈ 46ms;
// 叠加"起音记在帧中心"的约定,实际偏差约 67ms——超过 MIREX 的 ±50ms 容差,
// 任何识别结果都判不中,同时 A/B 对比里整谱都会晚一截。

import { transcribe } from './src/transcription/pipeline'
import { renderPluckSamples } from './src/audio/synth'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const SR = 22050

/** 确定性 PRNG,保证回归可复现 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TRUTHS = [
  { t: 0.5, midi: 60 },
  { t: 1.0, midi: 64 },
  { t: 1.5, midi: 67 },
  { t: 2.0, midi: 62 },
]

const total = Math.ceil(2.6 * SR)
const data = new Float32Array(total)
TRUTHS.forEach((n, i) => {
  const f = 440 * Math.pow(2, (n.midi - 69) / 12)
  const buf = renderPluckSamples(f, SR, 0.42, 0.7, makeRng(1000 + i))
  const from = Math.round(n.t * SR)
  for (let k = 0; k < buf.length && from + k < total; k++) data[from + k] += buf[k] * 0.85
})

const r = transcribe(data, SR)
console.log(`识别到 ${r.notes.length} 个音符(标注 ${TRUTHS.length} 个)`)

const deltas: number[] = []
for (const truth of TRUTHS) {
  let best: { dt: number; midi: number } | null = null
  for (const e of r.notes) {
    const dt = e.start - truth.t
    if (!best || Math.abs(dt) < Math.abs(best.dt)) best = { dt, midi: e.midi }
  }
  if (!best) {
    ok(false, `${truth.t.toFixed(2)}s 附近没有识别到音符`)
    continue
  }
  deltas.push(best.dt)
  ok(
    Math.abs(best.dt) <= 0.035 && best.midi === truth.midi,
    `${truth.t.toFixed(2)}s midi ${truth.midi} → ${(truth.t + best.dt).toFixed(3)}s midi ${best.midi}` +
      `(Δ ${(best.dt * 1000).toFixed(1)}ms)`,
  )
}

const meanBias = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0
ok(
  Math.abs(meanBias) <= 0.03,
  `平均时间偏差 ${(meanBias * 1000).toFixed(1)}ms 在 ±30ms 内(修复前约 +67ms)`,
)

// 起音锚点也不应晚于第一个音太多:量化以 offset 为锚,锚偏了整谱跟着偏
ok(
  Math.abs(r.offset - TRUTHS[0].t) <= 0.05,
  `offset ${r.offset.toFixed(3)}s 与首个标注音 ${TRUTHS[0].t.toFixed(2)}s 相差 ≤50ms`,
)

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
