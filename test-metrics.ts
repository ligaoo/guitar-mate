// 评测指标自测:最大二分匹配 / 多指标语义 / 分数级指标 / 随机基线(PLAN-90 阶段 1)
import { scoreNotes, scoreTabCells, shiftNotes } from './scripts/eval/metrics'
import type { EvalNote } from './scripts/eval/types'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const n = (start: number, midi: number, dur = 0.2): EvalNote => ({ start, dur, midi })

// ---- 最大二分匹配:贪心会输的交叉情形 ----
// ref A(t=0) B(t=0.05);est a(t=0.045) b(t=0.095),容差 50ms。
// 贪心按距离先配 B–a(5ms),A 只剩 b(95ms,超容差)→ 1 TP;
// 最大匹配 A–a(45ms)+ B–b(45ms)→ 2 TP。
{
  const ref = [n(0, 60), n(0.05, 60)]
  const est = [n(0.045, 60), n(0.095, 60)]
  const s = scoreNotes(ref, est, 0.05)
  ok(s.tp === 2, `交叉情形取最大匹配(tp=${s.tp},贪心只会得到 1)`)
  ok(s.f1 === 1, `全对上时 F1=1(f1=${s.f1.toFixed(3)})`)
}

// ---- 多指标语义:同一组输出,exact / 音级 / ±12 容差必须分开计数 ----
{
  const ref = [n(0, 60), n(0.5, 64)]
  const est = [n(0.01, 72), n(0.51, 64)] // 第一个音高差 +12(八度),第二个精确
  const s = scoreNotes(ref, est, 0.05)
  ok(s.tp === 1 && s.octaveErrors === 1, `精确命中 1 + 八度误配 1(tp=${s.tp},oct=${s.octaveErrors})`)
  ok(s.octaveTolF1 === 1, `±12/24 容差档全对(F1=${s.octaveTolF1.toFixed(3)})`)
  ok(s.chromaF1 === 1, `音级档(忽略八度)全对(F1=${s.chromaF1.toFixed(3)})`)
  ok(s.f1 < s.octaveTolF1, `精确档 < 容差档(${s.f1.toFixed(2)} < ${s.octaveTolF1.toFixed(2)})`)
}
{
  const ref = [n(0, 60), n(0.5, 64)]
  const est = [n(0.01, 61), n(0.51, 64)] // 第一个差 +1 半音(既非同音级也非八度),第二个精确
  const s = scoreNotes(ref, est, 0.05)
  ok(s.chromaF1 < 1 && s.octaveTolF1 < 1, `非八度差(+1)不享受容差档(chroma=${s.chromaF1.toFixed(2)} octTol=${s.octaveTolF1.toFixed(2)})`)
}

// ---- onsetOnly:只看时间 ----
{
  const ref = [n(0, 60)]
  const est = [n(0.01, 90)]
  const s = scoreNotes(ref, est, 0.05)
  ok(s.onsetOnlyF1 === 1 && s.f1 === 0, `时间对上但音高全错:onsetOnly=1 / exact=0(${s.onsetOnlyF1}/${s.f1})`)
}

// ---- 随机基线:输出整体错开后,exact 应跌到接近 0(全错开时无配对) ----
{
  const ref: EvalNote[] = []
  for (let i = 0; i < 50; i++) ref.push(n(i * 0.5, 60 + (i % 12)))
  const est = ref.map((x) => n(x.start, x.midi))
  const exact = scoreNotes(ref, est, 0.05)
  const base = scoreNotes(ref, shiftNotes(est, 1.37), 0.05)
  ok(exact.f1 === 1 && base.f1 === 0, `平移 1.37s 后 exact 归零(${exact.f1.toFixed(2)} → ${base.f1.toFixed(2)})`)
}

// ---- 分数级指标(尺子 B):格×弦×品 / 小节×弦×品 ----
{
  const ref = [
    { step: 0, string: 0, fret: 0 },
    { step: 0, string: 1, fret: 2 },
    { step: 48, string: 0, fret: 1 }, // 第 2 小节
  ]
  const same = scoreTabCells(ref, [...ref])
  ok(same.f1 === 1 && same.tp === 3, `完全一致:格级 F1=1(${same.f1.toFixed(2)},tp=${same.tp})`)
  const offByGrid = scoreTabCells(ref, [
    { step: 1, string: 0, fret: 0 }, // 差 1 格(16 分的三分之一):格级错,小节级对
    { step: 0, string: 1, fret: 2 },
    { step: 48, string: 0, fret: 1 },
  ])
  ok(offByGrid.f1 < 1, `差 1 格:格级 F1 < 1(${offByGrid.f1.toFixed(2)})`)
  const byMeasure = scoreTabCells(ref, [
    { step: 1, string: 0, fret: 0 },
    { step: 0, string: 1, fret: 2 },
    { step: 48, string: 0, fret: 1 },
  ], 'measure')
  ok(byMeasure.f1 === 1, `差 1 格但同小节:小节级 F1=1(${byMeasure.f1.toFixed(2)})——粗粒度对 ±50ms 抖动不敏感`)
  const wrongString = scoreTabCells(ref, [
    { step: 0, string: 5, fret: 0 },
    { step: 0, string: 1, fret: 2 },
    { step: 48, string: 0, fret: 1 },
  ])
  ok(wrongString.f1 < 1, `同音高不同弦位:分数级判错(F1=${wrongString.f1.toFixed(2)};尺子 B 的意义所在)`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
