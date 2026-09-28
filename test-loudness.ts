// 拨弦响度一致性自测:不同音高的起振段 RMS 应一致
// 回归背景:练耳音程题"第二个音总比第一个小"——旧实现按峰值归一化且目标随音高递减,
// 高音激励噪声更亮(波峰因子大),同等峰值下 RMS 更低。现改为起振段 RMS 归一化。
import { renderPluckSamples } from './src/audio/synth'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const SR = 22050
const attackRms = (buf: Float32Array) => {
  const win = Math.floor(SR * 0.25)
  let s = 0
  for (let i = 0; i < win; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / win)
}
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const render5 = (f: number) => [...Array(5)].map(() => attackRms(renderPluckSamples(f, SR, 2.5, 0.7)))

// 跨音高:吉他音域内各频率的起振 RMS 应一致(±8%)
const freqs = [110, 165, 220, 330, 440, 660, 880]
let maxPeak = 0
const means: number[] = []
for (const f of freqs) {
  const runs = render5(f)
  for (let r = 0; r < 5; r++) {
    const buf = renderPluckSamples(f, SR, 2.5, 0.7)
    for (let i = 0; i < buf.length; i++) maxPeak = Math.max(maxPeak, Math.abs(buf[i]))
  }
  const spread = Math.max(...runs) / Math.min(...runs) - 1
  ok(spread < 0.1, `${f}Hz 同频随机波动 ${(spread * 100).toFixed(0)}% < 10%`)
  means.push(avg(runs))
}
const globalMean = avg(means)
freqs.forEach((f, i) => {
  ok(
    Math.abs(means[i] / globalMean - 1) < 0.08,
    `${f}Hz 起振 RMS 相对全频均值 ${((means[i] / globalMean - 1) * 100).toFixed(1)}%(±8% 内)`,
  )
})
ok(maxPeak <= 0.82, `峰值帽生效(全样本 max ${maxPeak.toFixed(2)} ≤ 0.82)`)

// 练耳场景:音程题先低后高,两个音的响度差应在 ±10% 内
const r196 = avg(render5(196)) // G3
const r392 = avg(render5(392)) // G4(八度)
const r587 = avg(render5(587)) // D5(纯十二度)
ok(Math.abs(r392 / r196 - 1) < 0.1, `G3 → G4(八度)响度差 ${((r392 / r196 - 1) * 100).toFixed(1)}%`)
ok(Math.abs(r587 / r196 - 1) < 0.1, `G3 → D5(十二度)响度差 ${((r587 / r196 - 1) * 100).toFixed(1)}%`)

console.log(failed ? `失败 ${failed} 项` : '全部通过 ✓')
process.exit(failed ? 1 : 0)
