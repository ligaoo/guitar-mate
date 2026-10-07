// 盲扒 vs 参考谱:同一段录音上,把「产品盲扒链路」与「对齐后的人工参考谱」做音符级对比。
//
// 目的:给用户一个诚实的数字——盲扒距离参考谱有多远,参考谱引导模式又到在哪。
// 帧矩阵复用 ref-guided 的落盘缓存,不重复推理。
//
// 对比口径(PLAN-90 阶段 1:多指标并存,每个指标都带随机基线列):
//   · exact:    onset ±50ms + 音高全等(主口径,最大二分匹配)
//   · onsetOnly / onsetOffset(COnPOnOff)/ chroma(音级)/ octaveTol(±12/24)
//   · baseline: 输出整体平移 1.37s(与参考完全错开)后的同一指标 —— 接近它 = 无判别力
//   · 分数级(尺子 B):量化到网格后按「格×弦×品」「小节×弦×品」比对
// 参考(主音 / 主音+节奏并集)来自 Songsterr 人工谱,经 align.json 映射到录音时间轴。
//
// 用法:
//   node .rc.cjs --ref-dir=D:/music/godknows-ref --cache-dir="D:/music/tab-out/God knows-ref"
//     [--rows=quick] [--ot= --ft= --mnl= --mel= --recall] [--out=eval/ref-compare-godknows.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { postProcessFrames, ensureBackend, bpPreset, bpFrameSpanSec, type RecallExtractParams } from '../src/transcription/basicPitch'
import { ensureModelServer, closeModelServer } from './eval/engines'
import { scoreNotes, scoreTabCells, shiftNotes, type NoteScore, type TabCellScore } from './eval/metrics'
import { assignFingering } from '../src/transcription/fingering'
import { STANDARD_TUNING } from '../src/theory/tunings'
import type { EvalNote } from './eval/types'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name: string, def = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

interface Ev { t: number; dur: number; midi: number; string: number; fret: number }

interface Row {
  id: string
  desc: string
  onsetThresh?: number
  frameThresh?: number
  minNoteLenFrames?: number
  melodiaTrick?: boolean
  recallExtract?: boolean | RecallExtractParams
  removeOctaveGhosts?: boolean
  chordSnap?: boolean
}

interface RowResult {
  id: string
  desc: string
  notes: number
  vsLead: NoteScore
  vsUnion: NoteScore
  baseline: { exactF1: number; onsetOnlyF1: number; chromaF1: number }
  tabStep: TabCellScore
  tabMeasure: TabCellScore
}

const pct = (v: number) => (v * 100).toFixed(1)

