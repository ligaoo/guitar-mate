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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR } from '../src/transcription/pipeline'
import { ensureBackend, getModel } from '../src/transcription/basicPitch'
import { ensureModelServer, closeModelServer } from './eval/engines'
import { decodeWav } from './eval/wav'
import { parseSongsterrTrack, inferFrameCache, alignScoreToAudio, disambiguateByPitch, verifyTrack, type ScoreEvent, type VerifyTrackResult } from './ref-core'

const root = process.cwd()
const args = process.argv.slice(2)
/** 一致性随机基线的错开量(与评测报告的随机基线同一口径) */
const BASELINE_SHIFT_SEC = 1.37
/** 训练样本门槛:每条轨「强+基本验证」须比随机水平高出这么多(实测见 REF.md) */
const MIN_VERIFIED_MARGIN = 0.08
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
  // 只在缓存缺失时加载模型:缓存命中还去拉模型,关服务器时会留下未完成的请求,进程以非零码退出,
  // 批量收集时就分不清"成功"与"对齐不可信(exit 2)"。
  const cacheBase = join(outDir, 'frame-cache')
  type Bp = Parameters<typeof inferFrameCache>[0]
  const bp: Bp = existsSync(cacheBase + '.meta.json')
    ? { evaluateModel: () => Promise.reject(new Error('帧缓存命中,不应再推理')) }
    : await (async () => {
        const url = await ensureModelServer(root)
        await ensureBackend(true)
        return getModel(url)
      })()
  const cache = await inferFrameCache(bp, pcm, cacheBase)

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
    pitchDisambiguation: {
      k: disamb.k,
      bestScore: +disamb.bestScore.toFixed(4),
      contrast: +disamb.contrast.toFixed(3),
      margin: +disamb.margin.toFixed(4),
      ok: disamb.ok,
      reason: disamb.reason,
    },
  }
  writeFileSync(join(outDir, 'align.json'), JSON.stringify(alignInfo, null, 2), 'utf8')
  // 对齐不可信时不产出任何下游资产:错位的三元组会以"看起来正常"的一致性分数混进训练集
  // (实测翻唱版:错位 1.6s 时强+基本验证仍有 72.5%/68.2%,与随机水平无异)。--force 可强行继续(资产会标记 alignOk=false)。
  if (!disamb.ok && !args.includes('--force')) {
    writeFileSync(
      join(outDir, 'dataset.json'),
      JSON.stringify({ song: songName, audio: audioPath, generatedAt: new Date().toISOString(), usable: false, alignment: alignInfo.pitchDisambiguation, tracks: [] }, null, 2),
      'utf8',
    )
    console.error(`✗ 对齐不可信,已中止(未写三元组/曲库):${disamb.reason}`)
    console.error('  排查:谱面与录音是否同一版本/编配、是否移调;确认无误可加 --force 强行产出(资产会标记 alignOk=false)')
    closeModelServer()
    process.exit(2)
  }

  // ---- 逐音符验证 + 曲库 + 报告 ----
  const results: Array<{ label: string; title: string; r: VerifyTrackResult; evs: ScoreEvent[]; baselineVerified: number }> = []
  const run = (label: string, parsed: { events: ScoreEvent[] }, title: string) => {
    const r = verifyTrack(parsed.events, { offset: align.offset, scale: align.scale, bpmScore: lead.bpm }, cache, audioOnsets, label, title)
    writeFileSync(join(outDir, `verify-${label}.json`), JSON.stringify(r.perNote, null, 1), 'utf8')
    // 随机基线:同一份谱整体错开 BASELINE_SHIFT_SEC 再验证一次——一致性分数必须明显高于它才有意义
    const b = verifyTrack(parsed.events, { offset: align.offset + BASELINE_SHIFT_SEC, scale: align.scale, bpmScore: lead.bpm }, cache, audioOnsets, label, title)
    const baselineVerified = (b.verdictCount.strong + b.verdictCount.ok) / (b.n || 1)
    results.push({ label, title, r, evs: parsed.events, baselineVerified })
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
  const tracks = results.map((x) => {
    const v = x.r.verdictCount
    const total = x.r.n || 1
    const verified = (v.strong + v.ok) / total
    return {
      label: x.label,
      notes: x.r.n,
      strong: v.strong,
      ok: v.ok,
      weak: v.weak,
      none: v.none,
      strongShare: +(v.strong / total).toFixed(4),
      verifiedShare: +verified.toFixed(4),
      /** 同一份谱错开 BASELINE_SHIFT_SEC 后的强+基本验证占比(随机水平) */
      baselineVerifiedShare: +x.baselineVerified.toFixed(4),
      /** 超出随机水平的部分——批量收集时的质量门槛看它,不看 verifiedShare 本身 */
      verifiedMargin: +(verified - x.baselineVerified).toFixed(4),
    }
  })
  const dataset = {
    song: songName,
    audio: audioPath,
    generatedAt: new Date().toISOString(),
    /** 对齐可信且每条轨的一致性都明显高于随机水平,才可作为训练样本 */
    usable: disamb.ok && tracks.every((t) => t.verifiedMargin >= MIN_VERIFIED_MARGIN),
    alignment: alignInfo.pitchDisambiguation,
    minVerifiedMargin: MIN_VERIFIED_MARGIN,
    tracks,
  }
  writeFileSync(join(outDir, 'dataset.json'), JSON.stringify(dataset, null, 2), 'utf8')

  // ---- 人读报告 ----
  const lines = [
    '# 参考谱引导扒谱 · 验证报告',
    '',
    `- 音频:${audioPath}(${duration.toFixed(1)}s)`,
    `- 对齐:audioT = ${align.offset.toFixed(3)}s + ${align.scale.toFixed(5)} × scoreT(谱面 ${lead.bpm} BPM;音高消歧 k=${disamb.k},对比度 ${disamb.contrast.toFixed(2)} · 区分度 ${disamb.margin.toFixed(3)}${disamb.ok ? '' : ` · ⚠ 不可信:${disamb.reason}`})`,
    '- 验证口径:起音支撑 = DSP 起音 ±60ms;音高支撑 = BP 帧激活(该音高 120ms 窗最大值)',
    `- 随机基线:同一份谱整体错开 ${BASELINE_SHIFT_SEC}s 再验证。「强+基本」本身在密集节奏上随机就有六七成,要看超出基线多少`,
    `- **训练样本可用:${dataset.usable ? '是' : '否'}**(对齐可信,且每条轨超出基线 ≥ ${(MIN_VERIFIED_MARGIN * 100).toFixed(0)} 个点)`,
    '',
  ]
  for (const { title, r, baselineVerified } of results) {
    const v = r.verdictCount
    const total = r.n || 1
    const verified = (v.strong + v.ok) / total
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(`- 音符 ${total} 个`)
    lines.push(`- ✅ 强验证(音高≥0.30 且有起音):**${v.strong}(${((v.strong / total) * 100).toFixed(1)}%)**`)
    lines.push(`- ✓ 基本验证(含泛音验证):${v.ok}(${((v.ok / total) * 100).toFixed(1)}%)`)
    lines.push(`- ⚠ 弱证据:${v.weak} · ❌ 无音频证据:${v.none}`)
    lines.push(
      `- 「强+基本」合计 ${(verified * 100).toFixed(1)}%,随机基线 ${(baselineVerified * 100).toFixed(1)}% → **超出基线 ${((verified - baselineVerified) * 100).toFixed(1)} 个点** ← 该谱与这版录音的一致度`,
    )
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
  lines.push(`- \`dataset.json\` —— 一致性摘要(含随机基线与 usable 判定),批量收集 ≥50 首时只收 usable=true 的`)
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
