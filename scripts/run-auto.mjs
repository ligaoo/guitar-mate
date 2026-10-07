// 全自动扒谱命令的启动器(与 run-transcribe.mjs 同构:esbuild 打包 TS → node 执行)
import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.auto.cjs')
const passArgs = process.argv.slice(2)

try {
  execFileSync('npx', ['esbuild', join(root, 'scripts', 'auto-transcribe.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${out}`, '--log-level=error'], {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
  })
  execFileSync(process.execPath, [out, ...passArgs], { stdio: 'inherit', cwd: root })
} finally {
  try {
    unlinkSync(out)
  } catch {
    /* ignore */
  }
}
