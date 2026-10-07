// GuitarSet → 评测样例转换:jams 标注 → eval/real-clips.json
//
// 用法:
//   node scripts/prepare-guitarset.mjs --dir=D:/music/guitarset-data --limit=40
//   node scripts/prepare-guitarset.mjs --dir=... --limit=40 --rel      # 写相对路径(可入库)
//
// 输入目录结构(Zenodo 下载后):
//   annotation/*.jams          360 个标注文件(6 位演奏者 × 60 段)
//   audio_mono-mic/*.wav       与 jams 同名的麦克风混音(评测音频)
//
// 输出:eval/real-clips.json(默认 gitignore;--rel 时写相对仓库根的路径,可入库复现)
// 分层抽样:先按 solo(单音即兴)/ comp(和弦伴奏)分组,再按**风格前缀**(BN1/Funk2/Jazz3…)
// 与**演奏者编号**(文件名首段)轮转,保证覆盖面。
// 旧实现的分层键含速度/调号(每个文件都唯一),导致 --limit=8 抽到的全是 gs-00_*(同一演奏者)。
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const dataDir = resolve(flag('dir', 'D:/music/guitarset-data'))
const limit = parseInt(flag('limit', '8'), 10) || 8
const outPath = resolve(flag('out', 'eval/real-clips.json'))
/** 写成相对仓库根的路径(可入库、可跨机器复现);默认写绝对路径 */
const useRel = args.includes('--rel') || args.includes('-r')
const repoRoot = resolve('.')
const annDir = join(dataDir, 'annotation')
const audioDir = join(dataDir, 'audio_mono-mic')
/** 覆盖数据目录(移动过数据位置时用):评测侧同样读它 */
const envDir = process.env.GM_DATA_DIR ? resolve(process.env.GM_DATA_DIR) : null

if (!existsSync(annDir)) {
  console.error(`找不到标注目录:${annDir}(先从 Zenodo 下载 annotation.zip 解压)`)
  process.exit(1)
}
if (!existsSync(audioDir)) {
  console.error(`找不到音频目录:${audioDir}(先从 Zenodo 下载 audio_mono-mic.zip 解压)`)
  process.exit(1)
}

// GuitarSet 全部为标准调弦(E A D G B E),与 TUNINGS[0] 一致
const OPEN = [40, 45, 50, 55, 59, 64]

const files = readdirSync(annDir).filter((f) => f.endsWith('.jams')).sort()

const parseJams = (path) => {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  let bpm = 0
  const duration = j.file_metadata?.duration ?? 0
  const stringAnns = (j.annotations ?? []).filter((a) => a.namespace === 'note_midi')
  for (const a of j.annotations ?? []) {
    if (a.namespace === 'tempo' && a.data?.length) bpm = Math.round(a.data[0].value)
  }
  // note_midi 注解的顺序 = 弦 6→1(数值范围随索引增大而升高);映射到我们的约定 string 0=最低弦
  const out = []
  stringAnns.forEach((ann, si) => {
    for (const d of ann.data ?? []) {
      const midi = Math.round(d.value)
      const fret = midi - OPEN[si]
      if (fret < 0 || fret > 22) continue // 防御:跨弦音标注异常
      out.push({
        start: d.time,
        dur: Math.max(0.03, d.duration ?? 0.1),
        midi,
        string: si,
        fret,
        velocity: 0.8,
      })
    }
  })
  out.sort((a, b) => a.start - b.start || a.midi - b.midi)
  return { notes: out, bpm, duration }
}

