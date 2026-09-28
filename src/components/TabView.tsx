// 六线谱 SVG 渲染:按系统(每行 48 格 = 1 小节 4/4)绘制,支持点击选择/插入与播放指针
// 网格为「每拍 12 细分」:直 16 分=3 格、三连 8 分=4 格、三连 16 分=2 格,同一整数网格表达直音与三连音
import type { TabNote } from '../transcription/fingering'
import { mod12, NOTE_NAMES_SHARP } from '../theory/notes'

interface Props {
  notes: TabNote[]
  tuning: number[]
  stepsPerSystem?: number // 默认 48(一小节)
  totalSteps?: number
  selectedId?: number | null
  playheadStep?: number | null
  onSelect?: (id: number | null) => void
  onSlotClick?: (step: number, string: number) => void
}

const COL = 16
const PAD_L = 40
const PAD_R = 14
const STRING_GAP = 15
const TOP = 26
const STEM_LEN = 26

export default function TabView({
  notes,
  tuning,
  stepsPerSystem = 48,
  totalSteps,
  selectedId = null,
  playheadStep = null,
  onSelect,
  onSlotClick,
}: Props) {
  const nStrings = tuning.length
  const maxStep = Math.max(
    totalSteps ?? 0,
    ...notes.map((n) => n.step + n.dur),
    0,
  )
  const systems = Math.max(1, Math.ceil((maxStep || stepsPerSystem) / stepsPerSystem))
  const W = PAD_L + stepsPerSystem * COL + PAD_R
  const H = TOP + (nStrings - 1) * STRING_GAP + 44
  const staffH = (nStrings - 1) * STRING_GAP
  const sy = (s: number) => TOP + (nStrings - 1 - s) * STRING_GAP // s:0=6弦(底部)…5=1弦(顶部)
  const sx = (sys: number, step: number) => PAD_L + (step - sys * stepsPerSystem) * COL + COL / 2

  const durFlags = (dur: number) => (dur <= 1 ? 2 : dur <= 2 ? 1 : dur <= 3 ? 2 : dur <= 6 ? 1 : 0)

  return (
    <div className="tabview">
      {Array.from({ length: systems }, (_, sys) => {
        const sysNotes = notes.filter((n) => n.step >= sys * stepsPerSystem && n.step < (sys + 1) * stepsPerSystem)
        // 按 step 分组以便画统一符干
        const byStep = new Map<number, TabNote[]>()
        for (const n of sysNotes) {
          const g = byStep.get(n.step) ?? []
          g.push(n)
          byStep.set(n.step, g)
        }
        const phInSystem =
          playheadStep !== null && playheadStep >= sys * stepsPerSystem && playheadStep < (sys + 1) * stepsPerSystem
        return (
          <div key={sys} className="tab-system">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', minWidth: 780 }}>
              {/* 弦 */}
              {Array.from({ length: nStrings }, (_, i) => (
                <line key={i} x1={PAD_L - 6} y1={sy(i)} x2={W - 8} y2={sy(i)} stroke="#4a5468" strokeWidth={0.6 + (nStrings - 1 - i) * 0.12} />
              ))}
              {/* 弦名 */}
              {Array.from({ length: nStrings }, (_, i) => (
                <text key={`l${i}`} x={2} y={sy(i) + 3.4} fill="#667086" fontSize="10">
                  {NOTE_NAMES_SHARP[mod12(tuning[i])]}
                </text>
              ))}
              {/* 小节线 */}
              <line x1={PAD_L - 6} y1={TOP - 4} x2={PAD_L - 6} y2={TOP + staffH + 4} stroke="#8b93a7" strokeWidth="2" />
              <line x1={W - 8} y1={TOP - 4} x2={W - 8} y2={TOP + staffH + 4} stroke="#8b93a7" strokeWidth="2" />
              {/* 拍刻度(每 12 格 = 1 拍) */}
              {Array.from({ length: Math.floor(stepsPerSystem / 12) - 1 }, (_, i) => {
                const x = PAD_L + (i + 1) * 12 * COL
                return <line key={`b${i}`} x1={x} y1={TOP + staffH + 6} x2={x} y2={TOP + staffH + 11} stroke="#3a4356" strokeWidth="1.4" />
              })}
              {/* 播放指针 */}
              {phInSystem && playheadStep !== null && (
                <rect x={sx(sys, playheadStep) - COL / 2 + 1} y={TOP - 8} width={COL - 2} height={staffH + 18} fill="#4cc2a9" opacity="0.13" rx="3" />
              )}
              {/* 插入热区(先画,位于音符下方,避免挡住音符点击) */}
              {onSlotClick &&
                Array.from({ length: stepsPerSystem }, (_, rel) => {
                  const step = sys * stepsPerSystem + rel
                  return Array.from({ length: nStrings }, (_, s) => {
                    const x = sx(sys, step)
                    const y = sy(s)
                    return (
                      <rect
                        key={`h${step}-${s}`}
                        x={x - COL / 2 + 1}
                        y={y - STRING_GAP / 2 + 1}
                        width={COL - 2}
                        height={STRING_GAP - 2}
                        fill="transparent"
                        style={{ cursor: 'copy' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSlotClick(step, s)
                        }}
                      />
                    )
                  })
                })}
              {/* 音符 */}
              {[...byStep.entries()].map(([step, group]) => {
                const sorted = [...group].sort((a, b) => b.string - a.string) // 大 string 号在上(高音弦)
                const x = sx(sys, step)
                const stemUp = sorted[sorted.length - 1].string >= 3 // 含低弦 → 符干向上
                const anchor = stemUp ? sorted[sorted.length - 1] : sorted[0]
                const yA = sy(anchor.string)
                const stemY1 = stemUp ? yA - 3 : yA + 3
                const stemY2 = stemUp ? yA - STEM_LEN : yA + STEM_LEN
                const flags = durFlags(Math.max(...group.map((g) => g.dur)))
                return (
                  <g key={step}>
                    <line x1={x + 5} y1={stemY1} x2={x + 5} y2={stemY2} stroke="#8b93a7" strokeWidth="1.3" style={{ pointerEvents: 'none' }} />
                    {Array.from({ length: flags }, (_, fi) => (
                      <path
                        key={fi}
                        style={{ pointerEvents: 'none' }}
                        d={
                          stemUp
                            ? `M ${x + 5} ${stemY2 + fi * 6} q 7 2 8 8 q -2 -4 -8 -4 z`
                            : `M ${x + 5} ${stemY2 - fi * 6} q 7 -2 8 -8 q -2 4 -8 4 z`
                        }
                        fill="#8b93a7"
                      />
                    ))}
                    {sorted.map((n) => {
                      const y = sy(n.string)
                      const isSel = n.id === selectedId
                      return (
                        <g
                          key={n.id}
                          style={{ cursor: onSelect ? 'pointer' : 'default' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelect?.(n.id)
                          }}
                        >
                          <rect x={x - 13} y={y - 10} width="26" height="20" fill="transparent" />
                          <circle cx={x} cy={y} r="9.5" fill={isSel ? '#f0b45c' : '#10141b'} stroke={isSel ? '#f0b45c' : '#4cc2a9'} strokeWidth="1.6" />
                          <text x={x} y={y + 4} textAnchor="middle" fill={isSel ? '#10141b' : '#4cc2a9'} fontSize="11" fontWeight="800">
                            {n.fret < 0 ? '?' : n.fret}
                          </text>
                        </g>
                      )
                    })}
                  </g>
                )
              })}
            </svg>
            <div className="tab-sys-label">第 {sys + 1} 小节</div>
          </div>
        )
      })}
    </div>
  )
}
