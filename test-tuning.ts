// 全曲音准校准回归:整体偏移 ±50 音分内的音频,识别音高必须恢复到标注半音
//
// 背景(EVAL.md §4.5):链路按 A4=440 直接算 MIDI,整体偏高/偏低时逐音符
// 产生系统性半音错音。tuning.ts 先估计整体偏移(直方图峰)再统一扣除。
// 本文件同时守护估计器本身与 DSP 管线的端到端效果。

import { transcribe } from './src/transcription/pipeline'
import { renderPluckSamples } from './src/audio/synth'
import { estimateTuningOffsetSemis, estimateTuningFromF0, estimateTuningFromPcm, shiftFramesPitch } from './src/transcription/tuning'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// ---- 1. 直方图估计器 ----
{
  // 100 帧全部 +0.25 半音 → 估计应接近 +0.25,support 高
  const devs = Array.from({ length: 100 }, () => 0.25 + (Math.random() - 0.5) * 0.02)
  const t = estimateTuningOffsetSemis(devs, devs.map(() => 1))
  ok(t !== null && Math.abs(t.semis - 0.25) < 0.03, `集中偏移估计:${t ? t.semis.toFixed(3) : 'null'} ≈ +0.25`)
  ok(t !== null && t.support > 0.9, `support ${t ? t.support.toFixed(2) : '-'} > 0.9`)

  // 均匀散布(无系统性偏移)→ 门控应拒绝(或 support 低到不触发修正)
  const uni = Array.from({ length: 200 }, (_, i) => (i / 200) * 0.9 - 0.45)
  const t2 = estimateTuningOffsetSemis(uni, uni.map(() => 1))
  ok(t2 === null || t2.support < 0.4, `散布输入被门控拒绝(support ${t2 ? t2.support.toFixed(2) : '-'})`)

  // 样本不足 → null
  ok(estimateTuningOffsetSemis([0.2, 0.2], [1, 1]) === null, '样本不足返回 null')
}

// ---- 2. f0 估计器 + 端到端 DSP ----
// 渲染用 44100Hz:KS 合成在 22050Hz 下周期取整会把每个音的实际偏移扰动 ±25 音分,
// 甚至越过 ±50¢ 折叠边界,夹具本身就不再是"均匀偏移"。4× 过采样渲染把该误差压到 ±1.5¢。
const SR = 22050
const RENDER_SR = 44100
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TRUTHS = [
  { t: 0.5, midi: 60 },
  { t: 1.0, midi: 64 },
  { t: 1.5, midi: 67 },
  { t: 2.0, midi: 62 },
]

const renderMelody = (cents: number): Float32Array => {
  const total = Math.ceil(2.6 * RENDER_SR)
  const data = new Float32Array(total)
  const ratio = Math.pow(2, cents / 1200)
  TRUTHS.forEach((n, i) => {
    const f = 440 * Math.pow(2, (n.midi - 69) / 12) * ratio
    const buf = renderPluckSamples(f, RENDER_SR, 0.42, 0.7, makeRng(1000 + i))
    const from = Math.round(n.t * RENDER_SR)
    for (let k = 0; k < buf.length && from + k < total; k++) data[from + k] += buf[k] * 0.85
  })
  return data
}

for (const cents of [25, -35]) {
  const data = renderMelody(cents)
  const r = transcribe(data, RENDER_SR)
  // ±15¢ 容差:KS 合成的环路滤波失谐随频率变化,夹具本身的每音偏移就有 ±10¢ 级散布;
  // 端到端正确性(下一条断言)才是真正要守住的行为
  ok(
    r.tuningCents !== undefined && Math.abs(r.tuningCents - cents) <= 15 && Math.sign(r.tuningCents) === Math.sign(cents),
    `偏移 ${cents}¢ 检测:tuningCents = ${r.tuningCents ?? 'undefined'}(方向正确,±15¢ 容差)`,
  )
  const wrong = r.notes.filter((n) => !TRUTHS.some((t) => t.midi === n.midi)).length
  ok(wrong === 0, `偏移 ${cents}¢ 下无错音(识别 ${r.notes.length} 音,错音 ${wrong})`)
}

// 偏 40 音分(接近边界且确定在 ±50¢ 内):不校准时 YIN 中位数落在半音之间,校准后必须恢复。
// 不用 44/49¢:KS 合成的环路滤波失谐(+5~7¢)会把渲染音频推到 +51¢ 以上、真的越过
// ±50¢ 折叠边界——那是文档记载的原理性盲区(整谱错半音),不该由本用例守护
{
  const cents = 40
  const data = renderMelody(cents)
  const r = transcribe(data, RENDER_SR)
  const hits = TRUTHS.filter((t) => r.notes.some((e) => e.midi === t.midi && Math.abs(e.start - t.t) <= 0.05)).length
  ok(hits >= 3, `偏移 40¢ 端到端:${hits}/4 音符音高正确`)
}

// ---- 3. 帧域移位(BP 路径) ----
{
  // 单峰激活在 bin 60(= midi 81),整体偏高 0.3 半音 → 下移 0.3 后质心应在 59.7
  const frames = Array.from({ length: 50 }, () => {
    const fr = new Array<number>(88).fill(0)
    fr[60] = 0.9
    fr[61] = 0.1
    return fr
  })
  const shifted = shiftFramesPitch(frames, 0.3)
  let cenS = 0
  let cenW = 0
  for (let b = 0; b < 88; b++) {
    cenS += shifted[0][b] * b
    cenW += shifted[0][b]
  }
  const centroid = cenS / cenW
  ok(Math.abs(centroid - 59.8) < 0.05, `下移 0.3 后质心 ${centroid.toFixed(2)} ≈ 59.8(60.1 − 0.3)`)
  // 总激活近似守恒(插值端点损失可忽略)
  const sumBefore = frames[0].reduce((a, b) => a + b, 0)
  const sumAfter = shifted[0].reduce((a, b) => a + b, 0)
  ok(Math.abs(sumAfter - sumBefore) < 1e-6, `插值保持总激活(${sumBefore.toFixed(3)} → ${sumAfter.toFixed(3)})`)
  // f0 估计器:构造恒定 442Hz(约 +7.9¢)的 f0 轨迹
  const f0 = new Float32Array(200).fill(442)
  const tf = estimateTuningFromF0(f0)
  ok(tf !== null && Math.abs(tf.semis * 100 - 7.85) < 2, `f0 估计 442Hz → ${tf ? (tf.semis * 100).toFixed(1) : 'null'}¢ ≈ +7.9¢`)
  // PCM 直测(BP 路径用):442Hz 正弦 → +7.9¢
  {
    const sr = 22050
    const pcm = new Float32Array(sr * 2)
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 442 * i) / sr)
    const tp = estimateTuningFromPcm(pcm, sr)
    ok(tp !== null && Math.abs(tp.semis * 100 - 7.85) < 3, `PCM 估计 442Hz 正弦 → ${tp ? (tp.semis * 100).toFixed(1) : 'null'}¢ ≈ +7.9¢`)
  }
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
