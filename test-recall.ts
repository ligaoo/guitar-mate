// 召回优先聚合提取自测(PLAN-90 阶段 2):合成帧矩阵验证提取语义
//  · onset+帧双证据的音要被提出
//  · 「onset 弱但持续强」的音也要被提出(单帧双阈值会丢——这正是聚合提取的存在理由)
//  · droop 容忍:段中短暂跌破门限不拆成两个音
//  · 门限之下的噪声不提
import { extractNotesAggressive, RECALL_EXTRACT_DEFAULTS, bpFrameTimeSec } from './src/transcription/basicPitch'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const NF = 320
const NB = 88
const frames: number[][] = Array.from({ length: NF }, () => new Array<number>(NB).fill(0))
const onsets: number[][] = Array.from({ length: NF }, () => new Array<number>(NB).fill(0))
const put = (m: number[][], f0: number, f1: number, b: number, v: number) => {
  for (let f = f0; f <= f1; f++) m[f][b] = v
}

const B60 = 60 - 21
const B64 = 64 - 21
const B67 = 67 - 21
// A(midi60):帧 0.5 + onset 0.6 —— 标准音
put(frames, 20, 60, B60, 0.5)
put(onsets, 19, 19, B60, 0.6)
// B(midi64):onset 弱(0.05)但持续强(0.45)—— 单帧双阈值(onset 头卡 0.3+)会丢
put(frames, 100, 150, B64, 0.45)
put(onsets, 99, 99, B64, 0.05)
// C(midi67):持续 0.5,中段 220~222 跌到 0.12(> droop 下限 0.11)—— 应合并为一个音
put(frames, 200, 260, B67, 0.5)
put(frames, 220, 222, B67, 0.12)
put(onsets, 199, 199, B67, 0.4)
// D(midi71):全程 0.1,低于段落门限 0.22 —— 不提
put(frames, 200, 260, 71 - 21, 0.1)

const notes = extractNotesAggressive(frames, onsets, RECALL_EXTRACT_DEFAULTS, { minNoteLenFrames: 4, lowestMidi: 40, highestMidi: 86 })
const at = (midi: number) => notes.filter((x) => x.midi === midi)

ok(notes.length === 3, `恰好 3 个音(A/B/C;D 在门限下被拒)—— 实得 ${notes.length}:[${notes.map((x) => x.midi).join(',')}]`)
ok(at(60).length === 1, `A(onset+帧双证据)被提出(${at(60).length})`)
const b = at(64)
ok(b.length === 1, `B(onset 弱 0.05 + 持续 0.45)被提出(${b.length})—— 单帧双阈值会丢,聚合提取的存在理由`)
ok(b[0]?.confidence !== undefined && b[0].confidence > 0 && b[0].confidence < 0.5, `B 的聚合 conf 反映弱证据(${b[0]?.confidence.toFixed(2)},不含 onset 分量时 ≈0.45×均值)`)
const c = at(67)
ok(c.length === 1, `C(段中 3 帧跌破但 ≥ droop 下限)合并为 1 个音,不拆分(${c.length})`)
ok(c.length === 1 && c[0].end > bpFrameTimeSec(255), `C 的时值覆盖跌落后段(end=${c[0]?.end.toFixed(2)}s > 帧255)`)

// 参数化:抬高段落门限到 0.5 → A(0.5 峰值)与 C 边缘、B 仍在(0.45<0.5 会掉!)——验证门限方向
const strict = extractNotesAggressive(frames, onsets, { ...RECALL_EXTRACT_DEFAULTS, frameGate: 0.48 }, { minNoteLenFrames: 4, lowestMidi: 40, highestMidi: 86 })
ok(!strict.some((x) => x.midi === 64), `frameGate 0.48 > B 的峰值 0.45:B 被拒(门限方向正确)`)
ok(strict.some((x) => x.midi === 67), `C(峰值 0.5)在 0.48 门限下仍在`)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
