// 音高轨迹算法自测:恒音 / 双音 / 颤音(±0.6 半音)/ 滑音
import { computePitchTrack } from './src/pitch/trace'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

const SR = 22050
function render(events: { f: number; d: number; vibrato?: number }[], sr = SR) {
  const total = Math.floor(sr * (events.reduce((s, e) => s + e.d, 0) + 0.3))
  const data = new Float32Array(total)
  let cursor = 0
  for (const e of events) {
    const from = Math.floor(cursor * sr)
    let phase = 0
    for (let i = from; i < total; i++) {
      const t = (i - from) / sr
      if (t > e.d) break
      const vib = e.vibrato ? Math.pow(2, (e.vibrato * Math.sin(2 * Math.PI * 5 * t)) / 12) : 1
      phase += (2 * Math.PI * e.f * vib) / sr // 相位积分才是正确的调频信号
      const env = Math.exp(-1.2 * t) * Math.min(1, t * 200)
      data[i] += 0.6 * env * Math.sin(phase)
    }
    cursor += e.d
  }
  return data
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

async function main() {
// 1. 恒音 A4 1.5s → 单段 A4,偏差小
{
  const r = await computePitchTrack(render([{ f: 440, d: 1.5 }]), SR)
  check('恒音 A4 → 1 个段落', r.segments.length === 1, `${r.segments.length} 段`)
  check('段落音名 A4', r.segments[0]?.noteName === 'A4', r.segments[0]?.noteName)
  check('音分偏差 < 10', Math.abs(r.segments[0]?.cents ?? 99) < 10, (r.segments[0]?.cents ?? 0).toFixed(1))
  check('有声占比 > 0.7', r.voicedRatio > 0.7, r.voicedRatio.toFixed(2))
}

// 2. 两个音(A4 → C5)→ 两段,音名正确
{
  const r = await computePitchTrack(render([{ f: 440, d: 0.8 }, { f: 523.25, d: 0.8 }]), SR)
  const names = r.segments.map((s) => s.noteName)
  check('双音 → 2 段', r.segments.length === 2, names.join(','))
  check('音名 A4 → C5', names[0] === 'A4' && names[1] === 'C5', names.join('→'))
}

// 3. 颤音 ±0.6 半音 → 仍为 1 段(不切碎),音名 A4
{
  const r = await computePitchTrack(render([{ f: 440, d: 1.5, vibrato: 0.6 }]), SR)
  check('颤音 ±0.6 半音 → 不切碎', r.segments.length === 1, `${r.segments.length} 段`)
  check('颤音段落音名 A4', r.segments[0]?.noteName === 'A4', r.segments[0]?.noteName)
}

// 4. 滑音(1.5 秒内从 A4 滑到 A5)→ 多段(阶梯化),范围覆盖
{
  const sr = SR
  const dur = 1.5
  const total = Math.floor(sr * dur)
  const data = new Float32Array(total)
  let phase = 0
  for (let i = 0; i < total; i++) {
    const t = i / sr
    const f = 440 * Math.pow(2, t / dur) // 相位积分
    phase += (2 * Math.PI * f) / sr
    data[i] = 0.6 * Math.min(1, t * 200) * Math.exp(-0.3 * t) * Math.sin(phase)
  }
  const r = await computePitchTrack(data, sr)
  check('滑音 → 分成多段', r.segments.length >= 4, `${r.segments.length} 段`)
  const spanSemitones = r.maxMidi - r.minMidi
  check('滑音范围 ≈ 一个八度', spanSemitones > 9 && spanSemitones <= 13, spanSemitones.toFixed(1))
}

console.log(failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
}

main()
