// 扒谱评估:无依赖 WAV 读写(Node 端)
//
// 解码支持 RIFF/WAVE 的 16/24/32 位整数 PCM 与 32/64 位 IEEE float;
// 编码固定 16 位 PCM(给测试与 fixture 预处理用)。不依赖任何 npm 包。

export interface DecodedWav {
  channels: Float32Array[]
  sampleRate: number
  duration: number
}

export function decodeWav(buf: ArrayBuffer | Uint8Array): DecodedWav {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const tag = (o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是 RIFF/WAVE 文件')
  let off = 12
  let fmt = 1
  let nCh = 1
  let sr = 44100
  let bits = 16
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= u8.length) {
    const id = tag(off)
    const size = dv.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = dv.getUint16(body, true)
      nCh = dv.getUint16(body + 2, true)
      sr = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, u8.length - body)
    }
    off = body + size + (size % 2)
  }
  if (dataOff < 0) throw new Error('WAV 缺少 data 块')
  const bytesPerSample = bits / 8
  const n = Math.floor(dataLen / bytesPerSample / nCh)
  const channels: Float32Array[] = Array.from({ length: nCh }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const o = dataOff + (i * nCh + c) * bytesPerSample
      let v = 0
      if (fmt === 3 && bits === 32) v = dv.getFloat32(o, true)
      else if (fmt === 3 && bits === 64) v = dv.getFloat64(o, true)
      else if (bits === 16) v = dv.getInt16(o, true) / 32768
      else if (bits === 24) v = ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) as number) / 8388608
      else if (bits === 32) v = dv.getInt32(o, true) / 2147483648
      else throw new Error(`不支持的 WAV 格式:fmt=${fmt} bits=${bits}`)
      channels[c][i] = v
    }
  }
  return { channels, sampleRate: sr, duration: n / sr }
}

/** 16 位 PCM WAV 编码(单/多声道) */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nCh = channels.length
  const n = channels[0]?.length ?? 0
  const dataLen = n * nCh * 2
  const out = new Uint8Array(44 + dataLen)
  const dv = new DataView(out.buffer)
  const wtag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i)
  }
  wtag(0, 'RIFF')
  dv.setUint32(4, 36 + dataLen, true)
  wtag(8, 'WAVE')
  wtag(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, nCh, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * nCh * 2, true)
  dv.setUint16(32, nCh * 2, true)
  dv.setUint16(34, 16, true)
  wtag(36, 'data')
  dv.setUint32(40, dataLen, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]))
      dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true)
      o += 2
    }
  }
  return out
}
