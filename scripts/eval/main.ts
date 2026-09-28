// 扒谱准确率评估入口
//
// 用法(node scripts/eval-transcription.mjs [--options]):
//   --engine=dsp|bp|both     识别引擎(默认 both)
//   --variant=raw|sep|both   输入变体:raw = 原始混音,sep = 先做音源分离(默认 both)
//   --clip=a,b               只跑指定 fixture
//   --seed=1                 渲染种子
//   --json=path              输出机器可读报告
//   --list                   列出全部 fixture
//   -v                       打印每条样例的明细

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { separateDsp } from '../../src/transcription/separation'
import { FIXTURES, guitarTruth } from './fixtures'
import { renderClip, type RenderedClip } from './render'
import { scoreNotes, pct, type NoteScore } from './metrics'
import {
  runDspEngine,
  runBpEngine,
  closeModelServer,
  BP_DEFAULTS,
  type EngineId,
  type EngineOutput,
} from './engines'
import type { EvalClip, EvalNote } from './types'

// ---------- 参数 ----------

const args = process.argv.slice(2)
const flag = (name: string, def: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const has = (name: string) => args.includes(`--${name}`) || args.includes(`-${name[0]}`)

const enginesArg = flag('engine', 'both')
const engines: EngineId[] = enginesArg === 'both' ? ['dsp', 'bp'] : (enginesArg.split(',') as EngineId[])
const variantArg = flag('variant', 'both')
const variants = variantArg === 'both' ? ['raw', 'sep', 'oracle', 'sep-c'] : variantArg.split(',')
const clipFilter = flag('clip', '')
const seed = parseInt(flag('seed', '1'), 10) || 1
const jsonPath = flag('json', '')
const verbose = has('verbose')
const root = process.cwd()

if (has('list')) {
  for (const c of FIXTURES) console.log(`${c.id.padEnd(18)} ${c.desc}`)
  process.exit(0)
}

// ---------- 输入变体 ----------

type Prepared = { channels: Float32Array[]; label: string }

interface Variant {
  id: string
  label: string
  prepare: (r: RenderedClip, clip: EvalClip) => Prepared | null
}

/** 分离后的吉他 stem 电平远低于原混音:Basic Pitch 的输入没有归一化环节,
 *  直接喂会因电平过低而整体漏检,所以这里统一峰值归一到 0.9 */
function peakNormalize(chs: Float32Array[], target = 0.9): Float32Array[] {
  let peak = 0
  for (const ch of chs) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]))
  if (peak < 1e-9) return chs
  const g = target / peak
  return chs.map((ch) => {
    const o = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) o[i] = ch[i] * g
    return o
  })
}

function separateGuitar(r: RenderedClip, opts: Parameters<typeof separateDsp>[2]): Prepared {
  const stems = separateDsp([r.left, r.right], 22050, opts)
  return { channels: peakNormalize(stems.guitar), label: 'sep' }
}

const VARIANTS: Variant[] = [
  {
    id: 'raw',
    label: '原始混音(现状)',
    prepare: (r) => ({ channels: [r.left, r.right], label: 'raw' }),
  },
  {
    id: 'sep',
    label: '分离·去鼓去低频',
    prepare: (r) => separateGuitar(r, { centerSuppress: 0 }),
  },
  {
    // 理想分离上界:直接把标注的吉他轨(零串音)喂给引擎。
    // 用来把「分离质量不足」与「模型本身能力不足」区分开——
    // 如果理想分离也只有这个分数,那瓶颈就不是分离,换更强的模型才有意义。
    id: 'oracle',
    label: '理想分离(标注吉他轨)',
    prepare: (r) => {
      const g = r.stems.get('guitar') ?? r.stems.get('guitar-L')
      if (!g) return null
      return { channels: peakNormalize([g, g]), label: 'oracle' }
    },
  },
  {
    id: 'sep-c',
    label: '分离·+中置抑制0.6',
    prepare: (r) => separateGuitar(r, { centerSuppress: 0.6 }),
  },
]

// ---------- 打分 ----------

const toEvalNotes = (notes: { start: number; end: number; midi: number }[]): EvalNote[] =>
  notes.map((n) => ({ start: n.start, dur: Math.max(0, n.end - n.start), midi: n.midi }))

interface Row {
  clip: string
  variant: string
  engine: EngineId
  refCount: number
  estCount: number
  score: NoteScore
  bpm: number
  bpmStrength?: number
  likelyPolyphonic?: boolean
}

const rows: Row[] = []

// ---------- 主流程 ----------

const selected = clipFilter ? FIXTURES.filter((c) => clipFilter.split(',').includes(c.id)) : FIXTURES
if (selected.length === 0) {
  console.error(`没有匹配的 fixture:${clipFilter}`)
  process.exit(1)
}

