// 音源分离自测:长度/采样率一致性 + 三类成分能否被正确分开
//
// 这些断言刻意只用"能量占比"这类稳健量,不去比对波形(掩码方法本来就不是无损重建),
// 目标是守住行为契约:去鼓要真去得掉、硬左右的内容不能被中置抑制误伤。

import { separateDsp } from './src/transcription/separation'
import { renderPluckSamples } from './src/audio/synth'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

const SR = 22050

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rms = (chs: Float32Array[]) => {
  let s = 0
  let n = 0
  for (const ch of chs)
    for (let i = 0; i < ch.length; i++) {
      s += ch[i] * ch[i]
      n++
    }
  return n ? Math.sqrt(s / n) : 0
}

/** 稳态区 RMS:掐掉首尾 0.3s。信号末尾被硬切会产生宽带瞬态,
 *  那是测试信号自身的边界效应,不该算到掩码的频段选择性头上。 */
const EDGE = Math.floor(0.3 * SR)
const rmsMid = (ch: Float32Array) => {
  let s = 0
  for (let i = EDGE; i < ch.length - EDGE; i++) s += ch[i] * ch[i]
  return Math.sqrt(s / (ch.length - 2 * EDGE))
}

const SECONDS = 3
const total = Math.ceil(SECONDS * SR)

/** 居中的底鼓/军鼓式瞬态(宽带、非谐波) */
function makeDrums(): Float32Array {
  const out = new Float32Array(total)
  const rng = makeRng(7)
  for (let hit = 0; hit < 6; hit++) {
    const from = Math.round(hit * 0.5 * SR)
    for (let i = 0; i < SR * 0.15 && from + i < total; i++) {
      const t = i / SR
      const env = Math.exp(-t / 0.03)
      out[from + i] += (rng() * 2 - 1) * env
    }
  }
  return out
}

/** 偏硬的持续谐波音(模拟吉他/人声的长音) */
function makeTone(midi: number, seed: number): Float32Array {
  const out = new Float32Array(total)
  const f = 440 * Math.pow(2, (midi - 69) / 12)
  const buf = renderPluckSamples(f, SR, SECONDS, 0.7, makeRng(seed))
  for (let i = 0; i < total && i < buf.length; i++) out[i] = buf[i]
  return out
}

// ---- 1) 长度与声道数一致 ----
{
  const L = makeTone(60, 11)
  const R = makeTone(67, 12)
  const stems = separateDsp([L, R], SR)
  const same =
    stems.guitar[0].length === total &&
    stems.guitar[1].length === total &&
    stems.percussive[0].length === total &&
    stems.bass[0].length === total &&
    stems.guitar.length === 2
  ok(same, `输出长度与声道数一致(${stems.guitar.length} 声道 × ${stems.guitar[0].length} 采样)`)
  ok(stems.info.fftSize === 2048, `22050Hz 下 FFT 尺寸 ${stems.info.fftSize}(≈10.8Hz 分辨率)`)
}

// ---- 2) 纯打击乐输入:能量应主要落在 percussive ----
{
  const drums = makeDrums()
  const stems = separateDsp([drums, drums], SR)
  const eP = rmsMid(stems.percussive[0])
  const eG = rmsMid(stems.guitar[0])
  // 底鼓/军鼓是宽带瞬态:低频切除后仍会有一些能量留在吉他轨,但不应是主体
  ok(eP > eG * 1.5, `纯打击乐:percussive RMS ${eP.toFixed(4)} vs guitar ${eG.toFixed(4)}(>1.5×)`)
}

// ---- 3) 硬左右 + 中置抑制:硬左右的谐波内容不能被误伤 ----
{
  const guitar = makeTone(64, 21)
  const left = guitar.slice()
  const right = new Float32Array(total) // 只有左声道有声 = 硬左
  const withSup = separateDsp([left, right], SR, { centerSuppress: 0.9 })
  const noSup = separateDsp([left, right], SR, { centerSuppress: 0 })
  const eWith = rmsMid(withSup.guitar[0])
  const eNo = rmsMid(noSup.guitar[0])
  ok(
    eWith > eNo * 0.9,
    `硬左内容在中置抑制 0.9 下基本保留(RMS ${eWith.toFixed(4)} vs ${eNo.toFixed(4)},>0.9×)`,
  )
  ok(withSup.guitar[0].length === total, '硬左内容长度不变')
}

