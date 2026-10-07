// Basic Pitch 后处理自测:被拆音符的合并 + 八度重影过滤 + 贝斯谐波幽灵修剪
//
// 回归背景:melodia 后处理会把一个持续音拆成两段首尾相接的同音高碎片
// (合成单声部样例上 56 个标注音被输出成 114 个),这些碎片会被算成假阳性。
import { mergeAdjacentSamePitch, removeOctaveGhosts, pruneBassHarmonicGhosts } from './src/transcription/basicPitch'
import type { RawNote } from './src/transcription/pipeline'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const n = (start: number, end: number, midi: number, amp = 0.6): RawNote => ({
  start,
  end,
  midi,
  confidence: amp,
  velocity: amp,
})

// ---- 合并被拆的持续音 ----
{
  const merged = mergeAdjacentSamePitch([n(0.8, 0.975, 62), n(0.975, 1.23, 62)])
  ok(merged.length === 1, `首尾相接的同音高被合并(2 → ${merged.length})`)
  ok(
    merged.length === 1 && Math.abs(merged[0].start - 0.8) < 1e-9 && Math.abs(merged[0].end - 1.23) < 1e-9,
    `合并后区间为 [0.800, 1.230]`,
  )
}

{
  const merged = mergeAdjacentSamePitch([n(0, 0.2, 60), n(0.28, 0.4, 60)])
  ok(merged.length === 2, `间隔 80ms(> 阈值 30ms)的同音重复不被合并(保留 ${merged.length} 段)`)
}

{
  // 关键用例:延音 A 还没结束,中间插进另一个音高,再出现 A 的碎片。
  // 若只跟排序后紧邻的上一个音比较,这里会断链,碎片就漏合了。
  const merged = mergeAdjacentSamePitch([n(0, 0.2, 60), n(0, 0.45, 72), n(0.2, 0.45, 60)])
  ok(merged.length === 2, `中间夹其它音高时仍能合并同音碎片(3 → ${merged.length})`)
  const sixty = merged.find((m) => m.midi === 60)
  ok(
    !!sixty && Math.abs(sixty.start) < 1e-9 && Math.abs(sixty.end - 0.45) < 1e-9,
    '合并后的 60 号音区间为 [0.000, 0.450]',
  )
}

{
  const merged = mergeAdjacentSamePitch([n(0, 0.2, 60), n(0.21, 0.4, 62)])
  ok(merged.length === 2, '相邻但音高不同的音不被合并')
}

{
  // 重叠(后段起点早于前段终点)也应合并
  const merged = mergeAdjacentSamePitch([n(0, 0.3, 60), n(0.28, 0.5, 60)])
  ok(merged.length === 1, '轻微重叠的同音高被合并')
}

{
  const merged = mergeAdjacentSamePitch([n(0, 0.1, 60), n(0.1, 0.2, 60), n(0.2, 0.35, 60)])
  ok(merged.length === 1 && Math.abs(merged[0].end - 0.35) < 1e-9, '三段连续同音高合并为一段')
}

{
  // 与顺序无关:输入打乱后结果一致
  const a = mergeAdjacentSamePitch([n(0.975, 1.23, 62), n(0.8, 0.975, 62)])
  ok(a.length === 1 && Math.abs(a[0].start - 0.8) < 1e-9, '输入顺序不影响合并结果')
}

{
  const merged = mergeAdjacentSamePitch([n(0, 0.2, 60, 0.3), n(0.2, 0.4, 60, 0.9)])
  ok(merged.length === 1 && merged[0].confidence === 0.9, '合并后取较大的置信度')
}

// ---- 八度重影 ----
{
  const out = removeOctaveGhosts([n(0, 0.5, 60, 0.8), n(0, 0.5, 72, 0.3)])
  ok(out.length === 1 && out[0].midi === 60, `同段八度重影保留响度大的(留下 midi ${out[0]?.midi})`)
}

{
  const out = removeOctaveGhosts([n(0, 0.5, 60, 0.8), n(0, 0.5, 64, 0.5)])
  ok(out.length === 2, '同段不同音高(三度)都保留')
}

{
  const out = removeOctaveGhosts([n(0, 0.5, 60, 0.8), n(0, 0.5, 84, 0.2)])
  ok(out.length === 1 && out[0].midi === 60, '差两个八度(24 半音)的重影也被去掉')
}

// ---- 八度重影:和弦形态里的真实八度加倍要保留(ACCURACY.md §4.2)----
{
  // E2+B2+E3 = E 和弦把位(根音 + 五音 + 八度):旧规则会删掉 E3
  const chord = [n(0, 0.5, 40, 0.6), n(0, 0.5, 47, 0.55), n(0, 0.5, 52, 0.5)]
  const kept = removeOctaveGhosts(chord)
  ok(kept.length === 3, `和弦内的八度加倍被保留(3 → ${kept.length})`)
  const blunt = removeOctaveGhosts(chord, { keepChordOctaves: false })
  ok(blunt.length === 2, `关掉例外时回到原规则(3 → ${blunt.length},证明例外确实生效)`)
}

{
  // 双音(根音 + 八度)仍按原规则处理:孤立的弱八度依然是幽灵
  const dyad = [n(0, 0.5, 40, 0.6), n(0, 0.5, 52, 0.4)]
  const kept = removeOctaveGhosts(dyad)
  ok(kept.length === 1 && kept[0].midi === 40, `双音里的弱八度仍判为幽灵(留下 ${kept.map((x) => x.midi).join(',')})`)
}

// ---- 组合:先合并再过滤重影(与 postProcessFrames 的顺序一致) ----
{
  const raw = [n(0, 0.2, 60, 0.9), n(0.2, 0.45, 60, 0.9), n(0, 0.45, 72, 0.2)]
  const out = removeOctaveGhosts(mergeAdjacentSamePitch(raw))
  ok(out.length === 1 && out[0].midi === 60, `合并 + 重影过滤后只剩 1 个音(实得 ${out.length})`)
}

// ---- 贝斯谐波幽灵修剪 ----
const bass = [{ start: 1.0, end: 2.2, midi: 28 }] // 真贝斯 E1(低于吉他音域)

{
  // 与贝斯同帧起音、+12 关系、弱激活 → 幽灵,剪掉
  const out = pruneBassHarmonicGhosts([n(1.0, 1.5, 40, 0.2), n(1.3, 1.8, 52, 0.7)], bass)
  ok(out.length === 1 && out[0].midi === 52, '同帧起音的 +12 弱音被剪,强音保留')
}

{
  // 起音错开 0.2s 的真双打:即使 +12 且偏弱,也保留(合成对齐场景反噬的教训)
  const out = pruneBassHarmonicGhosts([n(1.2, 1.7, 40, 0.2), n(1.3, 1.8, 52, 0.7)], bass)
  ok(out.length === 2, '起音错开 0.2s 的 +12 音不被剪')
}

{
  // 参照音都在吉他音域内(独奏吉他漏进贝斯茎的情形)→ 整批参照作废,不剪
  const guitarRangeRefs = [{ start: 1.0, end: 2.0, midi: 45 }]
  const out = pruneBassHarmonicGhosts([n(1.0, 1.5, 57, 0.2)], guitarRangeRefs)
  ok(out.length === 1, '参照不低于吉他音域时修剪自动关闭')
}

{
  // 高置信度的 +12 同帧音(真实强双打)不受绝对门槛影响
  const out = pruneBassHarmonicGhosts([n(1.0, 1.5, 40, 0.8), n(1.4, 1.9, 55, 0.9)], bass)
  ok(out.length === 2 && out.some((x) => x.midi === 40), '强激活的同帧 +12 音保留')
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
