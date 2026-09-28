// 运行算法自测:esbuild 打包 TS 测试 → node 执行
import { execSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tests = ['test-sanity.ts', 'test-tone.ts', 'test-pitch.ts', 'test-cleanup.ts', 'test-loudness.ts']
let failed = false
for (const t of tests) {
  const out = `.test-${t.replace('.ts', '')}.cjs`
  try {
    execSync(`npx esbuild ${join(root, t)} --bundle --format=cjs --platform=node --outfile=${join(root, out)} --log-level=error`, { stdio: 'inherit' })
    execSync(`node ${join(root, out)}`, { stdio: 'inherit', cwd: root })
  } catch {
    failed = true
  } finally {
    try {
      unlinkSync(join(root, out))
    } catch {
      /* ignore */
    }
  }
}
process.exit(failed ? 1 : 0)
