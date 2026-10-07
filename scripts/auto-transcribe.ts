// 全自动扒谱:一次推理 → 逐段自评 → 不合格就改参数重扒 → 组装 + 段级报告
//
// 用法(guitar-mate 目录下):
//   npm run auto -- --in="C:\path\song.ogg"
//   npm run auto -- --in="song.ogg" --max-fret=22 --name=我的曲 --attempts=4
//   npm run auto -- --in="song.ogg" --separate       # 想对比分轨(默认不开,实测更差)
//
// 产物(默认 <out>/<曲名>-auto/):
//   <曲名>.library.json   页面「📂 导入曲库」一键导入(含自动版;--with-baseline 时再加一条普通版)
//   <曲名>.tab.txt / .mid
//   <曲名>.segments.md    **逐段审查报告**:每段的判定、分数、问题、最终参数、试了几次
//   <曲名>.report.json    机器可读的完整审计轨迹(每次尝试的参数与分数)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

import { toMono, resampleLinear, SR } from '../src/transcription/pipeline'
import { autoTranscribe } from '../src/transcription/auto/conductor'
import { CALIB } from '../src/transcription/auto/quality'
import { paramsKey, DISTORTION_ROUTE, distortionIndex } from '../src/transcription/auto/plan'
import { importDefaults } from '../src/transcription/importDefaults'
import { separateDsp, compensateLevelInPlace } from '../src/transcription/separation'
import { TUNINGS, STANDARD_TUNING } from '../src/theory/tunings'
import { tabToMidi, tabToText } from '../src/transcription/exporters'
import { ensureModelServer, closeModelServer } from './eval/engines'
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
const NAME = (flag('name') || basename(INPUT || 'track', extname(INPUT || ''))).replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
/** --max-fret 未显式给出时按失真分档(与网页端导入默认值同一来源 importDefaults):失真 22、干净 15 */
const MAX_FRET_FLAG = flag('max-fret') ? num('max-fret', 15) : null
const ATTEMPTS = num('attempts', 3)
const BARS = num('bars', 8)
const BUDGET_MIN = num('budget-min', 10)
const SEPARATE = has('separate')
const TUNING_ID = flag('tuning', 'standard')
const root = process.cwd()

if (!INPUT || !existsSync(INPUT)) {
  console.error(`✗ 找不到输入音频:${INPUT || '(未提供)'}`)
  console.error('  用法:npm run auto -- --in="C:\\path\\song.ogg" [--max-fret=15|22(默认按失真分档)] [--attempts=3] [--bars=8] [--name=曲名]')
  process.exit(2)
}
const tuning = (TUNINGS.find((t) => t.id === TUNING_ID) ?? { midi: STANDARD_TUNING }).midi

function decodeToWav(input: string, out: string, channels: 1 | 2, sampleRate: number) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', String(channels), out], { stdio: 'inherit' })
  } catch {
    console.error('✗ ffmpeg 解码失败:确认 ffmpeg 在 PATH 里,或先把音频转成 wav')
    process.exit(3)
  }
}