// 分层抽样:solo/comp 交替;同风格前缀(BN1/Funk2…)与同演奏者编号(00/01…)尽量不重复,
// 抽满为止。旧实现把"速度-调号"也算进风格键(每文件唯一),等于没有分层。
const byKind = new Map()
for (const f of files) {
  const kind = f.includes('_solo') ? 'solo' : 'comp'
  if (!byKind.has(kind)) byKind.set(kind, [])
  byKind.get(kind).push(f)
}
const picked = []
const pools = [...byKind.entries()].map(([k, v]) => [k, [...v]])
/** 风格前缀 = 文件名第二段的字母数字前缀(00_BN1-129-Eb_comp → BN1) */
const styleOf = (f) => (f.split('_')[1] ?? f).split('-')[0]
/** 演奏者编号 = 文件名第一段(00/01/…/05) */
const playerOf = (f) => f.split('_')[0]
let pi = 0
while (picked.length < limit && pools.some(([, v]) => v.length)) {
  const pool = pools[pi % pools.length]
  pi++
  if (!pool[1].length) continue
  const usedStyle = new Set(picked.map((p) => p.style))
  const usedPlayer = new Set(picked.map((p) => p.player))
  // 优先级:① 新风格 + 新演奏者 ② 新风格 ③ 新演奏者 ④ 从"已抽中最少"的演奏者轮转取
  // (旧版兜底固定拿排序第 0 个 → 永远是 00_*,--limit=60 时 55/60 都来自演奏者 00)
  let idx = pool[1].findIndex((f) => !usedStyle.has(styleOf(f)) && !usedPlayer.has(playerOf(f)))
  if (idx < 0) idx = pool[1].findIndex((f) => !usedStyle.has(styleOf(f)))
  if (idx < 0) idx = pool[1].findIndex((f) => !usedPlayer.has(playerOf(f)))
  if (idx < 0) {
    const pickedCount = new Map()
    for (const p of picked) pickedCount.set(p.player, (pickedCount.get(p.player) ?? 0) + 1)
    const poolPlayers = [...new Set(pool[1].map(playerOf))]
    const target = poolPlayers.sort((a, b) => (pickedCount.get(a) ?? 0) - (pickedCount.get(b) ?? 0))[0]
    idx = pool[1].findIndex((f) => playerOf(f) === target)
  }
  const take = pool[1].splice(idx, 1)[0]
  if (!take) continue
  picked.push({ file: take, kind: pool[0], style: styleOf(take), player: playerOf(take) })
}

const clips = []
for (const p of picked) {
  const base = p.file.replace(/\.jams$/, '')
  const wavAbs = join(audioDir, `${base}_mic.wav`)
  if (!existsSync(wavAbs)) {
    console.warn(`⚠ 缺音频,跳过:${wavAbs}`)
    continue
  }
  // 走 GM_DATA_DIR 覆盖时用覆盖目录;否则用 --dir
  const wavBase = envDir ? join(envDir, 'audio_mono-mic', `${base}_mic.wav`) : wavAbs
  const wav = useRel ? relative(repoRoot, wavBase).replaceAll('\\', '/') : wavBase
  const { notes, bpm, duration } = parseJams(join(annDir, p.file))
  if (notes.length < 20 || !bpm) {
    console.warn(`⚠ 标注不足,跳过:${p.file}`)
    continue
  }
  clips.push({
    id: `gs-${base}`,
    desc: `GuitarSet ${base}(${p.kind === 'solo' ? '单音即兴' : '和弦伴奏'})`,
    bpm,
    tuning: OPEN,
    tracks: [{ id: 'guitar', instrument: 'guitar', gain: 1, pan: 0, notes }],
    leadIn: 0,
    tail: 0,
    detuneCents: 0,
    a4: 440,
    audio: { path: wav, channel: 0 },
    kind: p.kind,
    duration,
  })
  console.log(`✓ ${base} · ${p.kind} · ${p.player} · BPM ${bpm} · ${notes.length} 音 · ${duration.toFixed(1)}s`)
}

mkdirSync(resolve(outPath, '..'), { recursive: true })
writeFileSync(outPath, JSON.stringify({ source: 'GuitarSet mono-mic', generatedAt: new Date().toISOString(), clips }, null, 2), 'utf8')
const soloN = clips.filter((c) => c.kind === 'solo').length
const players = new Set(clips.map((c) => c.id.split('_')[0].slice(3)))
console.log(`\n已生成 ${outPath}:${clips.length} 个样例(solo ${soloN} / comp ${clips.length - soloN},演奏者 ${players.size} 位)`)
console.log('评测:npm run eval -- --real --engine=bp')