console.log('='.repeat(96))
console.log('扒谱准确率评估 · 基线')
console.log('='.repeat(96))
console.log(`fixture ${selected.length} 个 · 引擎 [${engines.join(', ')}] · 变体 [${variants.join(', ')}] · seed ${seed}`)
console.log('指标:onset ±50ms 且音高完全相等才算命中(MIREX 风格)\n')

for (const clip of selected) {
  const rendered = renderClip(clip, seed)
  const truth = guitarTruth(clip)
  console.log(`── ${clip.id}: ${clip.desc}`)
  console.log(
    `   时长 ${rendered.duration.toFixed(1)}s · BPM ${clip.bpm} · 吉他标注 ${truth.length} 音符` +
      (clip.detuneCents ? ` · 整体偏移 ${clip.detuneCents > 0 ? '+' : ''}${clip.detuneCents} 音分` : ''),
  )

  for (const variant of VARIANTS) {
    if (!variants.includes(variant.id)) continue
    const prepared = variant.prepare(rendered, clip)
    if (!prepared) {
      console.log(`   [${variant.label}] 跳过(该样例不适用)`)
      continue
    }
    for (const engine of engines) {
      let out: EngineOutput
      const t0 = Date.now()
      try {
        out =
          engine === 'dsp'
            ? runDspEngine(prepared.channels, 22050)
            : await runBpEngine(prepared.channels, 22050, root, BP_DEFAULTS)
      } catch (e) {
        console.log(`   [${variant.label} / ${engine}] ❌ 失败:${String(e)}`)
        continue
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1)
      const score = scoreNotes(truth, toEvalNotes(out.notes))
      rows.push({
        clip: clip.id,
        variant: variant.id,
        engine,
        refCount: truth.length,
        estCount: out.notes.length,
        score,
        bpm: out.bpm,
        bpmStrength: out.bpmStrength,
        likelyPolyphonic: out.likelyPolyphonic,
      })
      console.log(
        `   ${variant.label.padEnd(14)} ${engine.padEnd(4)} ` +
          `认出 ${String(out.notes.length).padStart(5)} · 命中 ${String(score.tp).padStart(4)} · ` +
          `P ${pct(score.precision).padStart(6)} R ${pct(score.recall).padStart(6)} ` +
          `F1 ${pct(score.f1).padStart(6)} · 八度错 ${String(score.octaveErrors).padStart(4)} · ` +
          `BPM ${String(out.bpm).padStart(3)} · ${dt}s`,
      )
      if (verbose) {
        console.log(
          `        诊断:音高-only F1 ${pct(score.pitchOnlyF1)} · 节奏-only F1 ${pct(score.onsetOnlyF1)}` +
            (out.likelyPolyphonic ? ' · ⚠ DSP 判定复音' : ''),
        )
      }
    }
  }
  console.log('')
}

// ---------- 汇总 ----------

console.log('='.repeat(96))
console.log('汇总(按 变体 × 引擎 宏观平均 F1)')
console.log('='.repeat(96))
console.log(
  `${'变体'.padEnd(18)}${'引擎'.padEnd(6)}${'F1 均值'.padStart(9)}${'P 均值'.padStart(9)}${'R 均值'.padStart(9)}${'八度错合计'.padStart(12)}`,
)
const keys = [...new Set(rows.map((r) => `${r.variant}|${r.engine}`))]
for (const k of keys) {
  const [variant, engine] = k.split('|')
  const g = rows.filter((r) => r.variant === variant && r.engine === engine)
  const avg = (f: (r: Row) => number) => g.reduce((a, r) => a + f(r), 0) / (g.length || 1)
  console.log(
    `${variant.padEnd(18)}${engine.padEnd(6)}${pct(avg((r) => r.score.f1)).padStart(9)}` +
      `${pct(avg((r) => r.score.precision)).padStart(9)}${pct(avg((r) => r.score.recall)).padStart(9)}` +
      `${String(g.reduce((a, r) => a + r.score.octaveErrors, 0)).padStart(12)}`,
  )
}

if (jsonPath) {
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed,
        engines,
        variants,
        rows: rows.map((r) => ({
          clip: r.clip,
          variant: r.variant,
          engine: r.engine,
          refCount: r.refCount,
          estCount: r.estCount,
          tp: r.score.tp,
          fp: r.score.fp,
          fn: r.score.fn,
          precision: r.score.precision,
          recall: r.score.recall,
          f1: r.score.f1,
          octaveErrors: r.score.octaveErrors,
          pitchOnlyF1: r.score.pitchOnlyF1,
          onsetOnlyF1: r.score.onsetOnlyF1,
          bpm: r.bpm,
          bpmStrength: r.bpmStrength,
          likelyPolyphonic: r.likelyPolyphonic,
        })),
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n报告已写入 ${jsonPath}`)
}

closeModelServer()
