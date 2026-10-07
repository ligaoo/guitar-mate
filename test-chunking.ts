// 分块推理时基回归:>60s 音频的帧矩阵必须与真实时间轴对齐(2026-10-07 修复的 bug)。
//
// 背景(basicPitch.ts 的 bpFrameTimeSec 注释):BP 有效帧率 ≈86.582(非名义 86)。
// 旧实现每块按名义 60s 推进,但保留的 5160 帧只覆盖 59.609s → 每块边界丢 0.391s,
// 块 c 的音符整体提前 0.391×c 秒。评测片段全部 <60s,所以只有这个测试能守住。
//
// 做法:伪 bp 对象模拟包的输出契约(每帧在其第 0 桶编码"该帧代表的音频时间"),
// 跑 evaluateChunked 于 150s 合成 PCM,断言拼接矩阵里每个全局帧 k 的编码时间
// 与 bpFrameTimeSec(k) 一致(±2 帧)——旧实现会在第 2 块起偏 0.39s+ 直接爆掉。
import { evaluateChunked, bpFrameTimeSec, bpTimeToFrame, bpFrameSpanSec, BP_FPS_TRUE } from './src/transcription/basicPitch'
import { SR } from './src/transcription/pipeline'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

// 伪模型:输入子数组本身编码了绝对时间(PCM 值 = 采样时刻秒数),
// 第 i 帧编码"块起点绝对时间 + 本块内帧时间 bpFrameTimeSec(i)"(与包的 modelFrameToTime 语义一致);
// 帧数 = floor(len×86/22050)(包的 nominal trim)。
const makeFakeBp = () => ({
  evaluateModel: async (input: Float32Array, onComplete: (f: number[][], o: number[][]) => void) => {
    const chunkStart = input[0] ?? 0 // 该块在整曲中的绝对起点(由 PCM 值编码)
    const n = Math.floor((input.length * 86) / SR)
    const B = 20
    for (let s = 0; s < n; s += B) {
      const batch: number[][] = []
      const onsets: number[][] = []
      for (let i = s; i < Math.min(n, s + B); i++) {
        const row = new Array(88).fill(0)
        row[0] = chunkStart + bpFrameTimeSec(i) // 编码该帧的绝对真实时间
        batch.push(row)
        onsets.push(new Array(88).fill(0))
      }
      onComplete(batch, onsets)
      await new Promise((r) => setTimeout(r, 0))
    }
  },
})

async function main() {
  // 1. 工具函数自洽:互逆 + 与有效帧率一致
  {
    const k = 10320 // 2 块(60s 名义)处的帧
    const t = bpFrameTimeSec(k)
    ok(Math.abs(bpTimeToFrame(t) - k) <= 1, `bpTimeToFrame(bpFrameTimeSec(${k})) ≈ ${k}(实得 ${bpTimeToFrame(t)})`)
    ok(Math.abs(bpFrameSpanSec(5160) - 59.598) < 0.01, `5160 帧(名义 60s)真实覆盖 59.598s(实得 ${bpFrameSpanSec(5160).toFixed(3)}s)`)
    ok(Math.abs(BP_FPS_TRUE - 86.582) < 0.01, `有效帧率 ≈86.582(实得 ${BP_FPS_TRUE.toFixed(3)})`)
  }

  // 2. 150s 分块拼接:全局帧的编码时间必须与 bpFrameTimeSec(全局 k) 一致
  {
    const pcm = new Float32Array(150 * SR)
    for (let i = 0; i < pcm.length; i++) pcm[i] = i / SR // PCM 值 = 绝对时间(秒)
    const { frames } = await evaluateChunked(makeFakeBp() as never, pcm, () => {})
    console.log(`   150s → ${frames.length} 帧`)
    ok(frames.length > 120 * 80, `帧数足够(实得 ${frames.length})`)
    let worst = 0
    let worstAt = 0
    for (let k = 0; k < frames.length; k++) {
      const encoded = frames[k][0] // 该帧生成时"以为"的时间(块内)
      const globalT = bpFrameTimeSec(k)
      const d = Math.abs(encoded - globalT)
      if (d > worst) {
        worst = d
        worstAt = k
      }
    }
    // ±2 帧容差(≈23ms);旧实现第 2 块起偏 ≥0.39s
    ok(worst < 2 / BP_FPS_TRUE, `全曲帧时间对齐:最大偏差 ${((worst * 1000) | 0)}ms(帧 ${worstAt},容差 ${((2 / BP_FPS_TRUE) * 1000).toFixed(0)}ms)`)
    // 显式验证三个块边界附近
    for (const [label, k] of [['块1末', 5159], ['块2首', 5160], ['块3中', 11000]] as Array<[string, number]>) {
      const d = Math.abs(frames[k][0] - bpFrameTimeSec(k))
      ok(d < 2 / BP_FPS_TRUE, `${label}(帧 ${k})对齐,偏差 ${((d * 1000) | 0)}ms`)
    }
  }

  console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
