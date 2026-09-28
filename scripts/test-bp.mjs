// Node 端验证 Basic Pitch:onComplete 语义 + 合成旋律识别效果
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch'
import * as tf from '@tensorflow/tfjs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modelDir = join(root, 'public', 'vendor', 'basic-pitch')

// 临时静态服务供 tfjs fetch 模型
const server = createServer(async (req, res) => {
  const file = join(modelDir, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
  try {
    const buf = await readFile(file)
    res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
    res.end(buf)
  } catch {
    res.statusCode = 404
    res.end()
  }
})
await new Promise((r) => server.listen(18765, r))
const MODEL = 'http://127.0.0.1:18765/model.json'

// Karplus-Strong 拨弦合成(物理建模,接近真实吉他录音分布),22050Hz
const SR = 22050
const notes = [64, 66, 68, 69, 71, 73, 75, 76]
const noteDur = 0.5
const total = Math.floor(SR * (notes.length * noteDur + 0.4))
const data = new Float32Array(total)
const pluck = (midi, startSec) => {
  const f = 440 * Math.pow(2, (midi - 69) / 12)
  const N = Math.round(SR / f)
  const delay = new Float32Array(N)
  let lp = 0
  for (let i = 0; i < N; i++) {
    const w = Math.random() * 2 - 1
    lp += 0.7 * (w - lp)
    delay[i] = lp
  }
  let idx = 0
  const from = Math.floor(startSec * SR)
  for (let n = from; n < total; n++) {
    const cur = delay[idx]
    const nxt = delay[(idx + 1) % N]
    data[n] += 0.7 * cur
    delay[idx] = 0.996 * 0.5 * (cur + nxt)
    idx = (idx + 1) % N
  }
}
notes.forEach((m, i) => pluck(m, i * noteDur))
// 归一化
let peak = 0
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(data[i]))
for (let i = 0; i < total; i++) data[i] = (data[i] / peak) * 0.9

await tf.setBackend('cpu')
await tf.ready()
console.log('backend:', tf.getBackend())

const bp = new BasicPitch(MODEL)
let calls = 0
let lens = []
let frames = []
let onsets = []
let contours = []
await bp.evaluateModel(
  data,
  (f, o, c) => {
    calls++
    lens.push(f.length)
    // 每批次增量回调,必须拼接
    frames = frames.concat(f)
    onsets = onsets.concat(o)
    contours = contours.concat(c)
  },
  (p) => process.stdout.write(`\r推理进度 ${(p * 100).toFixed(0)}%   `),
)
console.log(`\nonComplete 调用 ${calls} 次,每次 frames 长度: ${JSON.stringify(lens)}`)
console.log('拼接后 frames 总长:', frames.length, '(期望 ≈', Math.floor(total / SR / (256 / 22050)), '帧)')

for (const [ot, ft] of [[0.5, 0.3], [0.35, 0.2], [0.25, 0.12]]) {
  const events = outputToNotesPoly(frames, onsets, ot, ft, 60, true, null, null, true)
  const timed = noteFramesToTime(events)
  console.log(`阈值 onset=${ot} frame=${ft} → 识别 ${timed.length} 个: `)
  for (const n of timed) {
    console.log(`  midi=${n.pitchMidi} @${n.startTimeSeconds.toFixed(2)}s dur=${n.durationSeconds.toFixed(2)} amp=${n.amplitude.toFixed(2)}`)
  }
}
server.close()