// ---- 4) 完全居中的谐波内容:中置抑制应显著压低它 ----
{
  const tone = makeTone(64, 31)
  const withSup = separateDsp([tone, tone.slice()], SR, { centerSuppress: 0.8 })
  const noSup = separateDsp([tone, tone.slice()], SR, { centerSuppress: 0 })
  const eWith = rmsMid(withSup.guitar[0])
  const eNo = rmsMid(noSup.guitar[0])
  ok(eWith < eNo * 0.75, `居中内容被中置抑制压低(RMS ${eWith.toFixed(4)} vs ${eNo.toFixed(4)},<0.75×)`)
}

// ---- 5) 低频切除:低频成分主要归到 bass 轨 ----
//
// 注意这里的阈值是**实测权衡后的契约**,不是"越低越好":
// 掩码的频率分辨率是 10.8Hz(22050/2048),而贝斯基频 50Hz 与吉他 6 弦 D2 73.4Hz
// 只隔约 2 个 bin。要把 50Hz 压到 0.1× 以下,过渡带就必须吃掉 64.6Hz 那个 bin,
// 而 D2/E2 的能量正落在 64.6~86Hz 上 —— 实测会再削掉 D2 约 10%。
// 而 <70Hz 的内容本来就被两个引擎切掉(BP 的 constrainFrequency minHz=70、YIN fmin=70),
// 所以这里选择"压到 0.2× 左右、但不碰吉他最低两根弦"(见 5b)。
{
  const low = new Float32Array(total)
  for (let i = 0; i < total; i++) low[i] = Math.sin((2 * Math.PI * 50 * i) / SR) * 0.5
  const stems = separateDsp([low, low.slice()], SR, { centerSuppress: 0 })
  const eG = rmsMid(stems.guitar[0])
  const eB = rmsMid(stems.bass[0])
  const eIn = rmsMid(low)
  ok(eG < eIn * 0.3 && eB > eIn * 0.9, `50Hz 主要归到 bass 轨:guitar ${(eG / eIn).toFixed(3)}× 输入, bass ${(eB / eIn).toFixed(3)}×`)
}

// ---- 5b) 低频切除不能伤到吉他最低两根弦的基频(D2 73.4Hz / E2 82.4Hz) ----
// 旧实现(lowCutHz×(0.6,1.6) = 42→112Hz 宽带阶跃)实测 D2 −7.4dB、E2 −4.3dB ——
// 正好削在吉他最要紧的两个音上,而对 >110Hz 的贝斯谐波毫无作用(0.00dB)。
{
  const gainAt = (hz: number) => {
    const x = new Float32Array(total)
    for (let i = 0; i < total; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / SR) * 0.5
    const stems = separateDsp([x, x.slice()], SR, { centerSuppress: 0 })
    const a = Math.floor(total * 0.2)
    const b = Math.floor(total * 0.8)
    let so = 0
    let si = 0
    for (let i = a; i < b; i++) {
      so += stems.guitar[0][i] * stems.guitar[0][i]
      si += x[i] * x[i]
    }
    return Math.sqrt(so / si)
  }
  const gD2 = gainAt(73.42)
  const gE2 = gainAt(82.41)
  ok(gD2 > 0.95, `Drop D 的 D2(73.4Hz)在吉他轨基本无损(增益 ${gD2.toFixed(3)} > 0.95,旧实现 0.43)`)
  ok(gE2 > 0.98, `标准调弦 6 弦 E2(82.4Hz)在吉他轨基本无损(增益 ${gE2.toFixed(3)} > 0.98,旧实现 0.62)`)
}

// ---- 6) 空输入不崩 ----
{
  const stems = separateDsp([new Float32Array(0)], SR)
  ok(stems.guitar[0].length === 0, '空输入返回空输出而不抛异常')
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
