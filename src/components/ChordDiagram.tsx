// 和弦指法图 SVG 渲染
import type { Voicing } from '../theory/chords'
import { mod12, NOTE_NAMES_SHARP } from '../theory/notes'

interface Props {
  voicing: Voicing
  tuning: number[]
  size?: number
  showNotes?: boolean
}

export default function ChordDiagram({ voicing, tuning, size = 1, showNotes = false }: Props) {
  const W = 116
  const H = 148
  const left = 16
  const top = 34
  const stringGap = (W - 2 * left - 4) / 5
  const fretGap = 24
  const frets = voicing.frets
  const nStrings = frets.length
  const base = voicing.baseFret
  const sx = (i: number) => left + i * stringGap
  const fy = (f: number) => top + (f - 0.5) * fretGap // f: 显示行号 1-5

  const dispFret = (f: number) => f - base + 1

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W * size} height={H * size} style={{ display: 'block' }}>
      {/* 品丝 */}
      {Array.from({ length: 5 }, (_, i) => (
        <line key={`f${i}`} x1={left} y1={top + i * fretGap} x2={left + (nStrings - 1) * stringGap} y2={top + i * fretGap} stroke="#3a4356" strokeWidth="1.4" />
      ))}
      {/* 弦 */}
      {Array.from({ length: nStrings }, (_, i) => (
        <line key={`s${i}`} x1={sx(i)} y1={top} x2={sx(i)} y2={top + 4 * fretGap} stroke="#4a5468" strokeWidth={0.7 + (nStrings - 1 - i) * 0.18} />
      ))}
      {/* 上弦枕 */}
      {base === 1 ? (
        <rect x={left - 2} y={top - 4} width={(nStrings - 1) * stringGap + 4} height="4.5" rx="1.5" fill="#8b93a7" />
      ) : (
        <>
          <line x1={left} y1={top} x2={left + (nStrings - 1) * stringGap} y2={top} stroke="#3a4356" strokeWidth="1" />
          <text x={4} y={top + 14} fill="#f0b45c" fontSize="11" fontWeight="600">{base}</text>
        </>
      )}
      {/* 横按 */}
      {voicing.barre && (() => {
        const df = dispFret(voicing.barre.fret)
        if (df < 1 || df > 5) return null
        const x1 = sx(voicing.barre.from) - 6
        const x2 = sx(voicing.barre.to) + 6
        return <rect x={x1} y={fy(df) - 6} width={x2 - x1} height={12} rx="6" fill="#4cc2a9" opacity="0.45" />
      })()}
      {/* 闷音 / 空弦 */}
      {frets.map((f, i) =>
        f === -1 ? (
          <text key={`m${i}`} x={sx(i)} y={top - 12} textAnchor="middle" fill="#8b93a7" fontSize="12" fontWeight="700">×</text>
        ) : f === 0 ? (
          <circle key={`o${i}`} cx={sx(i)} cy={top - 14} r="4.5" fill="none" stroke="#8b93a7" strokeWidth="1.6" />
        ) : null,
      )}
      {/* 按弦点 */}
      {frets.map((f, i) => {
        if (f <= 0) return null
        const df = dispFret(f)
        if (df < 1 || df > 5) return null
        return (
          <g key={`d${i}`}>
            <circle cx={sx(i)} cy={fy(df)} r="8" fill="#4cc2a9" />
            <text x={sx(i)} y={fy(df) + 3.4} textAnchor="middle" fill="#0c1116" fontSize="9.5" fontWeight="800">
              {voicing.fingers[i] || ''}
            </text>
          </g>
        )
      })}
      {/* 弦名 / 实际音名 */}
      {frets.map((f, i) => {
        const label = showNotes && f > 0 ? NOTE_NAMES_SHARP[mod12(tuning[i] + f)] : NOTE_NAMES_SHARP[mod12(tuning[i])]
        return (
          <text key={`l${i}`} x={sx(i)} y={H - 4} textAnchor="middle" fill="#667086" fontSize="9">{label}</text>
        )
      })}
    </svg>
  )
}
