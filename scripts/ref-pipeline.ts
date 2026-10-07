// REF 数据工厂(PLAN-90 阶段 4):一首「有谱的歌 + 录音」→ 一条命令产出全部资产。
//
// 这是把 ref-align.ts + ref-guided.ts 的三步手动流程合成的一键流水线(共享核心在
// ref-core.ts,数值口径与分步路径完全一致),并在最后多产出两样阶段 4 的东西:
//   · <歌名>.triple.json —— 「对齐音频 + 人工谱 + 逐音验证」三元组(音符级标注的
//     训练数据;行业缺的正是真实录音的这类标注,每个有谱的歌都能产一个样本)
//   · dataset.json —— 一致性摘要(强验证占比等),供批量收集时做质量门槛
//
// 用法(esbuild 打包后):
//   node .rp.cjs --audio=song.wav --lead=track0.json [--rhythm=track1.json] \
//     --out-dir="D:/music/tab-out/<歌名>" --name="<歌名>"
// 首次运行推理约 8~12 分钟(帧矩阵落盘缓存);重跑走缓存秒级。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR } from '../src/transcription/pipeline'
import { ensureBackend, getModel } from '../src/transcription/basicPitch'
import { ensureModelServer, closeModelServer } from './eval/engines'
import { decodeWav } from './eval/wav'
import { parseSongsterrTrack, inferFrameCache, alignScoreToAudio, disambiguateByPitch, verifyTrack, type ScoreEvent, type VerifyTrackResult } from './ref-core'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name: string, def = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

