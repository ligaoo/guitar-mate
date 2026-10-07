// 量化与指法回归(产品链路口径)
//
// 覆盖两处实测缺陷:
//   · 指法:逐音 DP 的同弦冲突只跟相邻音比较 → 三音簇里第 1、3 个音落在同一根弦
//     (实测 A2+D3+E3 → 弦 1 同时按品 0 与品 7,丢弃报告却是空的)。
//   · 量化:锚点/自动密度/调性过滤的语义(自动密度只对长素材生效,且不删强音)。
import { refineBpm, quantizeNotes, SUBDIV } from './src/transcription/quantize'
import { assignFingering, positionsForMidi } from './src/transcription/fingering'
import { TUNINGS } from './src/theory/tunings'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const STD = TUNINGS[0].midi

// ---------- 指法:同时发声音簇的联合分配 ----------
{
  // 实测复现用例:三音簇 A2+D3+E3(旧实现 → s1f0 s2f0 s1f7,弦 1 重叠)
  const cluster = [45, 50, 52].map((midi) => ({ midi, step: 0, dur: 12 }))
  const r = assignFingering(cluster, STD, 15)
  const byString = new Map<number, number[]>()
  for (const n of r.notes) byString.set(n.string, [...(byString.get(n.string) ?? []), n.midi])
  const collide = [...byString.values()].filter((v) => v.length > 1)
  ok(r.notes.length === 3, `三音簇全部安排到指板(${r.notes.length}/3)`)
  ok(collide.length === 0, `三音簇内弦互不相同(重叠弦 ${collide.length} 组)`)
  ok(
    r.notes.every((n) => STD[n.string] + n.fret === n.midi),
    '每个音的 (弦,品) 都能还原出正确音高',
  )
}

{
  // 六音满和弦:必须正好用掉六根弦
  const six = [40, 45, 50, 55, 59, 64].map((midi) => ({ midi, step: 0, dur: 12 }))
  const r = assignFingering(six, STD, 15)
  ok(r.notes.length === 6 && new Set(r.notes.map((n) => n.string)).size === 6, '六音簇用满六根弦且不重复')
}

{
  // 跨簇的持续音与后续音冲突时,必须换弦或进丢弃报告(不能静默重叠)
  const notes = [
    { midi: 64, step: 0, dur: 24 }, // 长音 1 弦空弦
    { midi: 64, step: 6, dur: 6 }, // 与长音重叠的同音
  ]
  const r = assignFingering(notes, STD, 15)
  const overlapSameString = r.notes.some((a) =>
    r.notes.some((b) => a !== b && a.string === b.string && a.step < b.step + b.dur && b.step < a.step + a.dur),
  )
  ok(!overlapSameString, '同弦时间重叠被消除(换弦或丢弃)')
  ok(r.notes.length + r.dropped.length === 2, `没有音符凭空消失(${r.notes.length} 安排 / ${r.dropped.length} 丢弃)`)
}

{
  // 单音旋律不会被拆散,且仍偏好低把位
  const seq = [64, 67, 72, 71, 69, 64].map((midi, i) => ({ midi, step: i * 3, dur: 3 }))
  const r = assignFingering(seq, STD, 15)
  ok(r.notes.length === 6 && r.dropped.length === 0, '单音旋律全部可弹且无丢弃')
  ok(r.notes.every((n) => n.fret <= 15), '品位不超过最高品')
  const avgFret = r.notes.reduce((a, n) => a + n.fret, 0) / r.notes.length
  ok(avgFret <= 7, `平均把位偏低(${avgFret.toFixed(1)})`)
}

