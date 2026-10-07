// 自动扒谱闭环回归:参数随 BPM 变化、动作改写、档位判定、质量分单调性、分段规划
import { baseParams, applyActions, planSegments, paramsKey, distortionIndex, DISTORTION_ROUTE } from './src/transcription/auto/plan'
import { assessSegment, classifyRegime, qualityScore, expectedF1From, CALIB, GATES, type SegmentMetrics } from './src/transcription/auto/quality'
import type { RawNote } from './src/transcription/pipeline'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// 1. 最短音长必须随 BPM 变化(固定帧数在快歌上会吃掉 16 分音符)
{
  const p = (bpm: number) => baseParams({ bpm, polyphonic: false, confMedian: 0.5, density: 3, distortion: 0 }).minNoteLenFrames
  const slow = p(60)
  const mid = p(100)
  const fast = p(150)
  const veryFast = p(200)
  console.log(`   最短音长:@60BPM ${slow} 帧 · @100 ${mid} · @150 ${fast} · @200 ${veryFast}`)
  ok(slow >= mid && mid >= fast && fast >= veryFast, '最短音长随 BPM 单调不增')
  ok(mid <= 8, `100 BPM 时 ≤8 帧(16 分音符 150ms = 12.9 帧,取 60% ≈ 8)`)
  ok(fast <= 6, `150 BPM 时 ≤6 帧(16 分 100ms = 8.6 帧)`)
  ok(veryFast >= 4, `200 BPM 时不小于下限 4 帧(实得 ${veryFast})`)
  ok(slow <= 12, `60 BPM 时被上限 12 帧夹住(实得 ${slow})`)
}

// 2. 干净档参数(2026-10-07 v2 扩界寻优 + holdout:ft0.60 两档最优)+ melodia 默认关
{
  const clean = baseParams({ bpm: 100, polyphonic: false, confMedian: 0.7, density: 2, distortion: 0 })
  const comp = baseParams({ bpm: 100, polyphonic: true, confMedian: 0.35, density: 8, distortion: 0 })
  ok(clean.onsetThresh === 0.55 && clean.frameThresh === 0.6, `干净独奏档 ot${clean.onsetThresh} ft${clean.frameThresh}(holdout 85.7%)`)
  ok(comp.onsetThresh === 0.5 && comp.frameThresh === 0.6, `复音档 ot${comp.onsetThresh} ft${comp.frameThresh}(holdout 71.1%)`)
  ok(comp.minNoteLenFrames < clean.minNoteLenFrames, `复音档最短音长更短(×0.3 vs ×0.6,快和弦敲击:${comp.minNoteLenFrames} < ${clean.minNoteLenFrames})`)
  ok(clean.melodiaTrick === false && comp.melodiaTrick === false, 'melodia:真实数据全面无益,默认关(solo/comp 都是,第 3 次确认)')
  ok(clean.minConf <= 0.4 && clean.minConf >= 0.15, `响度阈值跟随置信度(干净素材 ${clean.minConf.toFixed(2)})`)
  ok(comp.minConf < clean.minConf, `低置信素材响度阈值更低、不删空(${comp.minConf.toFixed(2)} < ${clean.minConf.toFixed(2)})`)
}

// 2b. 失真/音色路由:高失真素材切**召回优先**参数组(PLAN-90 阶段2,实测方向)
{
  const dist = baseParams({ bpm: 100, polyphonic: true, confMedian: 0.35, density: 3, distortion: 0.9 })
  ok(dist.onsetThresh === 0.35 && dist.frameThresh === 0.3, `失真档召回优先(ot${dist.onsetThresh} ft${dist.frameThresh},低于干净档)`)
  ok(dist.melodiaTrick === false, '失真档关 melodia(复音也关)')
  ok(dist.recallExtract === true, '失真档启用召回聚合提取(阶段 2 实装:实测 5.9%→20.6%)')
  const edge = baseParams({ bpm: 100, polyphonic: true, confMedian: 0.35, density: 3, distortion: DISTORTION_ROUTE - 0.01 })
  ok(edge.onsetThresh === 0.5 && edge.frameThresh === 0.6, `路由阈值两侧参数不同(阈值下方 ot${edge.onsetThresh} ft${edge.frameThresh})`)
  ok(edge.recallExtract === false, '干净档不启用聚合提取(单帧双阈值已是真实数据寻优最优)')
}

