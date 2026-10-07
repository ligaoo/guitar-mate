// Songsterr v4 谱面 JSON → 音符事件表(独立 CLI 入口;核心实现在 ref-core.ts)
// 用法:npx esbuild scripts/parse-songsterr.ts --bundle --format=cjs --platform=node --outfile=.ps.cjs
//      node .ps.cjs track0.json lead-events.json
import { readFileSync, writeFileSync } from 'node:fs'

import { parseSongsterrTrack } from './ref-core'

const [src, dst] = process.argv.slice(2)
if (!src || !dst) {
  console.error('用法:node .ps.cjs <track.json> <out-events.json>')
  process.exit(1)
}
const tr = JSON.parse(readFileSync(src, 'utf8'))
const parsed = parseSongsterrTrack(tr)
writeFileSync(dst, JSON.stringify({ source: src, ...parsed }, null, 1), 'utf8')
console.log(`${src} → ${dst}:${parsed.events.length} 音符 · ${parsed.measures} 小节 · 谱面时长 ${parsed.duration.toFixed(1)}s · BPM ${parsed.bpm}`)
