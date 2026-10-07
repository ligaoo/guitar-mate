// 参数规划:把「素材特征 + 质量反馈」翻译成「识别参数」
//
// 这是本方案的核心主张:参数不该是固定默认值,而应该随素材变化 —— 尤其是**随 BPM 变化**,
// 因为"最短音长"这类阈值本质上是**时间量**,用固定帧数表达必然在快歌上出错。
// 每条规则的依据都来自 ACCURACY.md 的实测(注释里标注)。
import type { QualityAction } from './quality'

export interface AutoParams {
  onsetThresh: number
  frameThresh: number
  /** 最短音长(帧,86fps)——由 BPM 推导,见 baseParams */
  minNoteLenFrames: number
  melodiaTrick: boolean
  /** 召回优先聚合提取(失真路由启用):帧+onset 联合替代单帧双阈值,
   *  实测《God knows》并集 F1 15.4% → 20.6%(PLAN-90 阶段 2) */
  recallExtract: boolean
  /** 响度/置信度下限 */
  minConf: number
  /** 同一格最多保留几个音(吉他 6 弦为上限) */
  maxPolyphony: number
  keyFilter: boolean
}

export interface SegmentPlan {
  index: number
  /** 段起点/终点(秒,绝对时间) */
  t0: number
  t1: number
}

export interface AutoContext {
  bpm: number
  /** 该素材是否复音(DSP 复音标记或实测同起音最大音数) */
  polyphonic: boolean
  /** 全局置信度中位数 */
  confMedian: number
  /** 全局音符密度(个/秒) */
  density: number
  /** 失真/音色指数(0=暗而干净,1=亮/失真墙;见 distortionIndex) */
  distortion: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 失真/音色指数(0=干净,1=高失真/强压缩混音),两个物理指纹取 max:
 *
 * ① 波峰因子(归一化后 1/RMS):削波/限幅会把峰值压平 → crest 显著下降。
 *    实测(22050Hz 单声道,响亮帧口径):干净 GuitarSet 12 片段 7.9~20.6;
 *    高失真整曲《God knows》3.1~4.1。映射:crest 8→0 分,3→1 分。
 * ② 高频占优帧占比(一阶差分能量比 >0.15 ≈ 能量重心 >1.2kHz):失真谐波墙推高占比。
 *    实测:干净 0.008~0.406;失真 0.567~0.747。映射:0.35→0 分,0.65→1 分。
 * 路由阈值 0.5:干净素材实测 ≤0.19,失真实测 ≥0.77,间隔充足。
 * 标定数据与依据见 AUTO.md §2(2026-10-07)。
 */
export function distortionIndex(pcm: Float32Array): number {
  const F = 1102 // 50ms @ 22050
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]))
  if (peak < 1e-6) return 0
  let rmsSum = 0
  let loud = 0
  let hf = 0
  for (let i = 0; i + F <= pcm.length; i += F) {
    let e = 0
    let eh = 0
    for (let j = 1; j < F; j++) {
      const v = pcm[i + j] / peak
      e += v * v
      const d = v - pcm[i + j - 1] / peak
      eh += d * d
    }
    if (e / F > 1e-4) {
      rmsSum += Math.sqrt(e / F)
      loud++
      if (eh / e > 0.15) hf++
    }
  }
  if (loud < 10) return 0
  const crest = 1 / (rmsSum / loud)
  const frac15 = hf / loud
  const crestScore = clamp((8 - crest) / 5, 0, 1)
  const hfScore = clamp((frac15 - 0.35) / 0.3, 0, 1)
  return Math.max(crestScore, hfScore)
}

/** 失真路由阈值:高于此值按「失真/混音」参数组处理。标定依据见上方注释与 AUTO.md §2。 */
export const DISTORTION_ROUTE = 0.5

/**
 * 基础参数:由 BPM 与素材特征推导。
 *
 * 关键推导(依据见 ACCURACY.md §2.1/§5.1):
 *   · 16 分音符时长 = 60/BPM/4 秒;最短音长必须**小于**它,否则快速经过音整批消失。
 *     旧的固定值 12 帧(151ms)在 >100 BPM 时就开始吃 16 分音符 —— 实测把 24% 的标注音挡在门外。
 *     这里取 16 分音符的 60%,再夹在 [4,12] 帧内。
 *   · 阈值:实测两个数据集一致的最优区是 onsetThresh≈0.5 / frameThresh≈0.3。
 *     密度很高(伪音多)时再抬一档。
 *   · melodia 残差补音:实测单声部素材上关掉更好(精确率 +2.2),复音素材上开着更好(补同时发声)。
 *   · 响度下限:按置信度分布取 20 分位,避免"固定阈值"在低置信素材上把整段删空。
 */
