// 算法自测:和弦生成/反查/指法/MIDI导出/扒谱管线(Node 环境)
// 覆盖审计报告中的复现场景:缓存 key、反查 exact 语义、揉弦分段、BPM 矩阵、指法丢音
import { generateVoicings, reverseLookup, chordName } from './src/theory/chords'
import { STANDARD_TUNING } from './src/theory/tunings'
import { assignFingering } from './src/transcription/fingering'
import { tabToMidi, tabToText } from './src/transcription/exporters'
import { transcribe, estimateBpm, segmentByPitchProbe } from './src/transcription/pipeline'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

// 1. 和弦生成
const cmaj = generateVoicings(0, [0, 4, 7], STANDARD_TUNING, { maxFret: 12, limit: 16 })
console.log(`C 大调生成 ${cmaj.length} 个指法`)
check('生成数量合理(≥8)', cmaj.length >= 8, `${cmaj.length}`)
check('包含开放把位 C (x32010)', cmaj.some((v) => v.frets.join(',') === '-1,3,2,0,1,0'))
check('教科书 C 排在首位', cmaj[0].frets.join(',') === '-1,3,2,0,1,0', cmaj[0].frets.join(','))
// L1 回归:缓存 key 漏 limit 导致先小后大被截断
generateVoicings(0, [0, 4, 7], STANDARD_TUNING, { maxFret: 12, limit: 12 })
check('缓存不截断后续请求(L1)', generateVoicings(0, [0, 4, 7], STANDARD_TUNING, { maxFret: 12, limit: 16 }).length === 16)

// 2. 反查
const m = reverseLookup([-1, 3, 2, 0, 1, 0], STANDARD_TUNING)
check('反查 x32010 → C(精确)', m.length > 0 && chordName(m[0].rootPc, m[0].type) === 'C' && m[0].exact)
const mCE = reverseLookup([-1, 3, 2, 0, -1, -1], STANDARD_TUNING) // 只有 C+E,缺五音:有根音+三音仍可判
check('反查 C+E(缺五音)仍为精确 C', mCE.length > 0 && chordName(mCE[0].rootPc, mCE[0].type) === 'C' && mCE[0].exact)
const mC = reverseLookup([-1, 3, 2, -1, -1, -1], STANDARD_TUNING) // 只按 C+E? 不:-1,3,2 → E,A,D? 3弦=50+2=52=E3,4弦? 无
const mCEonly = reverseLookup([-1, 0, 2, -1, -1, -1], STANDARD_TUNING) // E+A:无根音关系,验证降级
const mNoThird = reverseLookup([-1, 3, -1, 0, 1, 3], STANDARD_TUNING) // E(6? no)…
// L2 核心:只有根音+五音(缺三音)不能标精确
const rootFifth = [-1, 8, -1, -1, -1, 1] // 6弦8品=C3, 1弦1品=F4? 64+1=65=F。改:C+G
const rootFifth2 = [-1, 8, -1, -1, 3, -1] // 6弦8品=C, 2弦3品=G(59+3=62)
const mRF = reverseLookup(rootFifth2, STANDARD_TUNING)
const cMatch = mRF.find((x) => chordName(x.rootPc, x.type) === 'C')
check('反查 C+G(缺三音)→ C 只能是近似(L2)', !cMatch || cMatch.exact === false)
// 排序稳定性(L8)
const a1 = reverseLookup([-1, 3, 2, 0, 1, 3], STANDARD_TUNING).map((x) => chordName(x.rootPc, x.type) + (x.exact ? '*' : ''))
const a2 = reverseLookup([-1, 3, 2, 0, 1, 3], STANDARD_TUNING).map((x) => chordName(x.rootPc, x.type) + (x.exact ? '*' : ''))
check('反查排序稳定可重复(L8)', JSON.stringify(a1) === JSON.stringify(a2))

// 3. 指法推断
const seq = [64, 67, 72, 71, 69, 64].map((midi, i) => ({ midi, step: i * 2, dur: 2 }))
const { notes: tab, dropped } = assignFingering(seq, STANDARD_TUNING)
console.log('指法:', tab.map((n) => `s${6 - n.string}f${n.fret}`).join(' '))
check('指法全部落在可用范围', tab.every((n) => n.fret >= 0 && n.fret <= 15 && n.string >= 0 && n.string < 6))
check('指法音高正确', tab.every((n) => STANDARD_TUNING[n.string] + n.fret === n.midi))
// L5 回归:超范围音进丢弃报告而不是静默消失
const withLow = [{ midi: 64, step: 0, dur: 2 }, { midi: 30, step: 2, dur: 2 }, { midi: 67, step: 4, dur: 2 }]
const r2 = assignFingering(withLow, STANDARD_TUNING)
check('超范围音进入丢弃报告(L5)', r2.dropped.length === 1 && r2.dropped[0].midi === 30 && r2.notes.length === 2)
// 同弦重叠音符不能落在同一根弦
const overlapSeq = [64, 64].map((midi, i) => ({ midi, step: 0, dur: 4 - i * 0 }))
const rOverlap = assignFingering([{ midi: 64, step: 0, dur: 4 }, { midi: 64, step: 0, dur: 4 }], STANDARD_TUNING)
check('同弦重叠禁用(分开两根弦)', rOverlap.notes.length === 2 && rOverlap.notes[0].string !== rOverlap.notes[1].string)

