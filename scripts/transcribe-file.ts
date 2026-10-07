// 离线扒谱:一条命令把任意音频文件转成「曲库 JSON / 文本 Tab / MIDI」
//
// 为什么需要它:整曲扒谱在页面里要调一堆开关(引擎 / 预设 / 分轨 / 最高品 / 响度…),
// 而这些开关的最优组合是可以实测决定的。这个脚本把"实测最优的那一套"固化下来,
// 并且把结果写成页面能**一键导入**的曲库 JSON,不用再在 UI 里反复试。
//
// 用法(guitar-mate 目录下):
//   npm run transcribe -- --in="C:\path\song.ogg"
//   npm run transcribe -- --in="song.ogg" --preset=solo --max-fret=22 --name=我的曲
//   npm run transcribe -- --in="song.mp3" --separate     # 想对比分轨预处理时
//   npm run transcribe -- --in="song.mp3" --single       # 只跑主预设(省一半时间?不:推理只跑一次)
//
// 产物(默认 <out>/<曲名>/):
//   <曲名>.library.json   页面「📂 导入曲库」一键导入(默认含两种预设各一条)
//   <曲名>.<预设>.tab.txt 文本六线谱
//   <曲名>.<预设>.mid     MIDI
//   <曲名>.report.json    指标与所用参数(便于复现与横向对比)
//
// 关键默认值来自 ACCURACY.md 的实测结论:
//   · 识别阶段音域收全指板(22 品),由指法阶段按 --max-fret 过滤并如实报告丢弃;
//   · 起音对时默认开(用 DSP 起音修正 BP 的帧量化起点);
//   · 默认**不分轨**:实测在瞬态清晰的素材上分离会削弱拨弦起音(起音支撑率 47%→32%、
//     起音对时 9→0),整曲上更会让起音检测几乎失效(实测整曲只剩 25 个起音);
//   · 推理只做一次,两种预设共用帧矩阵,只重跑后处理(便宜),所以默认两种都给。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

import { toMono, resampleLinear, estimateOnsets, SR, type RawNote } from '../src/transcription/pipeline'
import { bpPreset, evaluateChunked, ensureBackend, getModel, postProcessFrames, type BpOptions, type BpPresetId } from '../src/transcription/basicPitch'
import { estimateTuningFromPcm } from '../src/transcription/tuning'
import { separateDsp, compensateLevelInPlace, extractBassNotes, percussiveBpmHint } from '../src/transcription/separation'
import { detectKey, filterToKey } from '../src/transcription/cleanup'
import { TUNINGS, STANDARD_TUNING } from '../src/theory/tunings'
import { tabToMidi, tabToText } from '../src/transcription/exporters'
import type { TabNote } from '../src/transcription/fingering'
import { ensureModelServer, runProductPipeline, closeModelServer, type EngineOutput } from './eval/engines'
import { decodeWav } from './eval/wav'

const args = process.argv.slice(2)
const flag = (n: string, d = '') => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const has = (n: string) => args.includes(`--${n}`)
const num = (n: string, d: number) => {
  const v = parseFloat(flag(n, ''))
  return Number.isFinite(v) ? v : d
}

const INPUT = flag('in')
const OUT_ROOT = resolve(flag('out', 'D:/music/tab-out'))
const PRESET = (flag('preset', 'solo') === 'mix' ? 'mix' : 'solo') as BpPresetId
const DO_SEPARATE = has('separate')
const ONLY_ONE = has('single')
const NAME = (flag('name') || basename(INPUT || 'track', extname(INPUT || ''))).replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
const MAX_FRET = num('max-fret', 15)
const MIN_CONF = num('min-conf', 0.25)
const AUTO_DENSITY = has('dense')
const KEY_FILTER = has('key-filter')
const TUNING_ID = flag('tuning', 'standard')
const FULL_FRET = 22
const root = process.cwd()

if (!INPUT || !existsSync(INPUT)) {
  console.error(`✗ 找不到输入音频:${INPUT || '(未提供)'}`)
  console.error('  用法:npm run transcribe -- --in="C:\\path\\song.ogg" [--preset=solo|mix] [--separate] [--max-fret=15] [--name=曲名]')
  process.exit(2)
}
const tuning = (TUNINGS.find((t) => t.id === TUNING_ID) ?? { midi: STANDARD_TUNING }).midi

/** ffmpeg 解码到临时 WAV(页面靠浏览器的 decodeAudioData,命令行只能靠 ffmpeg) */
function decodeToWav(input: string, out: string, channels: 1 | 2, sampleRate: number) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', String(channels), out], { stdio: 'inherit' })
  } catch {
    console.error('✗ ffmpeg 解码失败。请确认 ffmpeg 在 PATH 里,或先把音频转成 wav。')
    process.exit(3)
  }
}

interface VariantResult {
  preset: BpPresetId
  out: EngineOutput
  tab: TabNote[]
  metrics: Record<string, unknown>
}

