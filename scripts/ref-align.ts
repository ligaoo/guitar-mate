// 参考谱 ↔ 音频对齐:把 Songsterr 事件表映射到录音时间轴。
//
// 为什么要对齐:谱面按标称 BPM(150)排时间;录音实际 ~149 且起始有偏移,
// 4.6 分钟累计漂移 ~2s——不对齐就没法做音符级校验(±50ms 口径)。
//
// 做法:
//   ① 用产品同款 DSP 起音检测拿音频起音列
//   ② 粗对齐:网格搜 (offset, scale),最大化「谱面起音在容差内命中音频起音」的加权得分
//   ③ 精对齐:对命中对做稳健线性回归(去中值残差外点,两轮)
//   ④ 输出 audioT = scoreT × scale + offset + 逐段残差诊断
//
// 用法:esbuild 打包后 node .ref-align.cjs --audio=x.wav --events=lead-events.json [--rhythm=...] --out=align.json
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR } from '../src/transcription/pipeline'
import { bpTimeToFrame } from '../src/transcription/basicPitch'
import { decodeWav } from './eval/wav'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name: string, def = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

interface Ev { t: number; dur: number; midi: number; string: number; fret: number }

async function main() {
  const audioPath = flag('audio')
  const eventFiles = [flag('events'), flag('rhythm')].filter(Boolean)
  const outFile = flag('out', 'ref-align.json')
  if (!audioPath || !eventFiles.length) {
    console.error('用法:--audio=<wav> --events=<lead.json> [--rhythm=<rhythm.json>] --out=<align.json>')
    process.exit(1)
  }

  const scoreOnsets: number[] = []
  for (const f of eventFiles) {
    const evs = (JSON.parse(readFileSync(f, 'utf8')) as { events: Ev[] }).events
    for (const e of evs) scoreOnsets.push(e.t)
  }
  scoreOnsets.sort((a, b) => a - b)

  const raw = await readFile(audioPath).catch(() => null)
  if (!raw) {
    console.error(`读不到音频:${audioPath}`)
    process.exit(1)
  }
  const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const mono = wav.channels.length === 1 ? wav.channels[0] : toMono(wav.channels, wav.channels[0].length)
  const pcm = resampleLinear(mono, wav.sampleRate, SR)
  const duration = pcm.length / SR
  const audioOnsets = estimateOnsets(pcm, SR)
  console.log(`音频 ${duration.toFixed(1)}s · 起音 ${audioOnsets.length} 个 · 谱面起音 ${scoreOnsets.length} 个(${eventFiles.length} 轨)`)

  // ---------- ② 粗对齐:offset × scale 网格 ----------
  const TOL = 0.06
  const score = (offset: number, scale: number): { hits: number; w: number } => {
    let hits = 0
    let w = 0
    let ai = 0
    for (const s of scoreOnsets) {
      const at = s * scale + offset
      while (ai < audioOnsets.length - 1 && audioOnsets[ai + 1] < at - TOL) ai++
      let best = Infinity
      for (let k = Math.max(0, ai - 2); k <= Math.min(audioOnsets.length - 1, ai + 3); k++) {
        const d = Math.abs(audioOnsets[k] - at)
        if (d < best) best = d
      }
      if (best <= TOL) {
        hits++
        w += 1 - best / TOL
      }
    }
    return { hits, w }
  }

  let best = { offset: 0, scale: 1, hits: 0, w: -1 }
  for (let scale = 0.998; scale <= 1.012; scale += 0.0005) {
    for (let offset = -4; offset <= 4; offset += 0.05) {
      const r = score(offset, scale)
      if (r.w > best.w) best = { offset: +offset.toFixed(3), scale: +scale.toFixed(4), hits: r.hits, w: +r.w.toFixed(1) }
    }
  }
  console.log(`粗对齐:offset ${best.offset}s · scale ${best.scale} · 命中 ${best.hits}/${scoreOnsets.length}(${((best.hits / scoreOnsets.length) * 100).toFixed(1)}%)`)

  // ---------- ③ 精对齐:命中对稳健线性回归 ----------
  const pairs: Array<[number, number]> = [] // [scoreT, audioT]
  {
    let ai = 0
    for (const s of scoreOnsets) {
      const at = s * best.scale + best.offset
      while (ai < audioOnsets.length - 1 && audioOnsets[ai + 1] < at - TOL) ai++
      let bk = -1
      let bd = Infinity
      for (let k = Math.max(0, ai - 2); k <= Math.min(audioOnsets.length - 1, ai + 3); k++) {
        const d = Math.abs(audioOnsets[k] - at)
        if (d < bd) {
          bd = d
          bk = k
        }
      }
      if (bk >= 0 && bd <= TOL) pairs.push([s, audioOnsets[bk]])
    }
  }
  const fitLinear = (pts: Array<[number, number]>): { a: number; b: number } => {
    const n = pts.length
    const ms = pts.reduce((x, p) => x + p[0], 0) / n
    const ma = pts.reduce((x, p) => x + p[1], 0) / n
    let num = 0
    let den = 0
    for (const [s, a] of pts) {
      num += (s - ms) * (a - ma)
      den += (s - ms) ** 2
    }
    const b = den > 0 ? num / den : 1
    return { a: ma - b * ms, b }
  }
  let fit = fitLinear(pairs)
  for (let round = 0; round < 2; round++) {
    const res = pairs.map((p) => Math.abs(p[1] - (fit.a + fit.b * p[0])))
    res.sort((x, y) => x - y)
    const med = res[res.length >> 1]
    const keep = pairs.filter((p) => Math.abs(p[1] - (fit.a + fit.b * p[0])) <= Math.max(0.03, 2.5 * med))
    fit = fitLinear(keep)
  }
  const finalRes = pairs.map((p) => p[1] - (fit.a + fit.b * p[0])).sort((x, y) => x - y)
  const hitRate = score(fit.a, fit.b).hits / scoreOnsets.length
  console.log(`精对齐:audioT = ${fit.a.toFixed(3)} + ${fit.b.toFixed(5)} × scoreT · 匹配对 ${pairs.length}`)
  console.log(`残差:中位 ${finalRes[finalRes.length >> 1].toFixed(3)}s · P90 ${finalRes[Math.floor(finalRes.length * 0.9)].toFixed(3)}s · 命中率 ${(hitRate * 100).toFixed(1)}%`)

  // ---------- ②b 音高敏感消歧(修"差一拍"bug,2026-10-07)----------
  // 起音列车无法分辨整拍平移(±1 拍的命中率几乎相同),但**音高激活**可以:
  // 只有真正的偏移会让参考音符的音高在对应时刻的帧激活上亮起来。
  // --frames=<缓存目录> 时启用:对 [估计值 ± 2 拍] 的候选逐一计算平均音高激活。
  const framesDir = flag('frames')
  if (framesDir) {
    const readF32 = (p: string) => {
      const b = readFileSync(p)
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    }
    const meta = JSON.parse(readFileSync(join(framesDir, 'frame-cache.meta.json'), 'utf8')) as { nFrames: number; nBins: number }
    const framesF = readF32(join(framesDir, 'frame-cache.frames.f32'))
    const pitchAt = (t: number, midi: number): number => {
      const b = midi - 21
      if (b < 0 || b >= meta.nBins) return 0
      const f0 = Math.max(0, bpTimeToFrame(Math.max(0, t)))
      const f1 = Math.min(meta.nFrames - 1, bpTimeToFrame(t + 0.06))
      let m = 0
      for (let f = f0; f <= f1; f++) m = Math.max(m, framesF[f * meta.nBins + b])
      return m
    }
    const beatSec = 60 / 150
    const sampleEvs: Ev[] = []
    {
      const all = eventFiles.flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { events: Ev[] }).events)
      for (let i = 0; i < all.length; i += Math.max(1, Math.floor(all.length / 400))) sampleEvs.push(all[i])
    }
    let bestK = 0
    let bestS = -1
    for (let k = -3; k <= 3; k++) {
      const off = fit.a + k * beatSec
      const s = sampleEvs.reduce((a, e) => a + pitchAt(off + fit.b * e.t, e.midi), 0) / sampleEvs.length
      console.log(`  音高消歧:offset ${(off).toFixed(3)}s(k=${k})→ 平均激活 ${s.toFixed(3)}`)
      if (s > bestS) {
        bestS = s
        bestK = k
      }
    }
    if (bestK !== 0) {
      console.log(`→ 音高证据否决了起音估计:offset 修正 ${bestK} 拍(${(bestK * beatSec).toFixed(2)}s)→ ${(fit.a + bestK * beatSec).toFixed(3)}s`)
      fit.a += bestK * beatSec
    } else {
      console.log(`→ 音高证据确认起音估计(0 拍偏移)`)
    }
  }

  writeFileSync(isAbsolute(outFile) ? outFile : join(root, outFile), JSON.stringify({
    audio: audioPath, bpmScore: 150,
    offset: +fit.a.toFixed(4), scale: +fit.b.toFixed(6),
    pairs: pairs.length, hitRate: +hitRate.toFixed(4),
    residual: { med: finalRes[finalRes.length >> 1], p90: finalRes[Math.floor(finalRes.length * 0.9)] },
  }, null, 2), 'utf8')
  console.log(`→ ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
