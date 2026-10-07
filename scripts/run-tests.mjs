// 运行算法自测:esbuild 打包 TS 测试 → node 执行
import { execSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 顺序:先快后慢。test-real-eval 需要本地 GuitarSet 数据(不在场会自动跳过),
// 数据在场时约 20~30s —— 这是唯一能在 CI 之外守住"真实录音准确率不回退"的关卡。
const tests = [
  'test-sanity.ts',
  'test-tone.ts',
  'test-pitch.ts',
  'test-cleanup.ts',
  'test-loudness.ts',
  'test-onset.ts',
  'test-separation.ts',
  'test-bp-post.ts',
  'test-tuning.ts',
  'test-timing.ts',
  'test-bpm.ts',
  'test-chunking.ts',
  'test-recall.ts',
  'test-metrics.ts',
  'test-quantize.ts',
  'test-library.ts',
  'test-auto.ts',
  'test-import-e2e.ts',
  'test-ref-align.ts',
  'test-eval-smoke.ts',
  'test-real-eval.ts',
]
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