{
  // 置信度必须一路带到 TabNote(UI 用它标出待核对音符)
  const r = assignFingering([{ midi: 64, step: 0, dur: 3, conf: 0.31 }], STD, 15)
  ok(r.notes[0].conf === 0.31, `TabNote 携带置信度(${r.notes[0].conf})`)
  // 超出音域的音仍然进丢弃报告(回归 L5)
  const r2 = assignFingering([{ midi: 30, step: 0, dur: 3 }], STD, 15)
  ok(r2.dropped.length === 1 && r2.dropped[0].reason === 'range', '超范围音进丢弃报告')
  ok(positionsForMidi(38, TUNINGS[1].midi, 15).length > 0, 'Drop D 的 D2=38 可被安排(旧 DSP 硬 clamp 会丢)')
}

// ---------- 量化 ----------
{
  // 网格:100BPM 每拍 12 格 → 一格 50ms;同一格内的音符合并去重
  const raw = [
    { start: 0.0, end: 0.5, midi: 60, confidence: 0.8 },
    { start: 0.02, end: 0.52, midi: 60, confidence: 0.8 }, // 同格同音高 → 去重
    { start: 0.6, end: 1.1, midi: 64, confidence: 0.8 }, // 恰好第 12 格(1 拍)
  ]
  const q = quantizeNotes(raw, 2, { bpm: 100 })
  ok(q.notes.length === 2, `同格同音高去重(3 → ${q.notes.length})`)
  ok(q.notes[0].step === 0 && q.notes[1].step === SUBDIV, `步进正确(${q.notes.map((n) => n.step).join(',')})`)
  ok(Math.abs(q.gridSec - 0.05) < 1e-9, `格宽 50ms(${(q.gridSec * 1000).toFixed(1)}ms)`)
}

{
  // 步进吸附:默认**关**(实测会摧毁合法的三连 16 分/32 分位置,让谱面掉约 19 点);
  // 打开时(P2 旧行为)才会把偏离 1 格以内的音吸到 3/4 的倍数网格
  const off = quantizeNotes([{ start: 0.5, end: 1.0, midi: 60, confidence: 0.8 }], 2, { bpm: 100, anchor: 0 })
  ok(off.notes[0].step === 10, `默认不吸附:第 10 格保持 10(实得 ${off.notes[0].step})`)
  const on = quantizeNotes([{ start: 0.5, end: 1.0, midi: 60, confidence: 0.8 }], 2, { bpm: 100, anchor: 0, snapSteps: true })
  ok(on.notes[0].step === 9, `snapSteps=true(旧行为):第 10 格 → 第 9 格(实得 ${on.notes[0].step})`)
  const trip = quantizeNotes([{ start: 0.2, end: 0.5, midi: 60, confidence: 0.8 }], 2, { bpm: 100, anchor: 0 })
  ok(trip.notes[0].step === 4, `第 4 格(三连 8 分)本来就合法,保持不动(实得 ${trip.notes[0].step})`)
}

{
  // 整体左右移动(整格级):+1 格 = 谱面右移一格;−1 格会出现负 step,由 shift 归一化
  const raw = [{ start: 0.05, end: 0.55, midi: 60, confidence: 0.8 }]
  const q0 = quantizeNotes(raw, 2, { bpm: 100 })
  const plus = quantizeNotes(raw, 2, { bpm: 100, offsetSteps: 1 })
  const minus = quantizeNotes(raw, 2, { bpm: 100, offsetSteps: -1 })
  ok(q0.notes[0].step === 0, `基准:锚点取首音 → step 0(实得 ${q0.notes[0].step})`)
  ok(plus.notes[0].step === 1, `右移一格 → step +1(实得 ${plus.notes[0].step})`)
  ok(minus.notes[0].step === 0 && minus.shift === -1, `左移一格出现负步 → 记录 shift=${minus.shift} 并归一到 0`)
}

