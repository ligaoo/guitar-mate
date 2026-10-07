// 评测链路冒烟测试:render → engine → metrics 全链路可在秒级跑通,
// 且核心指标(严格档 / 含音尾 / 量化谱面 / BPM 判定 / WAV 往返)行为正确。
// 全量评测(含 Basic Pitch)留给 npm run eval,这里只守住"随时可评"的底线。

import { FIXTURES, guitarTruth } from './scripts/eval/fixtures'
import { renderClip } from './scripts/eval/render'
import { scoreNotes, scoreQuantized, judgeBpm } from './scripts/eval/metrics'
import { encodeWav, decodeWav } from './scripts/eval/wav'
import { transcribe, toMono } from './src/transcription/pipeline'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// ---- 1. WAV 往返:真实音频样例的加载路径与此等价 ----
{
  const ch = new Float32Array(8192)
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1
  const wav = encodeWav([ch], 22050)
  const dec = decodeWav(wav)
  let maxErr = 0
  for (let i = 0; i < ch.length; i++) maxErr = Math.max(maxErr, Math.abs(dec.channels[0][i] - ch[i]))
  ok(dec.sampleRate === 22050 && dec.channels.length === 1, `WAV 头:SR ${dec.sampleRate} · ${dec.channels.length} 声道`)
  ok(maxErr <= 0.6 / 32768, `16 位量化往返最大误差 ${(maxErr * 32768).toFixed(2)} LSB ≤ 0.6`)
}

// ---- 2. 指标 ----
{
  const ref = [
    { start: 0.5, dur: 0.4, midi: 60 },
    { start: 1.0, dur: 0.4, midi: 64 },
  ]
  // 完美命中
  const est = [
    { start: 0.51, dur: 0.39, midi: 60 },
    { start: 0.99, dur: 0.42, midi: 64 },
  ]
  const s = scoreNotes(ref, est)
  ok(s.f1 === 1 && s.strictF1 === 1 && s.onsetOffsetF1 === 1, `完美命中:严格 ${s.strictF1} / 含音尾 ${s.onsetOffsetF1} 均 1`)
  // 偏 40ms:±50ms 档命中、±25ms 严格档不命中
  const late = [
    { start: 0.54, dur: 0.4, midi: 60 },
    { start: 1.04, dur: 0.4, midi: 64 },
  ]
  const s2 = scoreNotes(ref, late)
  ok(s2.f1 === 1 && s2.strictF1 === 0, `+40ms:F1 ${s2.f1} / 严格 ${s2.strictF1}(严格档应失配)`)
  // 音尾差 0.3s:超过 max(0.12, 25%×0.4=0.1) → 该音符计失配,F1 从 1 降到 0.5
  const longTail = [
    { start: 0.5, dur: 0.7, midi: 60 },
    { start: 1.0, dur: 0.4, midi: 64 },
  ]
  const s3 = scoreNotes(ref, longTail)
  ok(s3.f1 === 1 && s3.onsetOffsetF1 === 0.5, `音尾 +0.3s:含音尾 ${s3.onsetOffsetF1} 应为 0.5(2 音符坏了 1 个)`)

  // 量化谱面:100BPM 12 细分,一格 0.05s
  const grid = [{ start: 0.5, dur: 0.5, midi: 60 }]
  const onGrid = [{ start: 0.52, dur: 0.5, midi: 60 }] // 0.52 与 0.5 同格(格 0)
  const offGrid = [{ start: 0.61, dur: 0.5, midi: 60 }] // 0.61 → 格 2(0.60),错格
  ok(scoreQuantized(grid, onGrid, 100).f1 === 1, '量化:同格命中')
  ok(scoreQuantized(grid, offGrid, 100).f1 === 0, '量化:错一格判失配')

  // BPM 判定
  ok(judgeBpm(100, 100) === 'ok' && judgeBpm(102, 100) === 'ok', 'BPM ±4% 内算对')
  ok(judgeBpm(199, 100) === 'octave', 'BPM 倍频算八度错')
  ok(judgeBpm(164, 100) === 'wrong', 'BPM 无关值判错')
}

// ---- 3. 引擎链路(DSP,快) ----
// 直接调用 transcribe(与 runDspEngine 同构),避免把 Basic Pitch 打进测试包
{
  // solo-guitar:单声部,DSP 的能力圈,F1 必须守住
  const clip = FIXTURES.find((c) => c.id === 'solo-guitar')
  if (!clip) {
    ok(false, 'fixture solo-guitar 缺失')
  } else {
    const rendered = renderClip(clip, 1)
    const out = transcribe(toMono([rendered.left, rendered.right], rendered.left.length), 22050)
    const truth = guitarTruth(clip)
    const est = out.notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
    const s = scoreNotes(truth, est)
    ok(s.f1 >= 0.9, `solo-guitar:DSP F1 ${s.f1.toFixed(3)} ≥ 0.9(标注 ${truth.length} / 识别 ${est.length})`)
    console.log(
      `     诊断:严格 ${s.strictF1.toFixed(2)} · 含音尾 ${s.onsetOffsetF1.toFixed(2)} · ` +
        `量化 ${scoreQuantized(truth, est, clip.bpm).f1.toFixed(2)} · BPM ${out.bpm}${judgeBpm(out.bpm, clip.bpm)}`,
    )
  }
  // guitar-bass:和弦复音,DSP 本就无能为力(基线 F1≈0),守护"跑通 + 复音标记正确"
  const clip2 = FIXTURES.find((c) => c.id === 'guitar-bass')
  if (!clip2) {
    ok(false, 'fixture guitar-bass 缺失')
  } else {
    const rendered = renderClip(clip2, 1)
    const out = transcribe(toMono([rendered.left, rendered.right], rendered.left.length), 22050)
    ok(out.notes.length > 0, `guitar-bass:DSP 有输出(${out.notes.length} 音)`)
    ok(out.likelyPolyphonic === true, 'guitar-bass:复音疑似标记生效(提示用户切换 BP)')
  }
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
