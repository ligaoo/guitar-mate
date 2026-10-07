// 训练语料构建器(PLAN-90 阶段 3 域适配 / 阶段 4 数据工厂的汇合点)。
//
// 把两类「音频 + 音符级标注」统一成一份 JSONL,供任何训练器(MT3 微调 / Basic Pitch
// 微调 / 六线谱输出层)直接消费——行业缺的正是真实录音的这类标注,我们自己能产:
//   ① ref-pipeline 的 triple.json(真实整曲混音 + 人工谱 + 逐音验证)
//   ② GuitarSet 的 jams 标注(3h 干净麦克风录音,弦/品级)
//
// 每行一条:{ id, source, audio(绝对路径), duration, bpm,
//            notes: [{ t, dur, midi, string?, fret?, conf?, track? }] }(t/dur 单位秒)
// mix 音频 + 多轨标注时 notes 取「吉他轨并集」(音频里两把吉他都在,转录目标就是并集),
// 每音带 track 标签;conf 来自逐音验证分级(训练时可按 conf 加权/过滤)。
//
// 用法:
//   node .bc.cjs --triples="D:/music/tab-out/God knows-ref" [--triples=...]
//                [--guitarset-dir=D:/music/guitarset-data] [--out=eval/corpus-guitar.jsonl]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
const flags = (name: string): string[] =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))
const flag = (name: string, def = ''): string => flags(name)[0] ?? def

interface CorpusNote {
  t: number
  dur: number
  midi: number
  string?: number
  fret?: number
  conf?: number
  track?: string
}
interface CorpusEntry {
  id: string
  source: 'ref-triple' | 'guitarset'
  audio: string
  duration: number
  bpm: number
  notes: CorpusNote[]
}

// ---- ① triple.json(数据工厂产物)----
function loadTriples(dirOrFile: string): CorpusEntry[] {
  const out: CorpusEntry[] = []
  const targets: string[] = []
  if (dirOrFile.endsWith('.triple.json')) targets.push(dirOrFile)
  else if (existsSync(dirOrFile)) {
    for (const f of readdirSync(dirOrFile)) if (f.endsWith('.triple.json')) targets.push(join(dirOrFile, f))
  }
  for (const p of targets) {
    const tr = JSON.parse(readFileSync(p, 'utf8')) as {
      song: string
      audio: string
      bpm: number
      tuning: number[]
      align: { offset: number; scale: number }
      tracks: Array<{ label: string; notes: Array<{ t: number; dur: number; midi: number; string: number; fret: number; conf: number }> }>
    }
    // mix 音频:吉他轨并集即转录目标;逐音带 track 与验证 conf
    const notes: CorpusNote[] = []
    let lastEnd = 0
    for (const tk of tr.tracks) {
      for (const n of tk.notes) {
        notes.push({ t: n.t, dur: n.dur, midi: n.midi, string: n.string, fret: n.fret, conf: n.conf, track: tk.label })
        lastEnd = Math.max(lastEnd, n.t + n.dur)
      }
    }
    notes.sort((a, b) => a.t - b.t || a.midi - b.midi)
    out.push({ id: `ref:${tr.song}`, source: 'ref-triple', audio: tr.audio, duration: lastEnd + 2, bpm: tr.bpm, notes })
  }
  return out
}

// ---- ② GuitarSet(jams → 弦/品级标注;解析逻辑与 prepare-guitarset.mjs 同源)----
const GS_OPEN = [40, 45, 50, 55, 59, 64] // 标准调弦(音高),与 note_midi 注解顺序 弦6→1 对应
function loadGuitarSet(dataDir: string): CorpusEntry[] {
  const annDir = join(dataDir, 'annotation')
  const audioDir = join(dataDir, 'audio_mono-mic')
  if (!existsSync(annDir)) {
    console.warn(`跳过 GuitarSet:找不到 ${annDir}`)
    return []
  }
  const out: CorpusEntry[] = []
  let missingAudio = 0
  for (const f of readdirSync(annDir).filter((f) => f.endsWith('.jams')).sort()) {
    const j = JSON.parse(readFileSync(join(annDir, f), 'utf8')) as {
      file_metadata?: { duration?: number }
      annotations?: Array<{ namespace: string; data?: Array<{ time: number; duration?: number; value: number }> }>
    }
    // 音频文件名 = jams 同名 + _mic 后缀(audio_mono-mic 释放后即为该布局)
    const audio = join(audioDir, f.replace(/\.jams$/, '_mic.wav'))
    if (!existsSync(audio)) {
      missingAudio++
      continue
    }
    let bpm = 0
    for (const a of j.annotations ?? []) {
      if (a.namespace === 'tempo' && a.data?.length) bpm = Math.round(a.data[0].value)
    }
    // note_midi 注解顺序 = 弦 6→1;映射到我们的约定 string 0=最低弦
    const notes: CorpusNote[] = []
    ;(j.annotations ?? []).forEach((ann, si) => {
      if (ann.namespace !== 'note_midi') return
      for (const d of ann.data ?? []) {
        const midi = Math.round(d.value)
        const fret = midi - GS_OPEN[si]
        if (fret < 0 || fret > 22) continue // 防御:跨弦音标注异常
        notes.push({ t: d.time, dur: Math.max(0.03, d.duration ?? 0.1), midi, string: si, fret })
      }
    })
    notes.sort((a, b) => a.t - b.t || a.midi - b.midi)
    out.push({
      id: `gs:${f.replace(/\.jams$/, '')}`,
      source: 'guitarset',
      audio,
      duration: j.file_metadata?.duration ?? 0,
      bpm,
      notes,
    })
  }
  if (missingAudio) console.warn(`GuitarSet:${missingAudio} 个 jams 没有对应音频(缺 audio_mono-mic),已跳过`)
  return out
}

function main() {
  const outRel = flag('out', 'eval/corpus-guitar.jsonl')
  const entries: CorpusEntry[] = []
  for (const t of flags('triples')) entries.push(...loadTriples(t))
  const gsDir = flag('guitarset-dir')
  if (gsDir) entries.push(...loadGuitarSet(gsDir))
  if (!entries.length) {
    console.error('没有可用条目:--triples=<目录或 .triple.json> 和/或 --guitarset-dir=<GuitarSet 数据目录>')
    process.exit(1)
  }
  const lines = entries.map((e) => JSON.stringify(e))
  const outAbs = isAbsolute(outRel) ? outRel : join(root, outRel)
  mkdirSync(join(outAbs, '..'), { recursive: true })
  writeFileSync(outAbs, lines.join('\n') + '\n', 'utf8')

  const totalNotes = entries.reduce((a, e) => a + e.notes.length, 0)
  const totalHours = entries.reduce((a, e) => a + e.duration, 0) / 3600
  const bySrc = entries.reduce<Record<string, number>>((m, e) => ((m[e.source] = (m[e.source] ?? 0) + 1), m), {})
  console.log(`语料:${entries.length} 条(${Object.entries(bySrc).map(([k, v]) => `${k} ${v}`).join(' + ')}) · ${totalNotes} 音符 · 音频 ${totalHours.toFixed(2)} 小时`)
  console.log(`产物:${outAbs}`)
  console.log('说明:ref-triple 条目是真实混音(mix),转录目标 = 吉他轨并集;guitarset 条目是干净麦克风独奏/伴奏。')
  console.log('下一步(阶段 3.2 域适配):在 Colab 上用这份语料微调——EGDB-PG 的结论是音色多样性决定性(DI 干净音色 22.8% → 256 音色 ~79%)。')
}

main()