export function baseParams(ctx: AutoContext): AutoParams {
  const sixteenth = 60 / Math.max(30, ctx.bpm) / 4
  // 最短音长倍率随素材:独奏 ×0.6;复音(和弦伴奏)×0.3 —— 快和弦敲击需要更短的下限
  // (v2 寻优 + holdout 确认:comp ×0.3 比 ×0.6 高 2.1pt;×0.6 仍是 solo 最优)
  const mnlMult = ctx.polyphonic ? 0.3 : 0.6
  const minNoteLenFrames = clamp(Math.round(sixteenth * 86 * mnlMult), 3, 12)
  // 失真/混音路由(音色自适应)——**召回优先**(PLAN-90 阶段2,2026-10-07 按实测翻转方向):
  // 失真混音的瓶颈是召回(模型墙),保守阈值只会把少数真音连同幻觉一起删掉。
  // 实测(时基修复后,《God knows》并集口径):保守 ot0.55/ft0.40 = 5.9% →
  // ot0.35/ft0.30 = 14.8% → 召回聚合提取(阶段 2 实装,recallExtract)= 20.6%/4072 音。
  // 闭环仍可按段收紧;产物定位"草稿中的草稿"(报告带失真警示,见 conductor 外推门控)。
  const distorted = ctx.distortion >= DISTORTION_ROUTE
  // 干净档(2026-10-07 v2 扩界寻优 + holdout,60 片段,eval/param-sweep-v2.json):
  //   ft 0.40 → **0.60**:两档最大单项收益,holdout 确认(solo 85.0→85.7 / comp 65.8→71.1);
  //   真实吉他帧激活远高于幻觉,抬帧阈值主要删伪音。0.60 仍在网格边界(0.3→0.6 单调升)。
  //   ot:复音 0.50 最优;独奏平台区(0.5/0.55/0.6 差 <0.3pt)取 0.55。
  //   melodia 第 3 次确认无益,保持关。
  return {
    onsetThresh: distorted ? 0.35 : ctx.polyphonic ? 0.5 : 0.55,
    frameThresh: distorted ? 0.3 : 0.6,
    minNoteLenFrames,
    melodiaTrick: false,
    recallExtract: distorted,
    minConf: clamp(ctx.confMedian * 0.5, 0.15, 0.4),
    maxPolyphony: 6,
    keyFilter: false,
  }
}

/** 把质量评估给出的动作作用到参数上(闭环的"改参数"这一步) */
export function applyActions(p: AutoParams, actions: QualityAction[]): AutoParams {
  const next: AutoParams = { ...p }
  for (const a of actions) {
    switch (a) {
      case 'raise-onset-thresh':
        next.onsetThresh = clamp(next.onsetThresh + 0.05, 0.3, 0.75)
        break
      case 'raise-frame-thresh':
        next.frameThresh = clamp(next.frameThresh + 0.05, 0.2, 0.5)
        break
      case 'lower-min-note-len':
        next.minNoteLenFrames = clamp(next.minNoteLenFrames - 2, 4, 16)
        break
      case 'toggle-melodia-off':
        next.melodiaTrick = false
        break
      case 'toggle-melodia-on':
        next.melodiaTrick = true
        break
      case 'raise-min-conf':
        next.minConf = clamp(next.minConf + 0.05, 0.1, 0.6)
        break
      case 'lower-min-conf':
        next.minConf = clamp(next.minConf - 0.05, 0.1, 0.6)
        break
      case 'enable-key-filter':
        next.keyFilter = true
        break
      case 'lower-polyphony-cap':
        next.maxPolyphony = clamp(next.maxPolyphony - 2, 4, 6)
        break
      case 'retry-bpm':
      case 'mark-review':
        break // 由调度器处理(重估 BPM / 记入待复核)
    }
  }
  return next
}

/**
 * 自动分段:**按小节切**,而不是按固定秒数。
 * 8 小节一般 10~30 秒:既短到"局部质量可代表",又长到有足够上下文(模型感受野 2 秒)。
 * 按小节切还有个好处:边界落在拍点上,不会把和弦切两半。
 */
export function planSegments(duration: number, bpm: number, barsPerSegment = 8): SegmentPlan[] {
  const barSec = (60 / Math.max(30, bpm)) * 4
  let segSec = clamp(barSec * barsPerSegment, 10, 30)
  // 段落数上限,避免极短片段产生几十段
  const maxSegments = 40
  if (duration / segSec > maxSegments) segSec = duration / maxSegments
  const out: SegmentPlan[] = []
  for (let t = 0, i = 0; t < duration - 1; t += segSec, i++) {
    out.push({ index: i, t0: t, t1: Math.min(duration, t + segSec) })
  }
  return out
}

/** 参数指纹(用于报告里去重展示) */
export function paramsKey(p: AutoParams): string {
  return [
    `ot${p.onsetThresh.toFixed(2)}`,
    `ft${p.frameThresh.toFixed(2)}`,
    `mnl${p.minNoteLenFrames}`,
    `mel${p.melodiaTrick ? 'on' : 'off'}`,
    p.recallExtract ? 'recall' : '',
    `conf${p.minConf.toFixed(2)}`,
    `poly${p.maxPolyphony}`,
    p.keyFilter ? 'key' : '',
  ]
    .filter(Boolean)
    .join(' ')
}
