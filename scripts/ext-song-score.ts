// 外部引擎(MT3 / YourMT3 / 微调模型…)整曲输出 vs 人工参考谱:阶段 3 的 M3 数字入口。
//
// 与 ref-compare(产品盲扒链路)走同一套多指标报告(scripts/eval/ref-report.ts),
// 所以 MT3 的数字与 Basic Pitch 的数字可直接同表比较——这是「换模型不改评测」的整曲版。
//
// 输入 JSON 约定(与 eval 链的 <clipId>.<variant>.json 同族,增加可选 program/is_drum):
//   { "model": "mt3", "notes": [ { "start": 0.52, "end": 0.94, "midi": 60,
//                                  "program": 27, "is_drum": false, "confidence": 0.7 } ] }
//   start/end 单位秒(音频时间轴),program = MIDI 音色号(缺省 = 不过滤)。
//
// 用法:
//   node .es.cjs --json=../mt3-out/godknows.raw.json --ref-dir=D:/music/godknows-ref \
//     [--out=eval/ext-godknows-mt3.json] [--min-midi=40] [--max-midi=86]
//   产出:5 指标 + 随机基线 + 分数级 的 markdown 报告 + JSON(与 ref-compare 同版式)。
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadRefContext, scoreEstRow, renderRefReport, type RefAlign } from './eval/ref-report'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name: string, def = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

interface ExtNote {
  start: number
  end?: number
  midi: number
  program?: number
  is_drum?: boolean
  confidence?: number
}

/** GM 音色号里「电吉他家族」(25 钢弦/26 爵士/27 清音/28 闷音/29 过载/30 失真);
 *  24 尼龙弦原声吉他也计入——多乐器模型常把干净段分给原声吉他。 */
const GUITAR_PROGRAMS = new Set([24, 25, 26, 27, 28, 29, 30])

async function main() {
  const jsonPath = flag('json')
  const refDir = flag('ref-dir', 'D:/music/godknows-ref')
  const outFile = flag('out', '')
  if (!jsonPath) {
    console.error('用法:--json=<外部引擎输出> --ref-dir=<参考目录> [--out=eval/ext-*.json] [--min-midi=] [--max-midi=]')
    process.exit(1)
  }
  const modelName = (() => {
    const m = jsonPath.split(/[\\/]/).pop() ?? 'ext'
    return m.replace(/\.raw\.json$|\.json$/, '').replace(/\.[a-z0-9_]+$/, '') || 'ext'
  })()
  const outAbs = join(root, outFile || `eval/ext-godknows-${modelName}.json`)

  const align = JSON.parse(readFileSync(join(refDir, 'align.json'), 'utf8')) as RefAlign
  const readEvents = (f: string) =>
    (JSON.parse(readFileSync(join(refDir, f), 'utf8')) as { events: { t: number; dur: number; midi: number; string: number; fret: number }[] }).events
  const ctx = loadRefContext([readEvents('lead-events.json'), readEvents('rhythm-events.json')], align)
  console.log(`参考:lead ${ctx.lead.length} · 并集 ${ctx.union.length} · 对齐 offset ${align.offset}s ${align.bpmScore}BPM`)

  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as { model?: string; notes: ExtNote[] }
  const all = parsed.notes ?? []
  console.log(`外部输出:${all.length} 音(模型 ${parsed.model ?? modelName})`)

  const minMidi = flag('min-midi') ? parseInt(flag('min-midi'), 10) : 40
  const maxMidi = flag('max-midi') ? parseInt(flag('max-midi'), 10) : 86
  // MT3 是全乐器模型:整曲混音里会把贝斯/鼓/人声旋律都写出来。
  // 三行口径:全部输出(公平但含无关乐器)/ 仅吉他音色(按 program 过滤)/ 吉他+音域过滤(与盲扒同音域)
  const mk = (desc: string, notes: ExtNote[], opts: { clampRange?: boolean } = {}) => ({
    desc,
    notes: notes.length,
    ...scoreEstRow(
      notes
        .filter((n) => !n.is_drum)
        .filter((n) => !opts.clampRange || (n.midi >= minMidi && n.midi <= maxMidi))
        .map((n) => ({ start: n.start, dur: Math.max(0, n.end !== undefined ? n.end - n.start : 0.2), midi: Math.round(n.midi) })),
      ctx,
    ),
  })
  const rows = [mk(`全部输出(非鼓)(n=${all.length})`, all)]
  const guitarOnly = all.filter((n) => n.program === undefined || GUITAR_PROGRAMS.has(n.program))
  const hasProgram = all.some((n) => n.program !== undefined)
  if (hasProgram && guitarOnly.length < all.length) {
    rows.push(mk(`仅吉他音色 program∈GM 24-30(n=${guitarOnly.length})`, guitarOnly))
    rows.push(mk(`仅吉他音色+音域 ${minMidi}-${maxMidi}`, guitarOnly, { clampRange: true }))
  }

  const md =
    renderRefReport(
      `外部引擎 vs 人工参考谱 · 多指标对照(《God knows》· ${parsed.model ?? modelName})`,
      rows,
      `n:参考 lead ${ctx.lead.length} / 并集 ${ctx.union.length};对齐 offset ${align.offset}s · ${align.bpmScore} BPM;外部输出 ${all.length} 音`,
    ) +
    `\n\n> 与产品盲扒链路的同版式报告在 \`eval/ref-compare-godknows.json\`——两表口径相同,可直接对比(阶段 3 的 M3 数字)。`
  console.log('\n' + md)

  mkdirSync(join(root, 'eval'), { recursive: true })
  writeFileSync(
    outAbs,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: jsonPath,
        model: parsed.model ?? modelName,
        metric: 'note-level F1, onset ±50ms + exact pitch, max bipartite matching (MIREX-style)',
        ref: { lead: ctx.lead.length, union: ctx.union.length, align },
        baselineShiftSec: 1.37,
        rows: rows.map((r) => ({
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
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
