// 离线扒谱命令的启动器:把 TS 版实现用 esbuild 打包后交给 node 执行
// (项目里的 src 是 TS,node 不能直接跑;测试脚本用的是同一套做法)
import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.transcribe.cjs')
const passArgs = process.argv.slice(2)

try {
  execFileSync('npx', ['esbuild', join(root, 'scripts', 'transcribe-file.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${out}`, '--log-level=error'], {
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
