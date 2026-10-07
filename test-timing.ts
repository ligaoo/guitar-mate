// 起音对时回归(BP 的时间基准修正)
//
// 背景(ACCURACY.md §2.3):Basic Pitch 的音符起点来自 86fps 帧索引(11.6ms),
// 而 DSP 起音检测实测偏差 ≤3.4ms。用后者给前者的起点对时,实测量化谱面 F1 +7.4 点。
// 这里守住三件事:① 只在 ±tol 内移动;② 一个起音不会被两个音符共用;
// ③ 量化锚点取"最接近首音的起音",离得太远时回退首个音符。
import { retimeNotesToOnsets, pickAnchor } from './src/transcription/timing'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// 1. 帧量化误差 ±10ms 以内 → 吸附到起音,音高/时值不动
{
  const notes = [
    { start: 0.500, end: 0.900, midi: 60 },
    { start: 1.012, end: 1.400, midi: 64 },
    { start: 1.508, end: 1.900, midi: 67 },
  ]
  const onsets = [0.494, 0.998, 1.501]
  const r = retimeNotesToOnsets(notes, onsets)
  ok(r.moved === 3, `3 个音符全部对时(实得 ${r.moved})`)
  ok(
    r.notes.every((n, i) => Math.abs(n.start - onsets[i]) < 1e-9),
    `起点吸附到起音:${r.notes.map((n) => n.start.toFixed(3)).join(', ')}`,
  )
  ok(
    r.notes.every((n, i) => n.midi === notes[i].midi && n.end === notes[i].end),
    '音高与时值未被改动(只改时间)',
  )
}

// 2. 超出吸附半径的音符保持原样(不能把远处的音硬拉过来)
{
  const notes = [{ start: 2.0, end: 2.4, midi: 60 }]
  const r = retimeNotesToOnsets(notes, [1.5, 3.0])
  ok(r.moved === 0 && r.notes[0].start === 2.0, '±40ms 内无起音 → 不移动')
  const near = retimeNotesToOnsets(notes, [1.97])
  ok(near.moved === 1 && Math.abs(near.notes[0].start - 1.97) < 1e-9, '±40ms 内有起音 → 移动')
}

// 3. 一个起音最多吸附一个音符(否则相邻音会被粘到一起)
{
  const notes = [
    { start: 1.000, end: 1.2, midi: 60 },
    { start: 1.020, end: 1.22, midi: 64 },
  ]
  const r = retimeNotesToOnsets(notes, [1.005])
  const at = r.notes.filter((n) => Math.abs(n.start - 1.005) < 1e-9).length
  ok(r.moved === 1 && at === 1, `同一记号只吸附一个音符(移动 ${r.moved},落在起音上的 ${at})`)
  const shared = retimeNotesToOnsets(notes, [1.005], { allowShared: true })
  ok(shared.moved === 2, 'allowShared=true 时允许共用(备用开关)')
}

// 4. 空输入安全
{
  const r = retimeNotesToOnsets([], [0.5])
  ok(r.notes.length === 0 && r.moved === 0, '空音符表安全')
  const r2 = retimeNotesToOnsets([{ start: 0.5, end: 1, midi: 60 }], [])
  ok(r2.moved === 0 && r2.notes[0].start === 0.5, '空起音表安全(保持原时间)')
}

// 5. 量化锚点:优先最近的起音;起音离首音太远(前奏/噪声)时回退首个音符
{
  const notes = [{ start: 5.0, end: 5.4, midi: 60 }]
  ok(Math.abs(pickAnchor(notes, [4.0, 4.99, 6.0]) - 4.99) < 1e-9, '锚点取最接近首音的起音')
  ok(Math.abs(pickAnchor(notes, [0.2]) - 5.0) < 1e-9, '最近起音离首音 >0.5s → 回退首个音符(前奏噪声场景)')
  ok(Math.abs(pickAnchor(notes, []) - 5.0) < 1e-9, '无起音 → 首个音符')
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
