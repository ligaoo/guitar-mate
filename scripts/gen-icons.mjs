// 生成 PWA 图标(192/512 PNG):深色圆角底 + 青绿色吉他拨片,4x 超采样抗锯齿
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')

// ---- PNG 编码 ----
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeB = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])))
  return Buffer.concat([len, typeB, data, crc])
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---- 图形 ----
const BG = [22, 26, 34, 255] // #161a22
const PICK = [76, 194, 169, 255] // #4cc2a9

function inRoundedRect(x, y, S) {
  const r = 0.22 * S
  const cx = Math.min(Math.max(x, r), S - r)
  const cy = Math.min(Math.max(y, r), S - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= S - r) || (y >= r && y <= S - r)
}

function inPick(x, y, S) {
  const ccx = 0.5 * S
  const ccy = 0.4 * S
  const r = 0.26 * S
  if ((x - ccx) ** 2 + (y - ccy) ** 2 <= r * r) return true
  // 圆两侧切点向下收拢到尖端
  const a = 160 * (Math.PI / 180)
  const left = [ccx + r * Math.cos(a), ccy + r * Math.sin(a)]
  const right = [ccx - r * Math.cos(a), ccy + r * Math.sin(a)]
  const tip = [0.5 * S, 0.82 * S]
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  const d1 = sign([x, y], left, right)
  const d2 = sign([x, y], right, tip)
  const d3 = sign([x, y], tip, left)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function render(size) {
  const SS = 4
  const W = size * SS
  const rgba = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 4x4 超采样
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) / SS
          const y = (py * SS + sy + 0.5) / SS
          if (!inRoundedRect(x, y, size)) continue
          const c = inPick(x, y, size) ? PICK : BG
          r += c[0]; g += c[1]; b += c[2]; a += 255
        }
      }
      const n = SS * SS
      const i = (py * size + px) * 4
      if (a === 0) {
        rgba[i + 3] = 0
      } else {
        rgba[i] = Math.round(r / (a / 255))
        rgba[i + 1] = Math.round(g / (a / 255))
        rgba[i + 2] = Math.round(b / (a / 255))
        rgba[i + 3] = Math.round(a / n)
      }
    }
  }
  return encodePNG(size, size, rgba)
}

mkdirSync(outDir, { recursive: true })
for (const s of [192, 512]) {
  writeFileSync(join(outDir, `icon-${s}.png`), render(s))
  console.log(`生成 icon-${s}.png`)
}