async function main() {
  const audioPath = flag('audio')
  const leadPath = flag('lead')
  const rhythmPath = flag('rhythm')
  const outDir = flag('out-dir')
  const songName = flag('name', '未命名')
  if (!audioPath || !leadPath || !outDir) {
    console.error('用法:--audio=<wav> --lead=<songsterr track json> [--rhythm=<...>] --out-dir=<目录> [--name=<歌名>]')
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })

  // ---- 音频 → 22050Hz 单声道 + DSP 起音表 ----
  const raw = await readFile(audioPath)
  const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const mono = wav.channels.length === 1 ? wav.channels[0] : toMono(wav.channels, wav.channels[0].length)
  const pcm = resampleLinear(mono, wav.sampleRate, SR)
  const duration = pcm.length / SR
  const audioOnsets = estimateOnsets(pcm, SR)
  console.log(`音频 ${duration.toFixed(1)}s · DSP 起音 ${audioOnsets.length} 个`)

  // ---- 推理一次(帧缓存)----
  const url = await ensureModelServer(root)
  await ensureBackend(true)
  const bp = await getModel(url)
  const cache = await inferFrameCache(bp, pcm, join(outDir, 'frame-cache'))

  // ---- 解析谱面 ----
  const parse = (p: string) => parseSongsterrTrack(JSON.parse(readFileSync(p, 'utf8')))
  const lead = parse(leadPath)
  const rhythm = rhythmPath ? parse(rhythmPath) : null
  const allEvents: ScoreEvent[] = [...lead.events, ...(rhythm?.events ?? [])]
  console.log(`谱面:lead ${lead.events.length} 音/${lead.measures} 小节 · BPM ${lead.bpm}` + (rhythm ? ` · rhythm ${rhythm.events.length} 音` : ''))

  // ---- 对齐:起音网格搜 + 稳健回归 + 音高消歧 ----
  const scoreOnsets = allEvents.map((e) => e.t).sort((a, b) => a - b)
  let align = alignScoreToAudio(scoreOnsets, audioOnsets)
  const beatSec = 60 / lead.bpm
  const disamb = disambiguateByPitch(align, beatSec, allEvents, cache)
  if (disamb.k !== 0) align = { ...align, offset: disamb.offset }
  const alignInfo = {
    audio: audioPath,
    bpmScore: lead.bpm,
    offset: +align.offset.toFixed(4),
    scale: +align.scale.toFixed(6),
    pairs: align.pairs,
    hitRate: +align.hitRate.toFixed(4),
    residual: align.residual,
    pitchDisambiguation: { k: disamb.k, bestScore: +disamb.bestScore.toFixed(4) },
  }
  writeFileSync(join(outDir, 'align.json'), JSON.stringify(alignInfo, null, 2), 'utf8')

  // ---- 逐音符验证 + 曲库 + 报告 ----
  const results: Array<{ label: string; title: string; r: VerifyTrackResult; evs: ScoreEvent[] }> = []
  const run = (label: string, parsed: { events: ScoreEvent[] }, title: string) => {
    const r = verifyTrack(parsed.events, { offset: align.offset, scale: align.scale, bpmScore: lead.bpm }, cache, audioOnsets, label, title)
    writeFileSync(join(outDir, `verify-${label}.json`), JSON.stringify(r.perNote, null, 1), 'utf8')
    results.push({ label, title, r, evs: parsed.events })
  }
  run('lead', lead, `${songName}(参考谱 · 主音吉他)`)
  if (rhythm) run('rhythm', rhythm, `${songName}(参考谱 · 节奏吉他)`)

  const lib = { version: 1, songs: results.map((x) => x.r.song) }
  writeFileSync(join(outDir, `${songName}.ref.library.json`), JSON.stringify(lib), 'utf8')

  // ---- 阶段 4 产物 1:训练三元组(对齐音频 + 人工谱 + 逐音验证)----
  const triple = {
    version: 1,
    song: songName,
    audio: audioPath,
    bpm: lead.bpm,
    tuning: lead.tuning,
    align: alignInfo,
    tracks: results.map((x) => ({
      label: x.label,
      notes: x.r.song.notes.map((n, i) => ({
        // 音频时间轴上的音符级标注(t/dur 秒),conf = 验证分级
        t: +(align.offset + align.scale * x.evs[i].t).toFixed(4),
        dur: +x.evs[i].dur.toFixed(4),
        midi: n.midi,
        string: n.string,
        fret: n.fret,
        step: n.step,
        conf: n.conf,
        verdict: x.r.perNote[i].verdict,
        evidence: x.r.perNote[i].ev,
      })),
    })),
  }
  writeFileSync(join(outDir, `${songName}.triple.json`), JSON.stringify(triple), 'utf8')

  // ---- 阶段 4 产物 2:一致性摘要(批量收集的质量门槛)----
  const dataset = {
    song: songName,
    audio: audioPath,
    generatedAt: new Date().toISOString(),
    tracks: results.map((x) => {
      const v = x.r.verdictCount
      const total = x.r.n || 1
      return {
        label: x.label,
        notes: x.r.n,
        strong: v.strong,
        ok: v.ok,
        weak: v.weak,
        none: v.none,
        strongShare: +(v.strong / total).toFixed(4),
        verifiedShare: +((v.strong + v.ok) / total).toFixed(4),
      }
    }),
  }
  writeFileSync(join(outDir, 'dataset.json'), JSON.stringify(dataset, null, 2), 'utf8')

  // ---- 人读报告 ----
  const lines = ['# 参考谱引导扒谱 · 验证报告', '', `- 音频:${audioPath}(${duration.toFixed(1)}s)`, `- 对齐:audioT = ${align.offset.toFixed(3)}s + ${align.scale.toFixed(5)} × scoreT(谱面 ${lead.bpm} BPM;音高消歧 k=${disamb.k})`, '- 验证口径:起音支撑 = DSP 起音 ±60ms;音高支撑 = BP 帧激活(该音高 120ms 窗最大值)', '']
  for (const { title, r } of results) {
    const v = r.verdictCount
    const total = r.n || 1
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(`- 音符 ${total} 个`)
    lines.push(`- ✅ 强验证(音高≥0.30 且有起音):**${v.strong}(${((v.strong / total) * 100).toFixed(1)}%)**`)
    lines.push(`- ✓ 基本验证(含泛音验证):${v.ok}(${((v.ok / total) * 100).toFixed(1)}%)`)
    lines.push(`- ⚠ 弱证据:${v.weak} · ❌ 无音频证据:${v.none}`)
    lines.push(`- 「强+基本」合计:**${(((v.strong + v.ok) / total) * 100).toFixed(1)}%** ← 该谱与这版录音的一致度`)
    const byM = new Map<number, { total: number; weak: number }>()
    for (const p of r.perNote) {
      const cur = byM.get(p.m) ?? { total: 0, weak: 0 }
      cur.total++
      if (p.verdict === 'weak' || p.verdict === 'none') cur.weak++
      byM.set(p.m, cur)
    }
    const weakMeasures = [...byM.entries()].filter(([, s]) => s.weak / s.total >= 0.5).map(([m, s]) => `m${m + 1}(${s.weak}/${s.total})`)
    if (weakMeasures.length) lines.push(`- 弱证据过半的小节(建议对照原曲复核):${weakMeasures.join(' ')}`)
    lines.push('')
  }
  lines.push('## 数据工厂产物(阶段 4)')
  lines.push('')
  lines.push(`- \`${songName}.triple.json\` —— 音频时间轴上的音符级标注(逐音 conf/verdict),微调/弱监督的训练样本`)
  lines.push(`- \`dataset.json\` —— 一致性摘要(强验证占比),批量收集 ≥50 首时的质量门槛`)
  writeFileSync(join(outDir, 'ref-report.md'), lines.join('\n'), 'utf8')

  closeModelServer()
  console.log(lines.join('\n'))
  console.log(`\n产物目录:${outDir}`)
  console.log(`曲库 ${songName}.ref.library.json(页面「📂 导入曲库」即用)· 三元组 ${songName}.triple.json · 摘要 dataset.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