async function main() {
  const refDir = flag('ref-dir', 'D:/music/godknows-ref')
  const cacheDir = flag('cache-dir', 'D:/music/tab-out/God knows-ref')
  const outFile = flag('out', 'eval/ref-compare-godknows.json')
  const quick = flag('rows', 'all') === 'quick'
  const align = JSON.parse(readFileSync(join(refDir, 'align.json'), 'utf8')) as { offset: number; scale: number; bpmScore: number }
  const meta = JSON.parse(readFileSync(join(cacheDir, 'frame-cache.meta.json'), 'utf8')) as { nFrames: number; nBins: number }
  const framesF = new Float32Array(readFileSync(join(cacheDir, 'frame-cache.frames.f32')).buffer.slice(0, meta.nFrames * meta.nBins * 4))
  const onsetsF = new Float32Array(readFileSync(join(cacheDir, 'frame-cache.onsets.f32')).buffer.slice(0, meta.nFrames * meta.nBins * 4))
  const nFrames = meta.nFrames
  const nBins = meta.nBins
  const metaDur = (meta as { duration?: number }).duration
  const duration = typeof metaDur === 'number' ? metaDur : bpFrameSpanSec(nFrames)
  console.log(`帧缓存:${nFrames} 帧 · ${duration.toFixed(1)}s · 对齐 offset=${align.offset}s bpm=${align.bpmScore}`)
  const toMatrix = (f: Float32Array): number[][] => {
    const m: number[][] = new Array(nFrames)
    for (let i = 0; i < nFrames; i++) {
      const row = new Array<number>(nBins)
      for (let j = 0; j < nBins; j++) row[j] = f[i * nBins + j]
      m[i] = row
    }
    return m
  }
  const frames = toMatrix(framesF)
  const onsets = toMatrix(onsetsF)

  const url = await ensureModelServer(root)
  await ensureBackend(true)

  // 待测参数组:产品现行各档 + 召回聚合;--ot/--ft 显式覆盖时再加一行自定义
  const rows: Row[] = [
    { id: 'mix-preset', desc: '产品 mix 预设 ot0.55/ft0.40', ...bpPreset('mix') },
    { id: 'dist-preset', desc: '失真路由 ot0.35/ft0.30(单帧双阈值)', ...bpPreset('dist'), recallExtract: false },
    { id: 'relaxed', desc: '放宽 ot0.30/ft0.25/mnl6', onsetThresh: 0.3, frameThresh: 0.25, minNoteLenFrames: 6, melodiaTrick: false, recallExtract: false },
    { id: 'recall-agg', desc: '召回聚合提取(产品默认:八度过滤自动关)', ...bpPreset('dist') },
    // 消融:八度重影过滤在本曲上 −2.4pt(删掉和弦内真实八度叠音,占节奏参考音 35%);
    // 和弦吸附 ±0.1pt(中性,保留默认开——它在干净素材上有正收益)
    { id: 'recall-agg-ghost', desc: '召回聚合 + 强制八度过滤(消融)', ...bpPreset('dist'), removeOctaveGhosts: true },
    { id: 'recall-agg-raw', desc: '召回聚合 + 关八度过滤 + 关和弦吸附(消融)', ...bpPreset('dist'), removeOctaveGhosts: false, chordSnap: false },
  ]
  if (flag('ot') || flag('ft') || flag('recall')) {
    rows.push({
      id: 'custom',
      desc: '自定义覆盖',
      onsetThresh: flag('ot') ? parseFloat(flag('ot')) : undefined,
      frameThresh: flag('ft') ? parseFloat(flag('ft')) : undefined,
      minNoteLenFrames: flag('mnl') ? parseInt(flag('mnl'), 10) : undefined,
      melodiaTrick: flag('mel') ? flag('mel') === 'on' : undefined,
      recallExtract: flag('recall') ? flag('recall') !== 'off' : undefined,
    })
  }
  const useRows = quick ? rows.filter((r) => r.id === 'recall-agg' || r.id === 'mix-preset') : rows

  const loadRef = (f: string): EvalNote[] =>
    (JSON.parse(readFileSync(join(refDir, f), 'utf8')) as { events: Ev[] }).events.map((e) => ({
      start: align.offset + align.scale * e.t,
      dur: e.dur,
      midi: e.midi,
    }))
  const lead = loadRef('lead-events.json')
  const rhythm = loadRef('rhythm-events.json')
  const union = [...lead, ...rhythm].sort((a, b) => a.start - b.start)
  // 分数级参考格(step 即 12 细分格;string 翻转:Songsterr 0=最细 → 产品 0=最低)
  const beatSec = 60 / align.bpmScore
  const refCells = [...lead, ...rhythm].length
  const loadRefCells = (files: string[]) =>
    files.flatMap((f) =>
      (JSON.parse(readFileSync(join(refDir, f), 'utf8')) as { events: Ev[] }).events.map((e) => ({
        step: Math.round(((align.offset + align.scale * e.t - align.offset) / beatSec) * 12),
        string: 5 - e.string,
        fret: e.fret,
      })),
    )
  const refTab = loadRefCells(['lead-events.json', 'rhythm-events.json'])
  console.log(`参考:lead ${lead.length} · rhythm ${rhythm.length} · 并集 ${union.length}(格 ${refCells})`)

  const results: RowResult[] = []
  for (const row of useRows) {
    const p = bpPreset('mix')
    const r = await postProcessFrames(
      frames,
      onsets,
      {
        onsetThresh: row.onsetThresh ?? p.onsetThresh,
        frameThresh: row.frameThresh ?? p.frameThresh,
        minNoteLenFrames: row.minNoteLenFrames ?? p.minNoteLenFrames,
        melodiaTrick: row.melodiaTrick ?? p.melodiaTrick,
        recallExtract: row.recallExtract ?? false,
        // 与 postProcessFrames 同默认:召回提取模式默认关八度过滤(消融行可显式打开)
        removeOctaveGhosts: row.removeOctaveGhosts ?? !(row.recallExtract ?? false),
        chordSnap: row.chordSnap ?? true,
        retime: false, // 无 pcm 起音表,跳过对时(±11ms 级,不影响结论)
        lowestMidi: 40,
        highestMidi: 86,
      },
      duration,
    )
    const est = r.notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))
    const vsLead = scoreNotes(lead, est)
    const vsUnion = scoreNotes(union, est)
    // 随机基线:整体平移 1.37s(参考谱网格的错位量,与真值完全脱钩)
    const base = scoreNotes(union, shiftNotes(est, 1.37))
    // 分数级:量化到真值网格 + 指法,按「格×弦×品」「小节×弦×品」比对
    const estCells = assignFingering(
      est.map((n) => ({
        step: Math.max(0, Math.round(((n.start - align.offset) / beatSec) * 12)),
        dur: Math.max(1, Math.round((n.dur / beatSec) * 12)),
        midi: n.midi,
        conf: 1,
      })),
      STANDARD_TUNING,
      22,
    ).notes
    const tabStep = scoreTabCells(refTab, estCells, 'step')
    const tabMeasure = scoreTabCells(refTab, estCells, 'measure')
    results.push({
      id: row.id,
      desc: row.desc,
      notes: est.length,
      vsLead,
      vsUnion,
      baseline: { exactF1: base.f1, onsetOnlyF1: base.onsetOnlyF1, chromaF1: base.chromaF1 },
      tabStep,
      tabMeasure,
    })
    console.log(`✓ ${row.id}:${est.length} 音 · 并集 F1 ${pct(vsUnion.f1)}%(P ${pct(vsUnion.precision)}/R ${pct(vsUnion.recall)})`)
  }
  closeModelServer()

  // ---------- 报告 ----------
  const lines: string[] = []
  lines.push('# 盲扒 vs 人工参考谱 · 多指标对照(《God knows》)')
  lines.push('')
  lines.push(`- 指标口径:onset ±50ms;匹配 = 最大基数二分匹配(MIREX 风格);n:参考 lead 1173 / 并集 ${union.length}`)
  lines.push(`- 随机基线 = 同一输出整体平移 1.37s 后的指标(与参考完全错开);任何指标接近基线即无判别力`)
  lines.push(`- 对齐:offset ${align.offset}s · scale ${align.scale} · ${align.bpmScore} BPM(2026-10-07 音高消歧版)`)
  lines.push('')
  lines.push('## 音符级(尺子 A)')
  lines.push('')
  lines.push('| 参数组 | 音数 | 并集 exact F1 | P / R | onsetOnly | onset+offset | 音级 | ±12/24 | 主音 exact F1 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    lines.push(
      `| ${r.desc} | ${r.notes} | **${pct(r.vsUnion.f1)}** | ${pct(r.vsUnion.precision)} / ${pct(r.vsUnion.recall)} | ${pct(r.vsUnion.onsetOnlyF1)} | ${pct(r.vsUnion.onsetOffsetF1)} | ${pct(r.vsUnion.chromaF1)} | ${pct(r.vsUnion.octaveTolF1)} | ${pct(r.vsLead.f1)} |`,
    )
  }
  lines.push(`| (随机基线,以并集为例) | — | ${pct(results[0]?.baseline.exactF1 ?? 0)} | — | ${pct(results[0]?.baseline.onsetOnlyF1 ?? 0)} | — | ${pct(results[0]?.baseline.chromaF1 ?? 0)} | — | — |`)
  lines.push('')
  lines.push('## 分数级(尺子 B:量化到网格后「×弦×品」一致率)')
  lines.push('')
  lines.push('| 参数组 | 格级 F1 | 小节级 F1 | 参考格数 | 输出格数 |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    lines.push(`| ${r.desc} | ${pct(r.tabStep.f1)} | ${pct(r.tabMeasure.f1)} | ${r.tabStep.refCount} | ${r.tabStep.estCount} |`)
  }
  lines.push('')
  lines.push('> 分数级指标对 ±50ms 抖动不敏感,直接对应"改谱成本";REF 模式在该口径按构造 ≈100%(谱面即参考谱)。')
  const md = lines.join('\n')
  console.log('\n' + md)

  const outAbs = join(root, outFile)
  mkdirSync(join(root, 'eval'), { recursive: true })
  writeFileSync(
    outAbs,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metric: 'note-level F1, onset ±50ms + exact pitch, max bipartite matching (MIREX-style)',
        ref: { lead: lead.length, union: union.length, align },
        baselineShiftSec: 1.37,
        rows: results.map((r) => ({
          id: r.id,
          desc: r.desc,
          notes: r.notes,
          vsUnion: { ...r.vsUnion, matches: undefined },
          vsLead: { ...r.vsLead, matches: undefined },
          baseline: r.baseline,
          tabStep: r.tabStep,
          tabMeasure: r.tabMeasure,
        })),
        report: md,
      },
      null,
      2,
    ),
    'utf-8',
  )
  console.log(`\n产物:${outAbs}`)
  console.log('注:盲扒输出含两把吉他(+贝斯渗漏),对单轨参考的精确率天然偏低;并集口径更公平。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