// 2c. 失真指数本身:削波连续音(低波峰因子)必须显著高于带衰减包络的干净音
{
  const N = 22050 // 1 秒
  const clipped = new Float32Array(N) // 连续 220Hz,硬削到 ±0.15 → 波峰因子低
  for (let i = 0; i < N; i++) clipped[i] = Math.max(-0.15, Math.min(0.15, 0.9 * Math.sin((2 * Math.PI * 220 * i) / 22050)))
  const cleanSig = new Float32Array(N) // 4 组衰减拨弦 → 波峰因子高
  for (let b = 0; b < 4; b++) {
    const t0 = Math.floor((b * N) / 4)
    for (let i = 0; t0 + i < N && i < 5000; i++) cleanSig[t0 + i] += Math.exp(-i / 900) * Math.sin((2 * Math.PI * 220 * i) / 22050)
  }
  let peak = 0
  for (const v of cleanSig) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < N; i++) cleanSig[i] = cleanSig[i] / (peak || 1)
  const dClip = distortionIndex(clipped)
  const dClean = distortionIndex(cleanSig)
  console.log(`   失真指数:削波 ${dClip.toFixed(2)} vs 干净拨弦 ${dClean.toFixed(2)}(路由阈值 ${DISTORTION_ROUTE})`)
  ok(dClip > DISTORTION_ROUTE, `削波连续音判定失真(${dClip.toFixed(2)} > ${DISTORTION_ROUTE})`)
  ok(dClean < DISTORTION_ROUTE, `干净拨弦判定干净(${dClean.toFixed(2)} < ${DISTORTION_ROUTE})`)
}

// 3. 动作改写与钳位
{
  let p = baseParams({ bpm: 100, polyphonic: true, confMedian: 0.5, density: 3, distortion: 0 })
  const k0 = paramsKey(p)
  p = applyActions(p, ['toggle-melodia-off'])
  ok(p.melodiaTrick === false, '动作:关掉 melodia')
  p = applyActions(p, ['raise-onset-thresh'])
  ok(p.onsetThresh > 0.5, `动作:抬起音阈值(${p.onsetThresh.toFixed(2)})`)
  for (let i = 0; i < 20; i++) p = applyActions(p, ['raise-onset-thresh', 'raise-frame-thresh', 'raise-min-conf'])
  ok(p.onsetThresh <= 0.75 && p.frameThresh <= 0.5 && p.minConf <= 0.6, `动作有上限(ot${p.onsetThresh} ft${p.frameThresh} conf${p.minConf})`)
  for (let i = 0; i < 20; i++) p = applyActions(p, ['lower-polyphony-cap', 'lower-min-note-len'])
  ok(p.maxPolyphony >= 4 && p.minNoteLenFrames >= 4, `动作有下限(poly${p.maxPolyphony} mnl${p.minNoteLenFrames})`)
  ok(paramsKey(p) !== k0, 'paramsKey 反映参数变化(报告里靠它区分尝试)')
}

// 4. 档位判定
{
  const base: SegmentMetrics = {
    notes: 50, density: 3, onsetSupport: 0.7, gridFit: 0.9, inKey: 0.95,
    confMedian: 0.6, lowConfShare: 0.2, feasibleRate: 1, ghostRate: 0.005, polyphonyMax: 1,
  }
  ok(classifyRegime(base) === 'clean-solo', `干净单音 → clean-solo(${classifyRegime(base)})`)
  ok(classifyRegime({ ...base, polyphonyMax: 3 }) === 'chordal', '有和弦 → chordal')
  ok(classifyRegime({ ...base, lowConfShare: 0.8 }) === 'dense-mix', '低置信多 → dense-mix')
  ok(classifyRegime({ ...base, density: 9 }) === 'dense-mix', '密度过高 → dense-mix')
}

