// 音色分析算法自测:合成带谐波的拨弦音,验证 f0/谐波/包络提取
import { analyzeTone } from './src/tone/analysis'

const sr = 44100
const f0 = 220 // A3
const dur = 3
const data = new Float32Array(sr * dur)
for (let i = 0; i < data.length; i++) {
  const t = i / sr
  const attack = Math.min(1, t / 0.008)
  const decay = Math.exp(-1.8 * t)
  const env = attack * decay
  data[i] =
    env *
    (1.0 * Math.sin(2 * Math.PI * f0 * t) +
      0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.25 * Math.sin(2 * Math.PI * 3 * f0 * t) +
      0.1 * Math.sin(2 * Math.PI * 4 * f0 * t))
}

const fakeBuffer = { sampleRate: sr, getChannelData: () => data, duration: dur }
const r = analyzeTone(fakeBuffer as unknown as AudioBuffer)

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

console.log('f0:', r!.freq.toFixed(1), 'Hz, note:', r!.noteName)
check('f0 ≈ 220Hz', Math.abs(r!.freq - 220) < 3, r!.freq.toFixed(1))
check('音名 A3', r!.noteName === 'A3')
console.log('harmonics:', r!.harmonics.map((h) => h.toFixed(2)).join(' '))
check('H2 ≈ 0.5', Math.abs(r!.harmonics[1] - 0.5) < 0.15)
check('H3 ≈ 0.25', Math.abs(r!.harmonics[2] - 0.25) < 0.1)
check('H4 ≈ 0.1', Math.abs(r!.harmonics[3] - 0.1) < 0.08)
console.log('attack:', r!.attackMs.toFixed(1), 'ms, decay:', r!.decayS.toFixed(2), 's')
check('起音 < 20ms', r!.attackMs < 20, r!.attackMs.toFixed(1))
check('衰减 0.5-3s', r!.decayS > 0.5 && r!.decayS < 3, r!.decayS.toFixed(2))
check('音分偏差小', Math.abs(r!.cents) < 10, r!.cents.toFixed(1))
check('音准稳定(σ<15音分)', r!.stabilityCents < 15, r!.stabilityCents.toFixed(1))
console.log(failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
