// 端到端回归:长(>90s)失真整曲 × 网页端导入默认值(PLAN-90 §7.2 第 1/3/5 条)
//
// 两个 P0 bug 都只出现在这条路径上,而所有既有测试都绕开了它:
//   · 自动密度(>90s 只留响度前 3 音/秒)在失真预设下没关 → 召回优先的输出被砍掉 80%
//   · 导入默认开 DSP 分轨(失真混音上净亏)、最高品 15(高把位音被丢)
// 这里复刻页面「导入 → 识别 → 重建谱面」的完整后处理链(importDefaults → postProcessFrames
// → quantizeNotes(页面同参)→ assignFingering),输入是模拟密集节奏吉他的合成帧矩阵:
// 150 BPM、每个 8 分音符一次 4 音扫弦 = 20 音/秒,真实失真整曲的量级(《God knows》参考谱 25 音/秒)。
// 不需要模型或数据文件,CI 也能跑。
import { postProcessFrames, bpPreset, bpTimeToFrame, ensureBackend } from './src/transcription/basicPitch'
import { quantizeNotes } from './src/transcription/quantize'
import { assignFingering } from './src/transcription/fingering'
import { STANDARD_TUNING } from './src/theory/tunings'
import { importDefaults, presetPostOptions } from './src/transcription/importDefaults'
import { DISTORTION_ROUTE } from './src/transcription/auto/plan'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// ---- 1) 导入默认值:失真档必须同时关掉三个"净亏"项 ----
{
  const dist = importDefaults(0.98)
  const clean = importDefaults(0.1)
  ok(dist.presetId === 'dist' && clean.presetId === 'mix', `失真指数分档:0.98 → ${dist.presetId},0.10 → ${clean.presetId}(路由阈值 ${DISTORTION_ROUTE})`)
  ok(!dist.autoDensity && !dist.removeOctaveGhosts, '失真档:自动密度关、八度重影过滤关')
  ok(!dist.separate, '失真档:默认不分轨(DSP 分轨在失真混音上净亏)')
  ok(dist.maxFret === 22, `失真档:最高品 22(实得 ${dist.maxFret})`)
  ok(clean.autoDensity && clean.separate && clean.maxFret === 15, '干净档:保持原默认(自动密度开、分轨开、15 品)')
  ok(presetPostOptions('dist').autoDensity === false && presetPostOptions('solo').autoDensity === true, '手动切预设时附带的开关与导入默认一致')
}

// ---- 2) 合成"失真整曲"帧矩阵:150 BPM × 120s,8 分音符扫弦,和弦每小节换 ----
const BPM = 150
const DUR = 120
const EIGHTH = 60 / BPM / 2
const CHORDS = [
  [40, 47, 52, 55], // Em
  [45, 52, 57, 60], // Am
  [43, 50, 55, 59], // G
  [50, 54, 57, 62], // D(标准调弦下全部可弹)
]
const nFrames = bpTimeToFrame(DUR) + 1
const frames: number[][] = Array.from({ length: nFrames }, () => new Array<number>(88).fill(0))
const onsets: number[][] = Array.from({ length: nFrames }, () => new Array<number>(88).fill(0))
let truth = 0
for (let t = 0.5, i = 0; t < DUR - 1; t += EIGHTH, i++) {
  const chord = CHORDS[Math.floor(i / 8) % CHORDS.length]
  const f0 = bpTimeToFrame(t)
  // 每次扫弦只响到下一次扫弦前的一半:真实帧激活在重复扫弦之间会掉下去(闷音/换拍)。
  // 间隙(0.1s)刻意远离提取器的同音高合并门限(0.06s,帧时基每 172 帧还有 10ms 跳变),
  // 让本测试只考"页面默认值"这一件事
  const f1 = bpTimeToFrame(t + EIGHTH * 0.5)
  // 失真混音的典型样貌:响度普遍不高(0.30~0.45)、起音头弱 —— 自动密度会把它们当"弱音"删掉
  const amp = 0.3 + 0.15 * ((i * 7) % 5) / 4
  for (const m of chord) {
    onsets[f0][m - 21] = Math.max(onsets[f0][m - 21], 0.45)
    for (let f = f0; f <= f1 && f < nFrames; f++) frames[f][m - 21] = Math.max(frames[f][m - 21], amp)
    truth++
  }
}

async function main() {
  await ensureBackend(true)
  const def = importDefaults(0.98)
  const p = bpPreset(def.presetId)
  const r = await postProcessFrames(
    frames,
    onsets,
    {
      ...p,
      removeOctaveGhosts: def.removeOctaveGhosts,
      retime: false,
      lowestMidi: STANDARD_TUNING[0],
      highestMidi: STANDARD_TUNING[5] + 22,
    },
    DUR,
  )
  const page = (autoDensity: boolean, maxFret: number) => {
    const q = quantizeNotes(r.notes, r.duration, { bpm: BPM, anchor: 0.5, offsetSteps: 0, minConf: def.minConf, autoDensity, keyFilter: null })
    const fg = assignFingering(q.notes, STANDARD_TUNING, maxFret)
    return { quantized: q.notes.length, tab: fg.notes.length, info: q.autoDensityInfo }
  }
  const fixed = page(def.autoDensity, def.maxFret)
  const old = page(true, 15)
  console.log(`   合成谱 ${truth} 音(${(truth / DUR).toFixed(1)} 音/秒)· 识别 ${r.notes.length} · 页面默认谱面 ${fixed.tab} · 旧默认(自动密度开)谱面 ${old.tab}${old.info ? '(' + old.info + ')' : ''}`)
  ok(r.notes.length >= truth * 0.9, `召回优先预设识别出 ≥90% 的扫弦音(${r.notes.length}/${truth})`)
  ok(fixed.tab >= r.notes.length * 0.9, `页面默认设置下谱面保留 ≥90% 的识别音(${fixed.tab}/${r.notes.length})`)
  ok(old.tab < fixed.tab * 0.5, `对照:旧默认(自动密度开)会砍掉一半以上(${old.tab} vs ${fixed.tab})—— 本测试确实覆盖了该 bug`)
  console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
