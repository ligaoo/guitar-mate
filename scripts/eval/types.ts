// 扒谱评估:标注数据模型
//
// 约定与 src/transcription/fingering.ts 保持一致:
//   tuning 索引 0 = 6 弦(最低音),midi = tuning[string] + fret
//
// 一个 EvalClip 描述一段"已知答案"的音频:渲染器按 tracks 合成音频,
// 度量模块拿 tracks 里的音符当 ground truth 去比对识别结果。

export interface EvalNote {
  start: number // 秒(绝对时间,含 leadIn)
  dur: number // 秒
  midi: number
  string?: number // 0-5(6 弦 → 1 弦);弦乐器才有
  fret?: number
  velocity?: number // 0-1,默认 0.8
}

export type Instrument = 'guitar' | 'bass' | 'vocal' | 'drums'

export interface EvalTrack {
  id: string
  instrument: Instrument
  /** 0-1:轨道在混音里的电平(渲染时把该轨峰值归一到此值) */
  gain: number
  /** -1 全左 … +1 全右 */
  pan: number
  notes: EvalNote[]
  /** 渲染期人性化抖动上限(秒):只改音频,标注保持理想位置 */
  humanize?: number
  /** 渲染期扫弦展开(秒/弦,低音弦先响):只改音频,标注保持理想位置 */
  strum?: number
}

export interface EvalClip {
  id: string
  desc: string
  bpm: number
  /** 低→高,与 TUNINGS[t].midi 同构 */
  tuning: number[]
  tracks: EvalTrack[]
  /** 开头静音(秒) */
  leadIn: number
  /** 结尾留白(秒) */
  tail: number
  /** 全曲音分偏移(模拟变速翻录 / 整体调音偏高)。标注音高不变,只有音频变化 */
  detuneCents: number
  /** 参考音高,默认 440 */
  a4: number
  /** 真实录音(优先于合成渲染):GuitarSet 等带标注数据集的音频文件。
   *  存在时跳过渲染,直接解码该文件;truth 仍取 tracks 里的标注(需自行转换成 EvalNote)。 */
  audio?: {
    /** 相对仓库根的 WAV 路径(支持 16/24/32 位整数 PCM 与 32/64 位浮点) */
    path: string
    /** 声道选择(默认 0;立体声可取 0 或 'mix') */
    channel?: number | 'mix'
  }
}

/** 被评分的乐器:只有它会与 ground truth 比对(鼓没有音高,不算音符) */
export const SCORED_INSTRUMENT: Instrument = 'guitar'

/** 评估音频统一 22050Hz(与 DSP 管线、Basic Pitch 输入一致,免去重采样差异) */
export const EVAL_SR = 22050
