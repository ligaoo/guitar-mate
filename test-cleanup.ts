// 扒谱后整理自测:调性检测 / 调外音过滤 / 复音上限 / 整曲 BPM 包络自相关
import { detectKey, filterToKey, capPolyphony } from './src/transcription/cleanup'
import { estimateBpmFromEnvelope } from './src/transcription/pipeline'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// ---- 调性检测 ----
const cMajor = [60, 62, 64, 65, 67, 69, 71, 72, 74, 67, 64, 60].flatMap((m) => [
  { midi: m, start: 0, end: 0.4 },
])
ok(detectKey(cMajor)?.name === 'C 大调', `C 大调音集 → ${detectKey(cMajor)?.name}`)

const aMinor = [57, 59, 60, 62, 64, 65, 67, 69, 57, 64, 62, 60].flatMap((m) => [
  { midi: m, start: 0, end: 0.4 },
])
const gAminor = detectKey(aMinor)?.name
ok(gAminor === 'A 小调' || gAminor === 'C 大调', `A 小调音集 → ${gAminor}(大小调同音级,二者可接受)`)

const gMajor = [55, 59, 62, 67, 71, 74, 67, 62, 59, 55, 64, 62].flatMap((m) => [
  { midi: m, start: 0, end: 0.4 },
])
ok(detectKey(gMajor)?.name === 'G 大调', `G 大调音集 → ${detectKey(gMajor)?.name}`)

ok(detectKey([{ midi: 60, start: 0, end: 0.4 }]) === null, '样本不足返回 null')

// ---- 调外音过滤 ----
const key = detectKey(cMajor)!
const mixed = [...cMajor, { midi: 61, start: 0, end: 0.4 }, { midi: 66, start: 0, end: 0.4 }] // C#/F# 调外
const filtered = filterToKey(mixed, key)
ok(filtered.length === cMajor.length, `调外音过滤:12+2 → ${filtered.length}(删掉 C#/F#)`)

// ---- 复音上限 ----
const dense = Array.from({ length: 12 }, (_, i) => ({
  step: 0,
  dur: 3,
  midi: 60 + i,
  conf: i / 11,
}))
const capped = capPolyphony(dense, 6)
ok(capped.length === 6, `12 音同格 → 保留 ${capped.length}`)
ok(Math.min(...capped.map((c) => c.conf)) > 5 / 11, '保留的是最响的 6 个')
const spread = [
  { step: 0, dur: 3, midi: 60, conf: 0.5 },
  { step: 0, dur: 3, midi: 64, conf: 0.6 },
  { step: 3, dur: 3, midi: 67, conf: 0.4 },
]
ok(capPolyphony(spread, 6).length === 3, '不同格不受影响')

// ---- 整曲 BPM:起音包络自相关 ----
const FPS = 86
// 合成"每拍一个起音"的包络(高斯脉冲 + 底噪),60 秒
function envAtBpm(bpm: number, secs = 60, noise = 0.15): Float32Array {
  const n = secs * FPS
  const env = new Float32Array(n)
  const period = (60 / bpm) * FPS
  let t = period
  while (t < n) {
    const c = Math.round(t)
    for (let f = -2; f <= 2; f++) {
      if (c + f >= 0 && c + f < n) env[c + f] += Math.exp(-(f * f) / 2)
    }
    t += period
  }
  for (let i = 0; i < n; i++) env[i] += Math.random() * noise
  return env
}
for (const bpm of [168, 97, 120]) {
  const r = estimateBpmFromEnvelope(envAtBpm(bpm), FPS)
  ok(Math.abs(r.bpm - bpm) <= 1, `包络 ${bpm} BPM → 检出 ${r.bpm}(锁定度 ${r.strength.toFixed(2)})`)
  ok(r.strength > 0.1, `  锁定度足够(${r.strength.toFixed(2)})`)
}
{
  // 随机噪声包络:不应误报高锁定度
  const n = 60 * FPS
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) env[i] = Math.random()
  const r = estimateBpmFromEnvelope(env, FPS)
  ok(r.strength < 0.15, `噪声包络锁定度低(${r.bpm} BPM, ${r.strength.toFixed(2)})`)
}

console.log(failed ? `失败 ${failed} 项` : '全部通过 ✓')
process.exit(failed ? 1 : 0)