// 4. 导出
const bytes = tabToMidi(tab, 90)
check('MIDI 文件头正确', bytes.length > 40 && String.fromCharCode(...bytes.slice(0, 4)) === 'MThd', `${bytes.length} bytes`)
check('MIDI 异常 bpm 防护', (() => { const b = tabToMidi(tab, -5); return b.length > 40 })())
const text = tabToText(tab)
check('文本 Tab 含六根弦', (text.match(/^[EADGBe]\|/gm) ?? []).length >= 6)

// 5. 扒谱管线:合成 4 音旋律 A4 B4 C5 D5
const sr = 44100
const melody = [440, 493.88, 523.25, 587.33]
const noteDur = 0.55
const total = melody.length * noteDur + 0.3
const sig = new Float32Array(Math.floor(sr * total))
for (let i = 0; i < sig.length; i++) {
  const t = i / sr
  const ni = Math.min(melody.length - 1, Math.floor(t / noteDur))
  const lt = t - ni * noteDur
  const env = Math.exp(-3.2 * lt) * Math.min(1, lt * 300)
  sig[i] = 0.6 * env * Math.sin(2 * Math.PI * melody[ni] * t) + (Math.random() - 0.5) * 0.003
}
const res = transcribe(sig, sr)
console.log(`识别 ${res.notes.length} 音,BPM=${res.bpm}`)
const expect = [69, 71, 72, 74]
check('识别出 4 个音', res.notes.length === 4, res.notes.map((n) => n.midi).join(','))
check('音高正确 A4 B4 C5 D5', expect.every((m2, i) => res.notes[i]?.midi === m2))

// 6. L3 回归:揉弦 ±0.6 半音不再把整段切碎
{
  const hop = 256
  const SR2 = 22050
  const durSec = 2
  const nFrames = Math.floor((durSec * SR2) / hop)
  const f0 = new Float32Array(nFrames)
  const rms2 = new Float32Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    const t = (f * hop + 768) / SR2
    if (t >= 0.1 && t <= 1.9) {
      const cents = 0.6 * 100 * Math.sin(2 * Math.PI * 5 * t) // ±0.6 半音,5Hz 揉弦
      f0[f] = 440 * Math.pow(2, cents / 1200)
      rms2[f] = 0.05
    }
  }
  const vib = segmentByPitchProbe(f0, rms2)
  check('揉弦 ±0.6 半音 → 单个持续音(L3)', vib.length === 1 && vib[0].midi === 69, `得到 ${vib.length} 个音`)
}

// 7. L4 回归:BPM 矩阵(审计实测:旧实现 200→98、60→118、50→98)
{
  const matrix: [number, number][] = [
    [50, 50], [60, 60], [67, 67], [75, 75], [80, 80], [90, 90],
    [100, 100], [109, 109], [120, 120], [150, 150], [200, 200],
  ]
  let allOk = true
  const detail: string[] = []
  for (const [trueBpm, _] of matrix) {
    const sp = 60 / trueBpm
    const onsets = Array.from({ length: 8 }, (_, i) => i * sp)
    const got = estimateBpm(onsets).bpm
    const ok = Math.abs(got - trueBpm) <= 2
    if (!ok) allOk = false
    detail.push(`${trueBpm}→${got}${ok ? '' : ' ✗'}`)
  }
  console.log('BPM 矩阵: ' + detail.join(' '))
  check('BPM 矩阵全对(L4)', allOk)
}

// 8. L7 回归:复音输入(和弦)给出疑似复音标记
{
  const srp = 22050
  const durC = 1.5
  const sigC = new Float32Array(Math.floor(srp * durC))
  const chord = [130.81, 164.81, 196.0, 261.63] // C 大三和弦 + 八度
  for (let i = 0; i < sigC.length; i++) {
    const t = i / srp
    const env = Math.exp(-2.5 * t) * Math.min(1, t * 200)
    let v = 0
    for (const f of chord) v += 0.25 * Math.sin(2 * Math.PI * f * t)
    sigC[i] = env * v
  }
  const rc = transcribe(sigC, srp)
  check('复音输入给出疑似复音标记(L7)', rc.likelyPolyphonic === true, `notes=${rc.notes.length}`)
}

// 9. 调弦音域回归:Drop D 的 D2(MIDI 38)既不能被 clamp 成 E2,也不能凭空冒出 E2
//    旧实现硬编码 Math.max(40, Math.min(88, …)) —— Drop D/DADGAD/Open D/降半音全部报错音
{
  const srD = 22050
  const hz = 73.42 // D2
  const dur = 2.0
  const sigD = new Float32Array(Math.floor(srD * dur))
  for (let i = 0; i < sigD.length; i++) {
    const t = i / srD
    const env = Math.exp(-2.2 * t) * Math.min(1, t * 200)
    sigD[i] = 0.6 * env * (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.3 * Math.sin(6 * Math.PI * hz * t))
  }
  const rDrop = transcribe(sigD, srD, { lowestMidi: 38, highestMidi: 79 })
  check('Drop D:D2 识别为 MIDI 38(不再被抬高到 40)', rDrop.notes.some((n) => n.midi === 38), rDrop.notes.map((n) => n.midi).join(','))
  const rStd = transcribe(sigD, srD) // 默认音域 40..88
  check(
    '默认音域下 D2 被丢弃而不是改写成 E2',
    !rStd.notes.some((n) => n.midi === 40),
    rStd.notes.map((n) => n.midi).join(',') || '空',
  )
}

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
