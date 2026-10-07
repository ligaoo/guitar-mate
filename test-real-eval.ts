// 真实数据回归(真实 GuitarSet 音频):守住"真人演奏上的准确率不回退"
//
// 为什么必须有这个测试:合成 fixture 是 Karplus-Strong 音色,对 Basic Pitch 属分布外
// (EVAL.md §1.3 已证明)—— 参数改动在合成集上"持平",在真实录音上可能掉 5 个点。
// 本测试跑真实音频的 **BP 全链路 + 产品链路(量化 + 指法)**,给两端设下限。
//
// 设计取舍:
//   · 只取 2 个片段的**前 8 秒**(每段推理约 8~10s),整套约 20~30s,不拖垮 npm test;
//   · 数据不在场(eval/real-clips.json 缺失或音频找不到)时**跳过而不是失败** ——
//     真实数据是本地 Zenodo 下载物,不入库;
//   · 设 GM_SKIP_REAL=1 可强制跳过。
// 下限依据:ACCURACY.md §2.1(真实独奏 8 片段:音符级 72.0% / 谱面 60.0%)。
// 取 8 秒片段、只验 2 个样例,留足安全边际:音符级 ≥ 0.62、谱面 ≥ 0.48。
import { readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { createServer, type Server } from 'node:http'

import { toMono, resampleLinear, estimateOnsets, SR } from './src/transcription/pipeline'
import { evaluateChunked, postProcessFrames, ensureBackend, getModel, bpPreset } from './src/transcription/basicPitch'
import { estimateTuningFromPcm } from './src/transcription/tuning'
import { decodeWav } from './scripts/eval/wav'
import { scoreNotes, scoreQuantized, scoreProduct } from './scripts/eval/metrics'
import { runProductPipeline } from './scripts/eval/engines'
import type { EvalClip, EvalNote } from './scripts/eval/types'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const CLIP_FILE = join(process.cwd(), 'eval', 'real-clips.json')
const EXCERPT_SEC = 8
const FLOOR_NOTE_F1 = 0.62
const FLOOR_PRODUCT_F1 = 0.48

if (process.env.GM_SKIP_REAL === '1') {
  console.log('⏭ 真实数据回归已跳过(GM_SKIP_REAL=1)')
  process.exit(0)
}
if (!existsSync(CLIP_FILE)) {
  console.log('⏭ 真实数据回归跳过:缺 eval/real-clips.json(用 node scripts/prepare-guitarset.mjs 生成)')
  process.exit(0)
}

const clips = (JSON.parse(readFileSync(CLIP_FILE, 'utf8')) as { clips: EvalClip[] }).clips
/** 挑一个 solo 一个 comp(没有 comp 就取前两个),覆盖单音与和弦两类材料 */
const solo = clips.find((c) => c.id.includes('_solo'))
const comp = clips.find((c) => c.id.includes('_comp'))
const picked = [solo, comp].filter(Boolean) as EvalClip[]
if (picked.length === 0) {
  console.log('⏭ 真实数据回归跳过:real-clips.json 里没有可用片段')
  process.exit(0)
}

const resolveAudio = (p: string): string | null => {
  const direct = isAbsolute(p) ? p : join(process.cwd(), p)
  if (existsSync(direct)) return direct
  const dataDir = process.env.GM_DATA_DIR
  const tail = p.split('\\').join('/').split('/').slice(-2).join('/')
  const alt = dataDir ? join(dataDir, tail) : ''
  return alt && existsSync(alt) ? alt : null
}

const missing = picked.filter((c) => !resolveAudio(c.audio!.path))
if (missing.length > 0) {
  console.log(`⏭ 真实数据回归跳过:音频文件不在场(${missing.map((c) => c.id).join(', ')})`)
  process.exit(0)
}

let modelServer: Server | null = null
let modelUrl = ''
async function ensureModelServer(): Promise<string> {
  if (modelServer) return modelUrl
  const dir = join(process.cwd(), 'public', 'vendor', 'basic-pitch')
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '')
    try {
      const buf = await readFile(join(dir, rel))
      res.setHeader('content-type', rel.endsWith('.json') ? 'application/json' : 'application/octet-stream')
      res.end(buf)
    } catch {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  modelServer = server
  modelUrl = `http://127.0.0.1:${port}/model.json`
  return modelUrl
}

const truthInWindow = (truth: EvalNote[]) => truth.filter((n) => n.start < EXCERPT_SEC - 0.2)

async function main() {
  for (const clip of picked) {
    const path = resolveAudio(clip.audio!.path)!
    const raw = await readFile(path)
    const wav = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const mono = wav.channels.length === 1 ? wav.channels[0] : toMono(wav.channels, wav.channels[0].length)
    const n = Math.min(mono.length, Math.floor(EXCERPT_SEC * wav.sampleRate))
    const excerpt = mono.subarray(0, n)
    const pcm = resampleLinear(excerpt, wav.sampleRate, SR)

    const url = await ensureModelServer()
    await ensureBackend(true)
    const bp = await getModel(url)
    const tune = estimateTuningFromPcm(pcm, SR)
    const preset = bpPreset('solo') // GuitarSet 是无伴奏独奏
    const { frames, onsets } = await evaluateChunked(bp, pcm, () => {})
    const r = await postProcessFrames(
      frames,
      onsets,
      {
        ...preset,
        removeOctaveGhosts: true,
        retime: true,
        retimeOnsets: estimateOnsets(pcm, SR),
        lowestMidi: clip.tuning[0],
        highestMidi: clip.tuning[clip.tuning.length - 1] + 22, // 与产品一致:识别阶段收全指板
        tuningCents: tune ? Math.round(tune.semis * 100) : 0,
        autoTune: true,
      },
      pcm.length / SR,
    )

    const truth = truthInWindow(clip.tracks[0].notes)
    const est = r.notes.map((x) => ({ start: x.start, dur: Math.max(0, x.end - x.start), midi: x.midi }))
    const score = scoreNotes(truth, est)
    const quant = scoreQuantized(truth, est, clip.bpm)
    const product = runProductPipeline(
      { notes: r.notes, bpm: r.bpm, offset: r.offset, duration: pcm.length / SR, bpmStrength: r.bpmStrength, retimed: r.retimed },
      clip.tuning,
      15,
      { minConf: 0, autoDensity: false },
    )
    const pScore = scoreProduct(truth, product.tab, product.bpmUsed, product.anchor)

    console.log(
      `\n📼 ${clip.id}(前 ${EXCERPT_SEC}s · 标注 ${truth.length} 音 · 调音 ${r.tuningCents ?? 0}¢ · 对时 ${r.retimed ?? 0})`,
    )
    console.log(
      `   音符级 F1 ${(score.f1 * 100).toFixed(1)}% (P ${(score.precision * 100).toFixed(1)} / R ${(score.recall * 100).toFixed(1)}) · ` +
        `真值网格量化 ${(quant.f1 * 100).toFixed(1)}% · 产品谱面 ${(pScore.f1 * 100).toFixed(1)}% · 指法一致 ${(pScore.tabExactRate * 100).toFixed(0)}%`,
    )
    ok(truth.length >= 8, `${clip.id}: 片段内有足够标注(${truth.length} ≥ 8)`)
    ok(
      score.f1 >= FLOOR_NOTE_F1,
      `${clip.id}: 音符级 F1 ${(score.f1 * 100).toFixed(1)}% ≥ ${(FLOOR_NOTE_F1 * 100).toFixed(0)}%(真实录音下限)`,
    )
    ok(
      pScore.f1 >= FLOOR_PRODUCT_F1,
      `${clip.id}: 产品谱面 F1 ${(pScore.f1 * 100).toFixed(1)}% ≥ ${(FLOOR_PRODUCT_F1 * 100).toFixed(0)}%(含量化+指法)`,
    )
  }

  modelServer?.close()
  console.log(failed === 0 ? '\n真实数据回归通过 ✓' : `\n${failed} 项失败 ✗`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
