// 复制 Basic Pitch 模型与 tfjs WASM 后端到 public/vendor(本地分发,离线可用)
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'node_modules', '@spotify', 'basic-pitch', 'model')
const dstDir = join(root, 'public', 'vendor', 'basic-pitch')
const wasmSrc = join(root, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist')
const wasmDst = join(root, 'public', 'vendor', 'tfjs-wasm')

if (!existsSync(srcDir)) {
  console.error('未找到 node_modules/@spotify/basic-pitch/model,请先 npm install')
  process.exit(1)
}
mkdirSync(dstDir, { recursive: true })
for (const f of ['model.json', 'group1-shard1of1.bin']) {
  copyFileSync(join(srcDir, f), join(dstDir, f))
  console.log(`已复制 ${f}`)
}

mkdirSync(wasmDst, { recursive: true })
for (const f of readdirSync(wasmSrc).filter((f) => f.endsWith('.wasm'))) {
  copyFileSync(join(wasmSrc, f), join(wasmDst, f))
  console.log(`已复制 tfjs-wasm/${f}`)
}