{
  // 自动密度:短素材绝不生效(实测缺陷:4 分钟的混音会被删掉大批弱奏音)
  const many = Array.from({ length: 40 }, (_, i) => ({ start: i * 0.05, end: i * 0.05 + 0.2, midi: 60 + (i % 5), confidence: 0.1 + (i % 10) * 0.08 }))
  const short = quantizeNotes(many, 20, { bpm: 100, autoDensity: true })
  ok(short.autoDensityInfo === null && short.notes.length > 0, '短素材(<90s)不触发自动密度')
  // 长素材:100s × 3 音/秒 = 300 音预算,这里给 900 个音 → 必然触发
  const dense = Array.from({ length: 900 }, (_, i) => ({
    start: i * 0.1,
    end: i * 0.1 + 0.09,
    midi: 60 + (i % 7),
    confidence: 0.1 + ((i * 37) % 90) / 100,
  }))
  const long = quantizeNotes(dense, 100, { bpm: 100, autoDensity: true, minConf: 0.05 })
  ok(long.autoDensityInfo !== null, '长素材(>90s)才触发自动密度')
  ok(long.notes.length < dense.length, `自动密度确实收敛了音符量(${dense.length} → ${long.notes.length})`)
  ok(long.effMinConf <= 0.6 + 1e-9, `自动密度阈值上限 0.6(实得 ${long.effMinConf.toFixed(2)}),强音不会被删`)
  ok(!long.notes.some((n) => n.conf < long.effMinConf - 1e-9), '保留的音都在阈值之上')
}

{
  // 复音上限:同一格最多 6 个音
  const chord = [40, 43, 45, 47, 50, 52, 55].map((midi) => ({ start: 0, end: 0.5, midi, confidence: 0.5 + midi / 1000 }))
  const q = quantizeNotes(chord, 2, { bpm: 100 })
  ok(q.notes.length === 6, `复音上限 6(7 → ${q.notes.length})`)
}

{
  // 调外音过滤:C 大调下 F# 被滤掉
  const raw = [
    { start: 0, end: 0.5, midi: 60, confidence: 0.8 }, // C
    { start: 0.5, end: 1.0, midi: 66, confidence: 0.8 }, // F#
    { start: 1.0, end: 1.5, midi: 67, confidence: 0.8 }, // G
  ]
  const noKey = quantizeNotes(raw, 2, { bpm: 100 })
  const withKey = quantizeNotes(raw, 2, { bpm: 100, keyFilter: { rootPc: 0, mode: 'major', name: 'C 大调' } })
  ok(noKey.notes.length === 3 && withKey.notes.length === 2, `调性过滤删掉调外音(3 → ${withKey.notes.length})`)
  ok(withKey.keyDropCount === 1, `调外音计数正确(${withKey.keyDropCount})`)
}

{
  // BPM 细化(refineBpm)的能力边界,刻意锁住当前语义:
  //   ① 只在初估的 ½–2 倍范围里搜;② 多个倍率都能贴合音符网格时,取最接近初估的那个;
  //   ③ 因此它**不能**纠正"初估是另一个同样贴合网格的倍率"这类错误
  //      (实测:Funk1-114 被估成 152,refineBpm 不会拉回 114 —— 因为 0.526s 的拍间隔
  //       同时是两种网格的整数格;这类仲裁只能靠 estimateBpm 先验/鼓轨提示,见 EVAL.md §7.4)
  const trueBpm = 100
  const starts = Array.from({ length: 12 }, (_, i) => i * (60 / trueBpm))
  ok(refineBpm(starts, trueBpm) === trueBpm, '初估正确时不乱动')
  ok(refineBpm(starts, trueBpm * 2) === trueBpm * 2, '2× 初估在网格上同样完美 → 保持不动(交给八度仲裁)')
  ok(Math.abs(refineBpm(starts, 143) - 143) <= 20, `偏离初估的倍率不会被强行拉走(${refineBpm(starts, 143)})`)
  ok(refineBpm([0, 1], 100) === 100, '音符太少(<4)时不做搜索')
  // 但真正的"网格不齐"必须被修好:初估 118 而实际拍点均匀落在 120
  const even = Array.from({ length: 16 }, (_, i) => i * (60 / 120))
  ok(Math.abs(refineBpm(even, 118) - 120) <= 2, `均匀拍点从 118 收敛到 ${refineBpm(even, 118)}`)
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
