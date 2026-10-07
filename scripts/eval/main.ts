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

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { separateDsp, percussiveBpmHint, extractBassNotes, type BassNote } from '../../src/transcription/separation'
import { bpPreset } from '../../src/transcription/basicPitch'
import { FIXTURES, guitarTruth } from './fixtures'
import { renderClip, type RenderedClip } from './render'
import { scoreNotes, scoreQuantized, scoreProduct, judgeBpm, pct, type NoteScore, type BpmVerdict, type ProductScore } from './metrics'
import { decodeWav, encodeWav } from './wav'
import {
  runDspEngine,
  runBpEngine,
  runExtEngine,
  runProductPipeline,
  presetForClip,
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
const useReal = has('real') // 附加 eval/real-clips.json 里的真实音频样例(GuitarSet)
const exportWavDir = flag('export-wav', '') // 把每个样例的原始混音导出为 WAV(喂 MT3 等外部引擎)
const extDir = flag('ext-dir', '') // ext 引擎的结果目录:<clipId>.<variant>.json
/** 产品链路口径(默认开):额外报告"用户最终看到的六线谱"F1 与指法准确率。
 *  `--pipeline=engine` 可退回只看识别阶段。 */
const withProduct = flag('pipeline', 'product') !== 'engine'
/** 强制 BP 预设(solo/mix);不传则按样例是否含其它乐器自动选 */
const presetOverride = flag('preset', '') as '' | 'solo' | 'mix'
/** 指法用的最高品(产品下拉默认 15):只影响指法分配与「丢弃」报告 */
const MAX_FRET = 15
/** 识别阶段允许的最高品:与产品一致取全指板(22)。若这里跟随 MAX_FRET,
 *  高把位的音会在识别阶段就被丢掉 —— 评测与产品会一起失真(用户实测反馈过这一点) */
const ENGINE_MAX_FRET = 22
const root = process.cwd()

if (has('list')) {
  for (const c of FIXTURES) console.log(`${c.id.padEnd(18)} ${c.desc}`)
  process.exit(0)
}

// ---------- 输入变体 ----------

type Prepared = {
  channels: Float32Array[]
  label: string
  /** 输入采样率(合成为 22050,真实音频为文件原生采样率) */
  sampleRate: number
  /** 鼓茎包络估出的 BPM(仅分离变体有):传给引擎作 bpmHint */
  bpmHint?: number
  /** 贝斯茎单音线(仅分离变体有):传给引擎修剪八度幽灵 */
  bassNotes?: BassNote[]
}

/** 每个样例的实际采样率(合成 = EVAL_SR;真实音频在 loadRealAudio 时登记) */
const clipSampleRates = new Map<string, number>()

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

function separateGuitar(r: RenderedClip, opts: Parameters<typeof separateDsp>[2], sampleRate: number): Prepared {
  const stems = separateDsp([r.left, r.right], sampleRate, opts)
  // 分离副产品与产品里 preprocess.separateBuffer 的做法一致:
  // 鼓茎 → BPM 提示,贝斯茎 → 八度幽灵参照(不浪费已经算出来的 stem)
  return {
    channels: peakNormalize(stems.guitar),
    label: 'sep',
    sampleRate,
    bpmHint: percussiveBpmHint(stems.percussive, sampleRate) ?? undefined,
    bassNotes: extractBassNotes(stems.bass, sampleRate),
  }
}

const VARIANTS: Variant[] = [
  {
    id: 'raw',
    label: '原始混音(现状)',
    prepare: (r, clip) => ({ channels: [r.left, r.right], label: 'raw', sampleRate: clipSampleRates.get(clip.id) ?? 22050 }),
  },
  {
    id: 'sep',
    label: '分离·去鼓去低频',
    prepare: (r, clip) => separateGuitar(r, { centerSuppress: 0 }, clipSampleRates.get(clip.id) ?? 22050),
  },
  {
    // 理想分离上界:直接把标注的吉他轨(零串音)喂给引擎。
    // 用来把「分离质量不足」与「模型本身能力不足」区分开——
    // 如果理想分离也只有这个分数,那瓶颈就不是分离,换更强的模型才有意义。
    id: 'oracle',
    label: '理想分离(标注吉他轨)',
    prepare: (r, clip) => {
      const g = r.stems.get('guitar') ?? r.stems.get('guitar-L')
      if (!g) return null
      return { channels: peakNormalize([g, g]), label: 'oracle', sampleRate: clipSampleRates.get(clip.id) ?? 22050 }
    },
  },
  {
    id: 'sep-c',
    label: '分离·+中置抑制0.6',
    prepare: (r, clip) => separateGuitar(r, { centerSuppress: 0.6 }, clipSampleRates.get(clip.id) ?? 22050),
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
  quantF1: number
  /** 产品链路口径(六线谱 + 指法);--pipeline=engine 时为 null */
  product: ProductScore | null
  /** 指法阶段被丢弃(超出音域/同弦冲突)的音符数 */
  tabDropped: number
  bpm: number
  bpmVerdict: BpmVerdict
  bpmStrength?: number
  likelyPolyphonic?: boolean
  tuningCents?: number
  retimed?: number
}

const rows: Row[] = []

// ---------- 真实音频样例(GuitarSet 等):文件 → RenderedClip 同构结构 ----------

async function loadRealAudio(clip: EvalClip): Promise<RenderedClip> {
  if (!clip.audio) throw new Error(`${clip.id}: 无 audio 字段`)
  const recorded = clip.audio.path
  let audioPath = isAbsolute(recorded) ? recorded : join(root, recorded)
  if (!existsSync(audioPath)) {
    // 数据换位置时的回退:GM_DATA_DIR + <原路径最后两级>(如 audio_mono-mic/xxx.wav)
    const dataDir = process.env.GM_DATA_DIR
    const tail = recorded.split('\\').join('/').split('/').slice(-2).join('/')
    const alt = dataDir ? join(dataDir, tail) : ''
    if (alt && existsSync(alt)) {
      console.warn(`   ⚠ 音频不在原位,用 GM_DATA_DIR 回退:${alt}`)
      audioPath = alt
    } else {
      throw new Error(
        `${clip.id}: 找不到音频 ${audioPath}。请用 node scripts/prepare-guitarset.mjs --dir=<数据目录> 重新生成 eval/real-clips.json,或设置 GM_DATA_DIR。`,
      )
    }
  }
  const raw = await readFile(audioPath)
  const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  clipSampleRates.set(clip.id, wav.sampleRate)
  const pick = clip.audio.channel ?? 0
  const mono =
    pick === 'mix'
      ? toMonoEval(wav.channels, wav.channels[0].length)
      : (wav.channels[pick] ?? wav.channels[0])
  return { left: mono, right: mono, stems: new Map(), duration: wav.duration }
}

const toMonoEval = (chs: Float32Array[], len: number): Float32Array => {
  if (chs.length === 1) return chs[0]
  const out = new Float32Array(len)
  for (const ch of chs) for (let i = 0; i < len; i++) out[i] += ch[i] / chs.length
  return out
}

/** eval/real-clips.json 由 scripts/prepare-guitarset.mjs 生成(本地文件,不入库) */
function loadRealClips(): EvalClip[] {
  const p = join(root, 'eval', 'real-clips.json')
  if (!existsSync(p)) {
    console.error(`--real 需要 ${p}(先运行 node scripts/prepare-guitarset.mjs)`)
    process.exit(1)
  }
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as { clips: EvalClip[] }
  return parsed.clips
}

// ---------- 主流程 ----------

const matchesFilter = (c: EvalClip) => {
  if (!clipFilter) return true
  return clipFilter.split(',').some((tok) => (tok.endsWith('-') ? c.id.startsWith(tok) : c.id === tok))
}
let selected = clipFilter ? FIXTURES.filter(matchesFilter) : FIXTURES
if (useReal) {
  const real = loadRealClips()
  selected = clipFilter ? [...selected, ...real.filter(matchesFilter)] : [...selected, ...real]
}
if (selected.length === 0) {
  console.error(`没有匹配的 fixture:${clipFilter}`)
  process.exit(1)
}
if (engines.includes('ext') && !extDir) {
  console.error('--engine=ext 需要 --ext-dir=<目录>(外部引擎输出的 <clipId>.<variant>.json)')
  process.exit(1)
}
for (const c of selected) if (!c.audio) clipSampleRates.set(c.id, 22050)

if (exportWavDir) {
  mkdirSync(exportWavDir, { recursive: true })
  console.log(`原始混音将导出到 ${exportWavDir}(供外部引擎推理)`)
}

console.log('='.repeat(96))
console.log('扒谱准确率评估 · 基线')
console.log('='.repeat(96))
console.log(
  `fixture ${selected.length} 个${useReal ? '(含真实音频)' : ''} · 引擎 [${engines.join(', ')}] · 变体 [${variants.join(', ')}] · seed ${seed}`,
)
console.log('指标:onset ±50ms 且音高完全相等才算命中(MIREX 风格)\n')

for (const clip of selected) {
  const rendered = clip.audio ? await loadRealAudio(clip) : renderClip(clip, seed)
  if (exportWavDir) {
    // 单声道 16 位 WAV:外部引擎(MT3 等)的标准输入
    writeFileSync(join(exportWavDir, `${clip.id}.wav`), encodeWav([rendered.left], clipSampleRates.get(clip.id) ?? 22050))
  }
  const truth = guitarTruth(clip)
  console.log(`── ${clip.id}: ${clip.desc}${clip.audio ? ' · 📼 真实音频' : ''}`)
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
        if (engine === 'ext') {
          out = await runExtEngine(clip.id, variant.id, extDir)
        } else if (engine === 'dsp') {
          // 音域按样例调弦 + 全指板传入(与产品一致;旧评测漏传,低估了 0.6 点)
          out = runDspEngine(prepared.channels, prepared.sampleRate, {
            bpmHint: prepared.bpmHint,
            lowestMidi: clip.tuning[0],
            highestMidi: clip.tuning[clip.tuning.length - 1] + ENGINE_MAX_FRET,
          })
        } else {
          const hasOthers = clip.tracks.some((t) => t.instrument !== 'guitar')
          const base = presetOverride ? bpPreset(presetOverride) : presetForClip(hasOthers)
          out = await runBpEngine(prepared.channels, prepared.sampleRate, root, {
            ...(presetOverride ? { ...BP_DEFAULTS, ...base } : base),
            bpmHint: prepared.bpmHint,
            bassNotes: prepared.bassNotes,
            // 音域按调弦 + 全指板(产品一直这么传;旧评测用 36..90 默认值且跟随最高品)
            lowestMidi: clip.tuning[0],
            highestMidi: clip.tuning[clip.tuning.length - 1] + ENGINE_MAX_FRET,
          })
        }
      } catch (e) {
        console.log(`   [${variant.label} / ${engine}] ❌ 失败:${String(e)}`)
        continue
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1)
      const estNotes = toEvalNotes(out.notes)
      const score = scoreNotes(truth, estNotes)
      const quant = scoreQuantized(truth, estNotes, clip.bpm)
      // 产品链路口径:用户最终看到的六线谱(引擎 BPM/锚点 → 吸格 → 指法)
      let product: ProductScore | null = null
      let tabDropped = 0
      if (withProduct) {
        const p = runProductPipeline(out, clip.tuning, MAX_FRET, { minConf: 0, autoDensity: false })
        tabDropped = p.dropped.length
        product = scoreProduct(truth, p.tab, p.bpmUsed, p.anchor)
      }
      const bpmVerdict = judgeBpm(out.bpm, clip.bpm)
      const bpmMark = bpmVerdict === 'ok' ? '✓' : bpmVerdict === 'octave' ? '±8' : '✗'
      rows.push({
        clip: clip.id,
        variant: variant.id,
        engine,
        refCount: truth.length,
        estCount: out.notes.length,
        score,
        quantF1: quant.f1,
        product,
        tabDropped,
        bpm: out.bpm,
        bpmVerdict,
        bpmStrength: out.bpmStrength,
        likelyPolyphonic: out.likelyPolyphonic,
        tuningCents: out.tuningCents,
        retimed: out.retimed,
      })
      console.log(
        `   ${variant.label.padEnd(14)} ${engine.padEnd(4)} ` +
          `认出 ${String(out.notes.length).padStart(5)} · 命中 ${String(score.tp).padStart(4)} · ` +
          `P ${pct(score.precision).padStart(6)} R ${pct(score.recall).padStart(6)} ` +
          `F1 ${pct(score.f1).padStart(6)} · 八度错 ${String(score.octaveErrors).padStart(4)} · ` +
          `BPM ${String(out.bpm).padStart(3)}${bpmMark} · ${dt}s` +
          (product ? ` · 谱面F1 ${pct(product.f1)}(指法 ${pct(product.tabExactRate)})` : '') +
          (out.retimed ? ` · 对时${out.retimed}` : '') +
          (out.tuningCents !== undefined ? ` · 调音 ${out.tuningCents > 0 ? '+' : ''}${out.tuningCents}¢` : ''),
      )
      if (verbose) {
        console.log(
          `        诊断:音高-only F1 ${pct(score.pitchOnlyF1)} · 节奏-only F1 ${pct(score.onsetOnlyF1)} · ` +
            `严格F1(±25ms) ${pct(score.strictF1)} · 含音尾F1 ${pct(score.onsetOffsetF1)} · 量化谱面F1(真值BPM/锚点) ${pct(quant.f1)}` +
            (product ? ` · 弃音 ${tabDropped}` : '') +
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
  `${'变体'.padEnd(14)}${'引擎'.padEnd(5)}${'F1 均值'.padStart(9)}${'P 均值'.padStart(9)}${'R 均值'.padStart(9)}${'八度错'.padStart(8)}${'量化F1*'.padStart(9)}` +
    `${'谱面F1'.padStart(9)}${'指法一致'.padStart(9)}${'弃音'.padStart(6)}${'BPM对/8/错'.padStart(12)}`,
)
console.log('  * 量化F1 = 真值 BPM + 真值锚点(识别能力上界);谱面F1 = 产品链路(引擎 BPM/锚点 + 指法)')
const keys = [...new Set(rows.map((r) => `${r.variant}|${r.engine}`))]
for (const k of keys) {
  const [variant, engine] = k.split('|')
  const g = rows.filter((r) => r.variant === variant && r.engine === engine)
  const avg = (f: (r: Row) => number) => g.reduce((a, r) => a + f(r), 0) / (g.length || 1)
  const bpmOk = g.filter((r) => r.bpmVerdict === 'ok').length
  const bpmOct = g.filter((r) => r.bpmVerdict === 'octave').length
  const prod = g.filter((r) => r.product)
  const avgProd = (f: (r: Row) => number) => (prod.length ? prod.reduce((a, r) => a + f(r), 0) / prod.length : 0)
  console.log(
    `${variant.padEnd(14)}${engine.padEnd(5)}${pct(avg((r) => r.score.f1)).padStart(9)}` +
      `${pct(avg((r) => r.score.precision)).padStart(9)}${pct(avg((r) => r.score.recall)).padStart(9)}` +
      `${String(g.reduce((a, r) => a + r.score.octaveErrors, 0)).padStart(8)}` +
      `${pct(avg((r) => r.quantF1)).padStart(9)}` +
      `${(prod.length ? pct(avgProd((r) => r.product!.f1)) : '-').padStart(9)}` +
      `${(prod.length ? pct(avgProd((r) => r.product!.tabExactRate)) : '-').padStart(9)}` +
      `${String(g.reduce((a, r) => a + r.tabDropped, 0)).padStart(6)}` +
      `${`${bpmOk}/${bpmOct}/${g.length - bpmOk - bpmOct}`.padStart(12)}`,
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
        pipeline: withProduct ? 'product' : 'engine',
        maxFret: MAX_FRET,
        preset: presetOverride || 'auto',
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
          strictF1: r.score.strictF1,
          onsetOffsetF1: r.score.onsetOffsetF1,
          quantF1: r.quantF1,
          productF1: r.product?.f1,
          productPrecision: r.product?.precision,
          productRecall: r.product?.recall,
          tabExactRate: r.product?.tabExactRate,
          tabStringRate: r.product?.stringRate,
          tabFretRate: r.product?.fretRate,
          tabDropped: r.tabDropped,
          retimed: r.retimed,
          bpm: r.bpm,
          bpmVerdict: r.bpmVerdict,
          bpmStrength: r.bpmStrength,
          likelyPolyphonic: r.likelyPolyphonic,
          tuningCents: r.tuningCents,
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
