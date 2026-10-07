// BPM 仲裁回归(包络锁错周期 → 用音符网格纠正)
//
// 背景(ACCURACY.md §9.5):包络自相关在"吉他只弹八分音符/分解和弦"的素材上会锁到
// 错误周期 —— 实测合成混音 7 个样例里 4 个把 100 BPM 读成 164/50/165/164。
// BPM 错了整谱就错位:音符级 F1 55.5% 却只有 34.7% 的产品谱面 F1。
//
// 仲裁必须**保守**:真实 GuitarSet 上包络本来就有 7/8 正确,不能为了修混音把对的改错。
import { scoreBpmCandidate, arbitrateBpm } from './src/transcription/pipeline'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

/** 生成一段"每拍一个音 + 每隔 4 拍重音"的音符序列 */
const makeNotes = (bpm: number, beats: number, perBeat = 2, amp = 0.6) => {
  const p = 60 / bpm
  const out: { start: number; confidence: number }[] = []
  for (let i = 0; i < beats * perBeat; i++) {
    const beat = i / perBeat
    out.push({ start: i * (p / perBeat), confidence: beat % 4 === 0 ? 0.95 * amp + 0.05 : amp })
  }
  return out
}

// 1. 打分函数:贴合正确速度的分数必须明显高于错速度
{
  const notes = makeNotes(100, 16, 2)
  const s100 = scoreBpmCandidate(notes, 100, 12)
  const s164 = scoreBpmCandidate(notes, 164, 12).score
  ok(s100.gridFit > 0.95, `正确速度格内贴合 ${s100.gridFit.toFixed(3)} > 0.95`)
  ok(s100.score > s164 + 0.15, `100 BPM 的总分 ${s100.score.toFixed(3)} 明显高于 164(${s164.toFixed(3)})`)
  // 双倍速:格内同样贴合,但"重音对比"不该奖励它(没有反拍音 → 中性 0.5)
  const s200 = scoreBpmCandidate(notes, 200, 12)
  ok(s200.gridFit > 0.95 && s200.accent <= 0.55, `200 BPM 贴合但重音中性(accent ${s200.accent.toFixed(3)})`)
}

// 2. 均匀八分音符:包络常把它读成双倍速 → 仲裁应拉回
{
  const notes = makeNotes(100, 24, 2)
  const arb = arbitrateBpm(200, notes)
  ok(Math.abs(arb.bpm - 100) <= 4, `初估 200(双倍速)被拉回 ${arb.bpm}`)
  const keep = arbitrateBpm(100, notes)
  ok(Math.abs(keep.bpm - 100) <= 4, `初估 100 保持 ${keep.bpm}`)
}

// 3. 初估与真值不成倍频关系(包络锁到别的周期)→ 应被改写
{
  const notes = makeNotes(100, 24, 2)
  const arb = arbitrateBpm(164, notes)
  ok(Math.abs(arb.bpm - 100) <= 4, `初估 164(非倍频)被改写为 ${arb.bpm}(来源 ${arb.source})`)
  ok(arb.overridden, 'overridden 标记被置位')
}

// 4. 保守性:音符太少 / 无明显网格时不动初估
{
  ok(arbitrateBpm(123, [{ start: 0, confidence: 1 }]).bpm === 123, '音符太少(<6)不动初估')
  // 真·无网格:间隔在 0.13~0.23s 之间随机抖动(固定种子,可复现)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const noise: { start: number; confidence: number }[] = []
  let t = 0
  for (let i = 0; i < 30; i++) {
    t += 0.13 + rnd() * 0.1
    noise.push({ start: t, confidence: 0.3 + rnd() * 0.5 })
  }
  const arb = arbitrateBpm(123, noise)
  ok(arb.bpm === 123, `无明显网格时不乱改(123 → ${arb.bpm})`)
}

// 5. 鼓轨提示仲裁:改写结果与提示成 2×/½× → 以提示为准
{
  const notes = makeNotes(100, 24, 2)
  const arb = arbitrateBpm(200, notes, { hint: 100 })
  ok(arb.bpm === 100 && arb.source === 'hint', `鼓轨提示生效(200 → ${arb.bpm},来源 ${arb.source})`)
}

// 6. 三连音素材:不能因为"不在直音格上"就把速度改错
{
  const p = 60 / 120
  const notes = Array.from({ length: 48 }, (_, i) => ({ start: i * (p / 3), confidence: 0.7 }))
  const arb = arbitrateBpm(120, notes)
  ok(Math.abs(arb.bpm - 120) <= 3, `三连音素材保持 120(实得 ${arb.bpm})`)
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
