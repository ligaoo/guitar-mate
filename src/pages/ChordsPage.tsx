// 和弦图页:查询 + 试听 + 反查 + 变调夹 + 收藏
import { useEffect, useMemo, useState } from 'react'
import { CHORD_TYPES, chordName, generateVoicings, reverseLookup, type Voicing } from '../theory/chords'
import { TUNINGS, STANDARD_TUNING } from '../theory/tunings'
import { midiToFreq, mod12, NOTE_NAMES_SHARP } from '../theory/notes'
import ChordDiagram from '../components/ChordDiagram'
import { GuitarSynth } from '../audio/synth'
import { loadFavs, toggleFav } from '../stores/stats'

const ROOTS = Array.from({ length: 12 }, (_, i) => NOTE_NAMES_SHARP[i])

export default function ChordsPage() {
  const [tab, setTab] = useState<'lookup' | 'reverse'>('lookup')
  const [root, setRoot] = useState(0)
  const [typeId, setTypeId] = useState('maj')
  const [tuningId, setTuningId] = useState('standard')
  const [capo, setCapo] = useState(0)
  const [favs, setFavs] = useState<string[]>(() => loadFavs())
  const [onlyFav, setOnlyFav] = useState(false)

  // 反查状态
  const [revBase, setRevBase] = useState(1) // 反查键盘窗口起始品
  const [revFrets, setRevFrets] = useState<number[]>(() => [-1, 3, 2, 0, 1, 0]) // 默认 C 和弦

  const tuning = useMemo(
    () => TUNINGS.find((t) => t.id === tuningId)?.midi ?? STANDARD_TUNING,
    [tuningId],
  )
  const chordType = CHORD_TYPES.find((t) => t.id === typeId)!
  const voicings: Voicing[] = useMemo(
    () => generateVoicings(root, chordType.intervals, tuning, { maxFret: 12, limit: 12 }),
    [root, chordType, tuning],
  )
  const matches = useMemo(() => reverseLookup(revFrets, tuning), [revFrets, tuning])

  // 空闲时预热常用和弦的指法(生成约 5ms/个,分帧避免点击卡顿)
  useEffect(() => {
    const common: [number, string][] = [
      [0, 'maj'], [2, 'maj'], [4, 'maj'], [5, 'maj'], [7, 'maj'], [9, 'maj'], [11, 'maj'],
      [9, 'min'], [4, 'min'], [2, 'min'], [0, 'min'], [7, 'min'], [5, 'min'],
      [0, '7'], [7, '7'], [2, '7'], [9, '7'], [5, '7'],
      [0, 'maj7'], [2, 'maj7'], [4, 'maj7'], [9, 'm7'], [5, 'm7'], [2, 'm7'],
      [0, 'sus4'], [7, 'sus4'], [9, 'add9'], [4, 'add9'],
    ]
    let i = 0
    let cancelled = false
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback
    const step = () => {
      if (cancelled || i >= common.length) return
      const [pc, tid] = common[i++]
      const type = CHORD_TYPES.find((t) => t.id === tid)
      if (type) generateVoicings(pc, type.intervals, tuning, { maxFret: 12, limit: 16 })
      schedule()
    }
    const schedule = () => {
      if (ric) ric(step, { timeout: 300 })
      else setTimeout(step, 60)
    }
    schedule()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tuningId])

  const playVoicing = (v: Voicing) => {
    const freqs: number[] = []
    for (let i = 0; i < v.frets.length; i++) {
      const f = v.frets[i]
      if (f < 0) continue
      freqs.push(midiToFreq(tuning[i] + f + capo))
    }
    GuitarSynth.strum(freqs, undefined, 0.014, { gain: 0.4 })
  }

  const playRev = () => {
    const freqs: number[] = []
    for (let i = 0; i < 6; i++) {
      if (revFrets[i] < 0) continue
      // 反查窗口:品位 = 窗口起始 + 相对品(0 为空弦)
      const actual = revFrets[i] === 0 ? 0 : revBase + revFrets[i] - 1
      freqs.push(midiToFreq(tuning[i] + actual))
    }
    if (freqs.length) GuitarSynth.strum(freqs, undefined, 0.016, { gain: 0.4 })
  }

  const capoName = capo > 0 ? chordName(mod12(root + capo), chordType) : null

  return (
    <>
      <div className="row mb">
        <div className="chip-row">
          <button className={`chip${tab === 'lookup' ? ' active' : ''}`} onClick={() => setTab('lookup')}>和弦查询</button>
          <button className={`chip${tab === 'reverse' ? ' active' : ''}`} onClick={() => setTab('reverse')}>按指法反查和弦</button>
        </div>
        <div className="spacer" />
        <label className="field">调弦
          <select value={tuningId} onChange={(e) => setTuningId(e.target.value)}>
            {TUNINGS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {tab === 'lookup' && (
          <label className="field">变调夹
            <select value={capo} onChange={(e) => setCapo(parseInt(e.target.value))}>
              {Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i === 0 ? '不夹' : `第 ${i} 品`}</option>)}
            </select>
          </label>
        )}
      </div>

      {tab === 'lookup' && (
        <>
          <div className="card">
            <div className="chip-row" style={{ marginBottom: 10 }}>
              {ROOTS.map((r, i) => (
                <button key={r} className={`chip${root === i ? ' active' : ''}`} onClick={() => setRoot(i)}>{r}</button>
              ))}
            </div>
            {([
              ['basic', '常用'],
              ['color', '色彩'],
              ['jazz', '爵士'],
            ] as const).map(([g, label]) => (
              <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className="muted small" style={{ width: 30, flexShrink: 0 }}>{label}</span>
                <div className="chip-row">
                  {CHORD_TYPES.filter((t) => t.group === g).map((t) => (
                    <button key={t.id} className={`chip${typeId === t.id ? ' active' : ''}`} onClick={() => setTypeId(t.id)}>
                      {NOTE_NAMES_SHARP[root]}{t.suffix || 'maj'}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {capoName && (
            <div className="warn-box mb">
              夹变调夹第 {capo} 品时,这个指法实际发出的和弦是 <b>{capoName}</b>。
            </div>
          )}

          <div className="row mb">
            <div className="muted small">
              {NOTE_NAMES_SHARP[root]}{chordType.suffix} · {chordType.name} · 共 {voicings.length} 个指法,点击卡片试听
            </div>
            <div className="spacer" />
            <button className={`chip${onlyFav ? ' warn-active' : ''}`} onClick={() => setOnlyFav(!onlyFav)}>
              {onlyFav ? '★ 只看收藏' : '☆ 只看收藏'}
            </button>
          </div>

          <div className="chord-grid">
            {voicings.map((v, i) => {
              const sig = `${NOTE_NAMES_SHARP[root]}${chordType.suffix}|${tuningId}|${v.frets.join(',')}`
              if (onlyFav && !favs.includes(sig)) return null
              return (
                <div key={i} className="chord-card" onClick={() => playVoicing(v)}>
                  <button
                    className="fav"
                    onClick={(e) => { e.stopPropagation(); setFavs(toggleFav(sig)) }}
                    title="收藏"
                  >
                    {favs.includes(sig) ? '★' : '☆'}
                  </button>
                  <div className="name">{i === 0 ? `${NOTE_NAMES_SHARP[root]}${chordType.suffix}` : ''}</div>
                  <div className="tname">{i === 0 ? chordType.name : `指法 ${i + 1}`}</div>
                  <ChordDiagram voicing={v} tuning={tuning} size={0.92} showNotes={capo > 0} />
                </div>
              )
            })}
          </div>
        </>
      )}

      {tab === 'reverse' && (
        <div className="card">
          <div className="muted small mb">在下方点出你按的指法(每根弦选择:× 闷音 / ○ 空弦 / 品位),自动推测和弦名。</div>
          <div className="row mb">
            <button className="btn sm" onClick={() => setRevBase(Math.max(1, revBase - 1))}>◀ 窗口左移</button>
            <span className="chip">窗口:{revBase === 1 ? '空把位' : `第 ${revBase} 品起`}</span>
            <button className="btn sm" onClick={() => setRevBase(Math.min(9, revBase + 1))}>窗口右移 ▶</button>
            <button className="btn sm primary" onClick={playRev}>▶ 试听指法</button>
            <button className="btn sm ghost" onClick={() => setRevFrets([-1, -1, -1, -1, -1, -1])}>清空</button>
          </div>
          {[5, 4, 3, 2, 1, 0].map((s) => (
            <div key={s} className="fret-input-row">
              <div className="slabel">{NOTE_NAMES_SHARP[mod12(tuning[s])]}</div>
              <button
                className={`fret-btn${revFrets[s] === -1 ? ' active-x' : ''}`}
                onClick={() => setRevFrets(revFrets.map((f, i) => (i === s ? -1 : f)))}
              >×</button>
              <button
                className={`fret-btn${revFrets[s] === 0 ? ' active-o' : ''}`}
                onClick={() => setRevFrets(revFrets.map((f, i) => (i === s ? 0 : f)))}
              >○</button>
              {[1, 2, 3, 4].map((f) => (
                <button
                  key={f}
                  className={`fret-btn${revFrets[s] === f ? ' active-f' : ''}`}
                  onClick={() => setRevFrets(revFrets.map((x, i) => (i === s ? f : x)))}
                >{revBase === 1 ? f : revBase + f - 1}</button>
              ))}
            </div>
          ))}
          <div className="match-list">
            {matches.length === 0 && <span className="muted small mt">没有匹配的常用和弦(可尝试调整品位或窗口)。</span>}
            {matches.map((m, i) => (
              <div key={i} className={`match-pill${m.exact ? ' exact' : ' partial'}`}>
                {chordName(m.rootPc, m.type)}
                <small> {m.exact ? '' : '近似'}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
