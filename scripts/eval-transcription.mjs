// 运行扒谱准确率评估:esbuild 打包 TS 评估入口 → node 执行
//
//   node scripts/eval-transcription.mjs --engine=both --variant=both --json=eval/report.json
//
// tfjs 与 basic-pitch 声明为 external:打包它们会踩动态 require 的问题,
// 交给 Node 原生 ESM 解析更稳(与 scripts/test-bp.mjs 同思路)。

import { execSync } from 'node:child_process'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'scripts', 'eval', 'main.ts')
const outDir = join(root, '.eval')
const out = join(outDir, 'main.mjs')

mkdirSync(outDir, { recursive: true })
const externals = ['--external:@tensorflow/tfjs', '--external:@spotify/basic-pitch'].join(' ')
execSync(
  `npx esbuild "${entry}" --bundle --format=esm --platform=node --target=node20 ` +
    `--outfile="${out}" --log-level=error ${externals}`,
  { stdio: 'inherit', cwd: root },
)

const passthrough = process.argv
  .slice(2)
  .map((a) => (/\s/.test(a) ? `"${a}"` : a))
  .join(' ')

let failed = false
try {
  execSync(`node "${out}" ${passthrough}`, { stdio: 'inherit', cwd: root })
} catch {
  failed = true
} finally {
  if (!failed && existsSync(out)) {
    try {
      unlinkSync(out)
    } catch {
      /* ignore */
    }
  }
}
process.exit(failed ? 1 : 0)