async function main() {
  console.log(`📥 输入:${INPUT}`)
  if (!CALIB.enabled) {
    console.log(
      `📐 质量分只用于**同一段内的参数比较**;准确率按"档位"给实测区间(标定回归 r=${CALIB.r.toFixed(2)}、样本 ${CALIB.samples} → 不足以预测,不报预测值)`,
    )
  } else {
    console.log(`📐 质量→准确率标定:${CALIB.samples} 样本,相关性 r=${CALIB.r.toFixed(2)}`)
  }

  const work = mkdtempSync(join(tmpdir(), 'gm-auto-'))
  const monoWav = join(work, 'mono-22k.wav')
  decodeToWav(INPUT, monoWav, 1, 22050)
  const raw = readFileSync(monoWav)
  const dec = decodeWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)

  let pcm22 = dec.channels[0]
  // 失真分档必须在原混音上测(分轨会改写削波/压缩指纹,在分轨产物上测会把失真曲误判成干净)
  const mixDistortion = distortionIndex(pcm22)
  const MAX_FRET = MAX_FRET_FLAG ?? importDefaults(mixDistortion).maxFret
  console.log(
    `🤖 自动模式:分段 ${BARS} 小节 · 每段最多 ${ATTEMPTS} 次尝试 · 预算 ${BUDGET_MIN} 分钟 · 最高品 ${MAX_FRET}${MAX_FRET_FLAG === null ? '(按失真分档)' : ''} · 分轨 ${SEPARATE ? '开' : '关'} · 失真指数 ${mixDistortion.toFixed(2)}`,
  )
  if (SEPARATE) {
    if (mixDistortion >= DISTORTION_ROUTE) {
      console.log(`⚠ 素材是高失真混音(失真指数 ${mixDistortion.toFixed(2)}):分轨在这类素材上实测净亏(《God knows》对人工参考谱 20.6% → 18.5%),建议去掉 --separate`)
    }
    const stWav = join(work, 'stereo.wav')
    decodeToWav(INPUT, stWav, 2, 44100)
    const stRaw = readFileSync(stWav)
    const st = decodeWav(stRaw.buffer.slice(stRaw.byteOffset, stRaw.byteOffset + stRaw.byteLength) as ArrayBuffer)
    console.log('🎛 分轨预处理中…')
    const stems = separateDsp(st.channels, st.sampleRate, { centerSuppress: 0.6 })
    compensateLevelInPlace(stems.guitar)
    pcm22 = resampleLinear(toMono(stems.guitar as Float32Array[], stems.guitar[0].length), st.sampleRate, SR)
  }

  console.log('🧠 推理(只做一次)…')
  const t0 = Date.now()
  const modelUrl = await ensureModelServer(root)
  const res = await autoTranscribe(pcm22, tuning, {
    modelUrl,
    maxAttempts: ATTEMPTS,
    barsPerSegment: BARS,
    budgetMs: BUDGET_MIN * 60 * 1000,
    maxFret: MAX_FRET,
    distortion: mixDistortion,
    onStage: (s) => {
      if (s.phase === 'infer') process.stdout.write(`\r   推理 ${s.detail ?? ''}   `)
      else if (s.phase === 'segments') process.stdout.write(`\r   自评 ${s.detail ?? ''}   `)
    },
  })
  console.log(`\n   完成,总用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`)

  // ---- 段级审查报告 ----
  const segDir = join(OUT_ROOT, `${NAME}-auto`)
  mkdirSync(segDir, { recursive: true })
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  const lines: string[] = []
  lines.push(`# 自动扒谱逐段审查报告`)
  lines.push('')
  lines.push(`- 输入:\`${INPUT}\``)
  lines.push(`- 检测 BPM:${res.bpm}(锁定度 ${(res.bpmStrength * 100).toFixed(0)}%)· 整体音准 ${res.tuningCents > 0 ? '+' : ''}${res.tuningCents}¢ · 调性 ${res.globalKey?.name ?? '未检出'}`)
  lines.push(`- 段落:${res.segments.length} 段 · 合格 ${res.summary.pass} / 待复核 ${res.summary.review} / 不合格 ${res.summary.fail}`)
  lines.push(
    `- 平均质量分 ${res.summary.meanScore.toFixed(3)} · 参数尝试共 ${res.summary.totalAttempts} 次(每段最多 ${res.summary.attemptsPerSegment} 次` +
      (res.summary.attemptsPerSegment === 1 ? ':失真档用召回聚合提取,闭环可调的参数改不动交付结果,不再空转重试' : '') +
      ')',
  )
  if (res.summary.gridSuspectSegments > 0) {
    lines.push(`- ⚠ 节奏落格差的段:${res.summary.gridSuspectSegments} 段(疑似 BPM 或第一拍不准;未自动重估,请在页面核对 BPM 并用「整体左右移动」对齐第一拍)`)
  }
  if (res.summary.expectedF1 !== null) {
    lines.push(`- **预计音符级准确率 ${(res.summary.expectedF1 * 100).toFixed(1)}%**(标定自真实 GuitarSet,r=${CALIB.r.toFixed(2)})`)
  } else if ((res.summary.distortion ?? 0) >= DISTORTION_ROUTE) {
    lines.push(`- 档位区间(按段加权,来自实测):**约 ${(res.summary.regimeF1 * 100).toFixed(0)}%** 音符级`)
    lines.push(`  > ⚠ **高失真混音(失真指数 ${(res.summary.distortion ?? 0).toFixed(2)}):"预计准确率"拒报。**`)
    lines.push(`  > 标定回归是在干净素材上拟合的,对失真混音外转会严重虚高(实测案例:自评 0.69/预计 61% 的失真整曲,`)
    lines.push(`  > 与人工参考谱的真实一致度仅个位数)。同理,下表的"✅ 合格"只代表**内部一致性**(低置信/幻觉少),`)
    lines.push(`  > **不代表真实准确率** —— 这类素材请走参考谱引导模式(REF.md)或换更强模型。`)
  } else {
    lines.push(`- 档位区间(按段加权,来自实测):**约 ${(res.summary.regimeF1 * 100).toFixed(0)}%** 音符级`)
    lines.push(`  > 说明:质量分与真实 F1 的回归 **r=${CALIB.r.toFixed(2)}(样本 ${CALIB.samples})不足以做逐段预测**,`)
    lines.push(`  > 因此这里给的是"该素材档位的历史实测区间",而不是对你这首歌的预测。`)
  }
  lines.push('')
  lines.push('| 段落 | 时间 | 判定 | 分数 | 档位 | 音符 | 试了 | 最终参数 | 主要问题 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const s of res.segments) {
    const v = s.best.assessment
    const icon = v.verdict === 'pass' ? '✅ 合格' : v.verdict === 'review' ? '⚠ 待复核' : '❌ 不合格'
    lines.push(
      `| ${s.index + 1} | ${mmss(s.t0)}–${mmss(s.t1)} | ${icon} | ${v.score.toFixed(3)} | ${v.regime} | ${s.best.notes.length} | ${s.attempts.length} | \`${paramsKey(s.best.params)}\` | ${v.issues[0] ?? '—'} |`,
    )
  }
  lines.push('')
  lines.push('## 每次尝试的审计轨迹(改了什么参数、分数怎么变)')
  for (const s of res.segments) {
    if (s.attempts.length <= 1) continue
    lines.push('')
    lines.push(`### 段 ${s.index + 1}(${mmss(s.t0)}–${mmss(s.t1)})`)
    for (const a of s.attempts) {
      lines.push(`- \`${a.key}\` → 分数 ${a.score.toFixed(3)} / ${a.verdict} / ${a.notes} 音符${a.issues[0] ? ` · ${a.issues[0]}` : ''}`)
    }
    if (s.exhausted) lines.push(`- ⏳ 时间预算用尽,该段未继续重试`)
  }
  const segPath = join(segDir, `${NAME}.segments.md`)
  writeFileSync(segPath, lines.join('\n'), 'utf8')

  // ---- 谱面产物 ----
  const songName = `${NAME}(自动-${res.summary.pass}/${res.segments.length}合格)`
  const libraryPath = join(segDir, `${NAME}.library.json`)
  writeFileSync(
    libraryPath,
    JSON.stringify(
      {
        version: 1,
        songs: [{ id: `s${Date.now()}`, name: songName, bpm: res.bpm, tuningId: TUNING_ID, notes: res.tab, updatedAt: Date.now(), grid: 12 }],
      },
      null,
      0,
    ),
    'utf8',
  )
  writeFileSync(join(segDir, `${NAME}.tab.txt`), tabToText(res.tab), 'utf8')
  writeFileSync(join(segDir, `${NAME}.mid`), Buffer.from(tabToMidi(res.tab, res.bpm)))
  writeFileSync(
    join(segDir, `${NAME}.report.json`),
    JSON.stringify(
      {
        input: INPUT,
        generatedAt: new Date().toISOString(),
        settings: { maxFret: MAX_FRET, attempts: ATTEMPTS, barsPerSegment: BARS, separate: SEPARATE, tuning: TUNING_ID },
        calibration: CALIB,
        bpm: res.bpm,
        bpmStrength: res.bpmStrength,
        tuningCents: res.tuningCents,
        key: res.globalKey?.name ?? null,
        summary: res.summary,
        segments: res.segments.map((s) => ({
          index: s.index,
          t0: s.t0,
          t1: s.t1,
          verdict: s.best.assessment.verdict,
          score: s.best.assessment.score,
          expectedF1: s.best.assessment.expectedF1,
          notes: s.best.notes.length,
          issues: s.best.assessment.issues,
          chosen: s.best.params,
          attempts: s.attempts,
          exhausted: s.exhausted,
        })),
      },
      null,
      2,
    ),
    'utf8',
  )
  rmSync(work, { recursive: true, force: true })
  closeModelServer()

  console.log('\n' + '='.repeat(76))
  console.log(`📋 逐段审查:合格 ${res.summary.pass} / 待复核 ${res.summary.review} / 不合格 ${res.summary.fail}(共 ${res.segments.length} 段)`)
  console.log(
    `   平均质量分 ${res.summary.meanScore.toFixed(3)} · ` +
      (res.summary.expectedF1 !== null
        ? `预计准确率 ${(res.summary.expectedF1 * 100).toFixed(1)}%`
        : `档位区间约 ${(res.summary.regimeF1 * 100).toFixed(0)}%(实测区间,非预测)`),
  )
  if ((res.summary.distortion ?? 0) >= DISTORTION_ROUTE) {
    console.log(`   ⚠ 高失真混音(失真指数 ${(res.summary.distortion ?? 0).toFixed(2)}):标定预测与"合格"判定只代表内部一致性,不代表真实准确率(见报告警示)`)
  }
  const bad = res.segments.filter((s) => s.best.assessment.verdict !== 'pass')
  if (bad.length) {
    console.log(`   ⚠ 需要人工复核的段落(${bad.length}):`)
    for (const s of bad.slice(0, 12)) {
      console.log(`     ${mmss(s.t0)}–${mmss(s.t1)} ${s.best.assessment.verdict === 'review' ? '待复核' : '不合格'} · 分 ${s.best.assessment.score.toFixed(2)} · ${s.best.assessment.issues[0] ?? ''}`)
    }
  }
  console.log('\n✅ 产物:')
  console.log(`   逐段审查报告:      ${segPath}`)
  console.log(`   曲库文件:          ${libraryPath}`)
  console.log(`   文本 Tab / MIDI:   ${join(segDir, NAME + '.tab.txt')} / ${NAME}.mid(${res.tab.length} 音符)`)
  console.log(`   完整审计轨迹:      ${join(segDir, NAME + '.report.json')}`)
  console.log('\n下一步:页面「📚 曲库」→「📂 导入曲库」→ 选上面的 .library.json')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