async function main() {
  console.log(`📥 输入:${INPUT}`)
  console.log(
    `🎯 主预设:${PRESET} · 分轨:${DO_SEPARATE ? '开' : '关'} · 最高品:${MAX_FRET} · 响度≥${MIN_CONF} · 自动密度:${AUTO_DENSITY ? '开' : '关'} · 调弦:${TUNING_ID}`,
  )
  const work = mkdtempSync(join(tmpdir(), 'gm-transcribe-'))
  const outDir = join(OUT_ROOT, NAME)
  mkdirSync(outDir, { recursive: true })

  // ---- 解码 ----
  const monoWav = join(work, 'mono-22k.wav')
  decodeToWav(INPUT, monoWav, 1, 22050)
  const monoRaw = readFileSync(monoWav)
  const monoDec = decodeWav(monoRaw.buffer.slice(monoRaw.byteOffset, monoRaw.byteOffset + monoRaw.byteLength) as ArrayBuffer)

  let channels: Float32Array[] = [monoDec.channels[0]]
  let sr = monoDec.sampleRate
  let bpmHint: number | undefined
  let bassNotes: { start: number; end: number; midi: number }[] | undefined
  if (DO_SEPARATE) {
    const stWav = join(work, 'stereo.wav')
    decodeToWav(INPUT, stWav, 2, 44100)
    const stRaw = readFileSync(stWav)
    const st = decodeWav(stRaw.buffer.slice(stRaw.byteOffset, stRaw.byteOffset + stRaw.byteLength) as ArrayBuffer)
    console.log('🎛 分轨预处理中…')
    const t0 = Date.now()
    const stems = separateDsp(st.channels, st.sampleRate, { centerSuppress: 0.6 })
    compensateLevelInPlace(stems.guitar)
    channels = stems.guitar as Float32Array[]
    sr = st.sampleRate
    bpmHint = percussiveBpmHint(stems.percussive, st.sampleRate) ?? undefined
    bassNotes = extractBassNotes(stems.bass, st.sampleRate)
    console.log(`   完成(${((Date.now() - t0) / 1000).toFixed(0)}s):鼓轨 BPM 提示 ${bpmHint ?? '弃权'} · 贝斯参照 ${bassNotes.length} 个`)
  }

  const pcm22 = resampleLinear(toMono(channels, channels[0].length), sr, SR)
  const duration = pcm22.length / SR
  const tuningCents = (() => {
    const t = estimateTuningFromPcm(pcm22, SR)
    return t ? Math.round(t.semis * 100) : 0
  })()
  const retimeOnsets = estimateOnsets(pcm22, SR)
  console.log(`🎼 时长 ${duration.toFixed(0)}s · 整体音准 ${tuningCents > 0 ? '+' : ''}${tuningCents}¢ · 起音 ${retimeOnsets.length} 个`)

  // ---- 推理只做一次 ----
  console.log('🧠 Basic Pitch 推理中(CPU,整曲约 10~15 分钟,每 10% 报一次)…')
  const tInfer = Date.now()
  const url = await ensureModelServer(root)
  await ensureBackend(true)
  const bp = await getModel(url)
  let lastPct = -1
  const { frames, onsets } = await evaluateChunked(bp, pcm22, (p) => {
    const pct = Math.floor(p * 10) * 10
    if (pct !== lastPct) {
      lastPct = pct
      console.log(`   ${pct}%  (${((Date.now() - tInfer) / 1000).toFixed(0)}s)`)
    }
  })
  console.log(`   推理完成,用时 ${((Date.now() - tInfer) / 1000).toFixed(0)}s;帧 ${frames.length}`)

  // ---- 预设后处理(便宜:只重跑后处理)----
  const presets: BpPresetId[] = ONLY_ONE ? [PRESET] : [PRESET, PRESET === 'solo' ? 'mix' : 'solo']
  const results: VariantResult[] = []
  for (const preset of presets) {
    const p = bpPreset(preset)
    const opts: BpOptions = {
      ...p,
      removeOctaveGhosts: true,
      retime: true,
      retimeOnsets,
      tuningCents,
      bpmHint,
      bassNotes,
      lowestMidi: tuning[0],
      highestMidi: tuning[tuning.length - 1] + FULL_FRET,
    }
    console.log(`⚙ 后处理:预设 ${preset}(阈值 ${p.onsetThresh}/${p.frameThresh}、最短音长 ${p.minNoteLenFrames} 帧、残差补音 ${p.melodiaTrick ? '开' : '关'})…`)
    const t0 = Date.now()
    const r = await postProcessFrames(frames, onsets, opts, duration)
    const out: EngineOutput = {
      notes: r.notes,
      bpm: r.bpm,
      offset: r.offset,
      duration,
      bpmStrength: r.bpmStrength,
      tuningCents: r.tuningCents,
      retimed: r.retimed,
      onsets: r.onsets,
    }
    const product = runProductPipeline(out, tuning, MAX_FRET, { minConf: MIN_CONF, autoDensity: AUTO_DENSITY, keyFilter: KEY_FILTER })
    const dropRange = product.dropped.filter((d) => d.reason === 'range').length
    const dropConflict = product.dropped.filter((d) => d.reason === 'conflict').length

    // ---- 指标(无标注,用可信度代理指标;标尺见 ACCURACY.md)----
    const est = out.notes
    let supported = 0
    for (const n of est) {
      for (const t of retimeOnsets) {
        const d = Math.abs(t - n.start)
        if (d <= 0.04) {
          supported++
          break
        }
        if (t > n.start + 0.04) break
      }
    }
    const key = detectKey(est)
    const confs = est.map((n) => n.confidence).sort((a, b) => a - b)
    let ghosts = 0
    const sorted = [...est].sort((a, b) => a.start - b.start)
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].start >= sorted[i].end) break
        const ov = Math.min(sorted[i].end, sorted[j].end) - Math.max(sorted[i].start, sorted[j].start)
        const shorter = Math.min(sorted[i].end - sorted[i].start, sorted[j].end - sorted[j].start)
        const d = Math.abs(sorted[i].midi - sorted[j].midi)
        if ((d === 12 || d === 24) && ov > shorter * 0.5) ghosts++
      }
    }
    const metrics = {
      preset,
      settings: {
        onsetThresh: p.onsetThresh,
        frameThresh: p.frameThresh,
        minNoteLenFrames: p.minNoteLenFrames,
        melodiaTrick: p.melodiaTrick,
        retime: true,
        separate: DO_SEPARATE,
        maxFret: MAX_FRET,
        minConf: MIN_CONF,
        autoDensity: AUTO_DENSITY,
        keyFilter: KEY_FILTER,
        tuning: TUNING_ID,
      },
      notes: est.length,
      density: duration > 0 ? est.length / duration : 0,
      confMedian: confs.length ? confs[confs.length >> 1] : 0,
      confLowShare: confs.length ? confs.filter((c) => c < 0.5).length / confs.length : 0,
      onsetSupport: est.length ? supported / est.length : 0,
      inKey: key && est.length ? filterToKey(est, key).length / est.length : 0,
      keyName: key?.name ?? '未检出',
      octaveGhosts: ghosts,
      bpm: out.bpm,
      bpmStrength: out.bpmStrength ?? 0,
      tuningCents,
      retimed: out.retimed ?? 0,
      tabNotes: product.tab.length,
      droppedRange: dropRange,
      droppedConflict: dropConflict,
      processMs: Date.now() - t0,
    }
    console.log(
      `   音符 ${est.length}(${(est.length / Math.max(1, duration)).toFixed(1)}/秒) · 谱面 ${product.tab.length} 音 · 置信中位 ${(metrics.confMedian as number).toFixed(2)}` +
        `(低 ${((metrics.confLowShare as number) * 100).toFixed(0)}%) · 起音支撑 ${((metrics.onsetSupport as number) * 100).toFixed(0)}%` +
        ` · 调内 ${((metrics.inKey as number) * 100).toFixed(0)}%(${metrics.keyName})`,
    )
    console.log(
      `   BPM ${out.bpm}(锁定 ${(((out.bpmStrength ?? 0)) * 100).toFixed(0)}%) · 对时 ${out.retimed ?? 0} · 丢弃 ${dropRange} 超音域/${dropConflict} 同弦 · 后处理 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
    results.push({ preset, out, tab: product.tab, metrics })
  }

  // ---- 写产物 ----
  const setName = (preset: BpPresetId) => (results.length > 1 ? `${NAME}(${preset}${preset === PRESET ? '-推荐' : '-备选'})` : NAME)
  const songs = results.map((v, i) => ({
    id: `s${Date.now()}${i}`,
    name: setName(v.preset),
    bpm: v.out.bpm,
    tuningId: TUNING_ID,
    notes: v.tab,
    updatedAt: Date.now(),
    grid: 12 as const,
  }))
  const libraryPath = join(outDir, `${NAME}.library.json`)
  writeFileSync(libraryPath, JSON.stringify({ version: 1, songs }, null, 0), 'utf8')
  for (const v of results) {
    writeFileSync(join(outDir, `${NAME}.${v.preset}.tab.txt`), tabToText(v.tab), 'utf8')
    writeFileSync(join(outDir, `${NAME}.${v.preset}.mid`), Buffer.from(tabToMidi(v.tab, v.out.bpm)))
  }
  const reportPath = join(outDir, `${NAME}.report.json`)
  writeFileSync(
    reportPath,
    JSON.stringify({ input: INPUT, duration, generatedAt: new Date().toISOString(), separate: DO_SEPARATE, variants: results.map((v) => v.metrics) }, null, 2),
    'utf8',
  )
  rmSync(work, { recursive: true, force: true })
  closeModelServer()

  console.log('\n' + '='.repeat(74))
  console.log('✅ 完成,产物:')
  console.log(`   曲库文件(一键导入):${libraryPath}`)
  results.forEach((v) => console.log(`   文本 Tab / MIDI:     ${NAME}.${v.preset}.tab.txt / .mid  (${v.tab.length} 音符)`))
  console.log(`   指标报告:            ${reportPath}`)
  console.log('\n下一步:打开 http://127.0.0.1:5173/ → 「📚 曲库」卡片 → 「📂 导入曲库」→ 选上面的 .library.json')
  if (results.length > 1) console.log('两种预设都写进了同一个文件,导入后在曲库里会有两条,可以逐条试听对比。')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
