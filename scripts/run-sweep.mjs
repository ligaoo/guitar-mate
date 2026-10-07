// 参数寻优命令的启动器(真实 GuitarSet 上按档搜索后处理参数最优区)
import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.sweep.cjs')

try {
  execFileSync('npx', ['esbuild', join(root, 'scripts', 'eval', 'param-sweep.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${out}`, '--log-level=error'], {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
  })
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root })
} finally {
  try {
    unlinkSync(out)
  } catch {
    /* ignore */
  }
}
