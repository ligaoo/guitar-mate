// 导入音频(整曲混音)时的默认识别设置 —— 网页端与回归测试共用同一份,
// 避免"评测口径的参数"和"用户实际拿到的默认值"再次分叉(PLAN-90 §7.2 第 1/3/5 条就是这样出的事)。
import { BP_PRESETS, type BpPresetId } from './basicPitch'
import { DISTORTION_ROUTE } from './auto/plan'

/** 预设附带的后处理开关:召回优先预设(失真档)必须同时关掉这两项。
 *  · 八度重影过滤:会删掉失真吉他和弦里的真实八度叠音(实测 −2.4pt)
 *  · 自动密度:长素材(>90s)只留响度前 3 音/秒,把召回优先的输出砍掉 80%
 *    (《God knows》3866 → 838 音,并集 F1 19.1% → 8.1%;翻唱版 20.1% → 7.6%) */
export function presetPostOptions(id: BpPresetId): { removeOctaveGhosts: boolean; autoDensity: boolean } {
  const recall = BP_PRESETS[id].recallExtract
  return { removeOctaveGhosts: !recall, autoDensity: !recall }
}

export interface ImportDefaults {
  engine: 'bp'
  presetId: BpPresetId
  /** DSP 分轨预处理 */
  separate: boolean
  autoDensity: boolean
  removeOctaveGhosts: boolean
  /** 指法阶段可用的最高品 */
  maxFret: number
  /** 响度下限 */
  minConf: number
}

/**
 * 按失真指数(导入时在原混音上测)给出默认设置。失真档与干净档不同的三项都来自
 * 《God knows》原曲 + 翻唱两版录音的实测(PLAN-90 §7,onset ±50ms + 音高全等,对两把吉他的并集):
 *  · 不分轨:DSP 分轨在失真混音上净亏(召回聚合 20.6% → 18.5%,且 BPM 被带偏 150 → 151)
 *  · 关自动密度:见 presetPostOptions
 *  · 最高品 22:15 品上限丢掉的高把位音里真音多于幻觉(19.1% → 19.7%,主音 14.9% → 16.4%)
 * 干净档保持原默认(分轨开、自动密度开、15 品)——这几项在干净素材上没有反证。
 */
export function importDefaults(distortion: number): ImportDefaults {
  const distorted = distortion >= DISTORTION_ROUTE
  const presetId: BpPresetId = distorted ? 'dist' : 'mix'
  return {
    engine: 'bp',
    presetId,
    separate: !distorted,
    ...presetPostOptions(presetId),
    maxFret: distorted ? 22 : 15,
    minConf: 0.25,
  }
}