// 5. 质量分单调性 + 判定门槛
{
  const good: SegmentMetrics = {
    notes: 50, density: 3, onsetSupport: 0.7, gridFit: 0.9, inKey: 0.95,
    confMedian: 0.6, lowConfShare: 0.2, feasibleRate: 1, ghostRate: 0.0, polyphonyMax: 2,
  }
  const bad: SegmentMetrics = { ...good, confMedian: 0.25, lowConfShare: 0.9, ghostRate: 0.2, feasibleRate: 0.7 }
  const sGood = qualityScore(good)
  const sBad = qualityScore(bad)
  console.log(`   质量分:好 ${sGood.toFixed(3)} vs 差 ${sBad.toFixed(3)}(门槛 ${GATES.pass}/${GATES.review})`)
  ok(sGood > sBad + 0.3, '质量分对"好/差"有明显区分度')
  ok(sGood >= GATES.pass, `"好"达到合格线(${sGood.toFixed(2)} ≥ ${GATES.pass})`)
  ok(sBad < GATES.review, `"差"低于待复核线(${sBad.toFixed(2)} < ${GATES.review})`)
}

// 6. 自评:归因必须按"加权亏损"排序(权重低的指标不该占据主要问题)
{
  const notes: RawNote[] = Array.from({ length: 20 }, (_, i) => ({
    start: i * 0.5, end: i * 0.5 + 0.3, midi: 60 + (i % 5), confidence: 0.25, velocity: 0.25,
  }))
  const a = assessSegment({
    notes, tab: [], dropped: [], onsets: [], bpm: 120, globalKey: null, duration: 10,
  })
  ok(a.verdict !== 'pass', `低置信素材判定不合格/待复核(${a.verdict} 分 ${a.score.toFixed(2)})`)
  ok(a.issues.length > 0 && a.issues[0].includes('低置信'), `主要问题指向低置信:${a.issues[0] ?? '(空)'}`)
  ok(a.expectedF1 !== null && a.expectedF1 >= 0 && a.expectedF1 <= 1, `可信标定下报出预计准确率(${((a.expectedF1 ?? -1) * 100).toFixed(0)}%)`)
  ok(a.regimeF1 > 0, `档位区间有值(${a.regimeF1})`)
}

// 6b. 标定门控:不可信时必须拒绝报预测(宁可缺席,不报假数)
{
  const saved = { ...CALIB }
  Object.assign(CALIB, { r: 0.3 })
  ok(expectedF1From(0.8) === null, 'r<0.6 时拒绝报预计准确率')
  Object.assign(CALIB, { r: saved.r, samples: 10 })
  ok(expectedF1From(0.8) === null, '样本<24 时拒绝报预计准确率')
  Object.assign(CALIB, { enabled: false, samples: saved.samples })
  ok(expectedF1From(0.8) === null, 'enabled=false 时拒绝报预计准确率')
  Object.assign(CALIB, saved)
  const e = expectedF1From(0.8)
  ok(e !== null && e >= 0 && e <= 1, `恢复后正常报预测(0.8 分 → ${((e ?? 0) * 100).toFixed(0)}%)`)
}

// 7. 分段规划:按小节切、不越界、段数可控
{
  const segs = planSegments(279, 149, 8)
  const secs = segs[0].t1 - segs[0].t0
  console.log(`   149BPM / 8 小节 → ${segs.length} 段,每段 ${secs.toFixed(1)} 秒`)
  ok(segs.length >= 15 && segs.length <= 30, `段数合理(${segs.length})`)
  ok(secs >= 10 && secs <= 30, `段长在 10~30 秒(${secs.toFixed(1)})`)
  ok(segs[0].t0 === 0 && Math.abs(segs[segs.length - 1].t1 - 279) < 1e-6, '覆盖整曲且不越界')
  ok(segs.every((s, i) => i === 0 || s.t0 >= segs[i - 1].t1 - 1e-9), '段与段不重叠、顺序正确')
  const many = planSegments(3000, 100, 8)
  ok(many.length <= 40, `超长音频段数封顶 40(实得 ${many.length})`)
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
