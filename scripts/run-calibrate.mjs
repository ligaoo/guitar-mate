// 质量指标标定命令的启动器(把代理质量分回归到真实 GuitarSet 的音符级 F1)
import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.calibrate.cjs')

try {
  execFileSync('npx', ['esbuild', join(root, 'scripts', 'eval', 'calibrate-quality.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${out}`, '--log-level=error'], {
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
