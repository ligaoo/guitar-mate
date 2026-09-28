// 和弦图页:查询 + 试听 + 反查 + 变调夹 + 收藏 + 随机考试
import { useEffect, useMemo, useState } from 'react'
import { CHORD_TYPES, chordName, generateVoicings, reverseLookup, type ChordType, type Voicing } from '../theory/chords'
import { TUNINGS, STANDARD_TUNING } from '../theory/tunings'
import { midiToFreq, mod12, NOTE_NAMES_SHARP } from '../theory/notes'
import ChordDiagram from '../components/ChordDiagram'
import { GuitarSynth } from '../audio/synth'
import { loadFavs, toggleFav } from '../stores/stats'

const ROOTS = Array.from({ length: 12 }, (_, i) => NOTE_NAMES_SHARP[i])

// ---- 随机和弦考试 ----

interface QuizChoice {
  rootPc: number
  type: ChordType
}

interface QuizQ {
  rootPc: number
  type: ChordType
  voicing: Voicing
  tuningUsed: number[] // 出题时实际使用的调弦(个别调弦下无指法会回退标准调弦)
  choices: QuizChoice[]
  answer: number
}

interface QuizStats {
  best: number // 历史最佳连对
  total: number
  right: number
}

const QUIZ_KEY = 'gm-chord-quiz'
const NATURAL_ROOTS = [0, 2, 4, 5, 7, 9, 11] // C D E F G A B

function loadQuizStats(): QuizStats {
  try {
    return { best: 0, total: 0, right: 0, ...JSON.parse(localStorage.getItem(QUIZ_KEY) ?? '{}') }
  } catch {
    return { best: 0, total: 0, right: 0 }
  }
}

const rnd = (n: number) => Math.floor(Math.random() * n)
const pickOne = <T,>(arr: T[]): T => arr[rnd(arr.length)]

/** 4 个选项:正确答案 + 同根音换性质 + 换根音同性质 + 双变化(构造上互不相同),洗牌后返回 */
function buildChoices(rootPc: number, type: ChordType, rootPool: number[]): QuizChoice[] {
  const correct: QuizChoice = { rootPc, type }
  const otherTypes = CHORD_TYPES.filter((t) => t.id !== type.id)
  const otherRoots = rootPool.filter((r) => r !== rootPc)
  const rootSrc = otherRoots.length ? otherRoots : [0]
  const choices: QuizChoice[] = [
    correct,
    { rootPc, type: pickOne(otherTypes) },
    { rootPc: pickOne(rootSrc), type },
    { rootPc: pickOne(rootSrc), type: pickOne(otherTypes) },
  ]
  for (let i = choices.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    ;[choices[i], choices[j]] = [choices[j], choices[i]]
  }
  return choices
}

export default function ChordsPage({ active = true }: { active?: boolean }) {
  const [tab, setTab] = useState<'lookup' | 'reverse' | 'quiz'>('lookup')
  const [root, setRoot] = useState(0)
  const [typeId, setTypeId] = useState('maj')
  const [tuningId, setTuningId] = useState('standard')
  const [capo, setCapo] = useState(0)
  const [favs, setFavs] = useState<string[]>(() => loadFavs())
  const [onlyFav, setOnlyFav] = useState(false)

  // 反查状态
  const [revBase, setRevBase] = useState(1) // 反查键盘窗口起始品
  const [revFrets, setRevFrets] = useState<number[]>(() => [-1, 3, 2, 0, 1, 0]) // 默认 C 和弦

  // 考试状态
  const [qMode, setQMode] = useState<'listen' | 'look'>('listen')
  const [qRoots, setQRoots] = useState<'natural' | 'all'>('natural')
  const [qTypes, setQTypes] = useState<string[]>(['maj', 'min', '7', 'maj7', 'm7'])
  const [quiz, setQuiz] = useState<QuizQ | null>(null)
  const [quizAnswered, setQuizAnswered] = useState(false)
  const [quizChosen, setQuizChosen] = useState(-1)
  const [quizStreak, setQuizStreak] = useState(0)
  const [quizSession, setQuizSession] = useState({ asked: 0, right: 0 })
  const [quizStats, setQuizStats] = useState<QuizStats>(() => loadQuizStats())

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

  // ---- 考试 ----

  // 考试不带变调夹(答案按无 capo 计算),用出题时实际使用的调弦
  const playQuizVoicing = (v: Voicing, tuningUsed: number[]) => {
    const freqs: number[] = []
    for (let i = 0; i < v.frets.length; i++) {
      const f = v.frets[i]
      if (f < 0) continue
      freqs.push(midiToFreq(tuningUsed[i] + f))
    }
    if (freqs.length) GuitarSynth.strum(freqs, undefined, 0.016, { gain: 0.38 })
  }

  const nextQuiz = () => {
    const rootPool = qRoots === 'all' ? ROOTS.map((_, i) => i) : NATURAL_ROOTS
    const typePool = qTypes.length ? qTypes : ['maj']
    let rootPc = 0
    let type = CHORD_TYPES[0]
    let tuningUsed = tuning
    let vs: Voicing[] = []
    // 个别调弦下某些和弦可能枚举不出指法,重试几次后回退标准调弦
    for (let attempt = 0; attempt < 16 && vs.length === 0; attempt++) {
      rootPc = pickOne(rootPool)
      const typeId = pickOne(typePool)
      type = CHORD_TYPES.find((t) => t.id === typeId)!
      tuningUsed = attempt < 12 ? tuning : STANDARD_TUNING
      vs = generateVoicings(rootPc, type.intervals, tuningUsed, { maxFret: 12, limit: 8 })
    }
    if (vs.length === 0) return
    // 从评分最高的几个里随机取,听音取前 3(更接近常见把位),看图取前 5(形状更多样)
    const voicing = vs[rnd(Math.min(qMode === 'look' ? 5 : 3, vs.length))]
    const choices = buildChoices(rootPc, type, rootPool)
    setQuiz({
      rootPc,
      type,
      voicing,
      tuningUsed,
      choices,
      answer: choices.findIndex((c) => c.rootPc === rootPc && c.type.id === type.id),
    })
    setQuizAnswered(false)
    setQuizChosen(-1)
  }

  const answerQuiz = (i: number) => {
    if (!quiz || quizAnswered) return
    setQuizChosen(i)
    setQuizAnswered(true)
    const ok = i === quiz.answer
    const streak = ok ? quizStreak + 1 : 0
    setQuizStreak(streak)
    setQuizSession((s) => ({ asked: s.asked + 1, right: s.right + (ok ? 1 : 0) }))
    const s2: QuizStats = {
      best: Math.max(quizStats.best, streak),
      total: quizStats.total + 1,
      right: quizStats.right + (ok ? 1 : 0),
    }
    try {
      localStorage.setItem(QUIZ_KEY, JSON.stringify(s2))
    } catch {
      /* ignore */
    }
    setQuizStats(s2)
  }

  // 进入考试页或调整出题设置时出新题
  useEffect(() => {
    if (tab === 'quiz') nextQuiz()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, qMode, qTypes.join(','), qRoots])

  // 键盘:1-4 作答 / 空格重播(听音)/ Enter 下一题(页面隐藏时不抢按键)
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (tab !== 'quiz' || !quiz) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (quizAnswered && e.key === 'Enter') {
        nextQuiz()
        return
      }
      const n = parseInt(e.key, 10)
      if (!quizAnswered && !isNaN(n) && n >= 1 && n <= quiz.choices.length) {
        answerQuiz(n - 1)
        return
      }
      if (e.key === ' ' && !quizAnswered) {
        e.preventDefault()
        if (qMode === 'listen') playQuizVoicing(quiz.voicing, quiz.tuningUsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const capoName = capo > 0 ? chordName(mod12(root + capo), chordType) : null

  return (
    <>
      <div className="row mb">
        <div className="chip-row">
          <button className={`chip${tab === 'lookup' ? ' active' : ''}`} onClick={() => setTab('lookup')}>和弦查询</button>
          <button className={`chip${tab === 'reverse' ? ' active' : ''}`} onClick={() => setTab('reverse')}>按指法反查和弦</button>
          <button className={`chip${tab === 'quiz' ? ' active' : ''}`} onClick={() => setTab('quiz')}>随机考试</button>
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

      {tab === 'quiz' && (
        <>
          <div className="card">
            <div className="chip-row" style={{ marginBottom: 10 }}>
              <button className={`chip${qMode === 'listen' ? ' active' : ''}`} onClick={() => setQMode('listen')}>🎧 听音辨和弦</button>
              <button className={`chip${qMode === 'look' ? ' active' : ''}`} onClick={() => setQMode('look')}>👁 看图辨和弦</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="muted small" style={{ width: 44, flexShrink: 0 }}>根音池</span>
              <div className="chip-row">
                <button className={`chip${qRoots === 'natural' ? ' active' : ''}`} onClick={() => setQRoots('natural')}>自然音级(C D E F G A B)</button>
                <button className={`chip${qRoots === 'all' ? ' active' : ''}`} onClick={() => setQRoots('all')}>全部 12 个(含升降)</button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="muted small" style={{ width: 44, flexShrink: 0 }}>和弦池</span>
              <div className="chip-row">
                {CHORD_TYPES.map((t) => (
                  <button
                    key={t.id}
                    className={`chip${qTypes.includes(t.id) ? ' active' : ''}`}
                    title={t.name}
                    onClick={() =>
                      setQTypes((s) =>
                        s.includes(t.id) ? (s.length > 1 ? s.filter((x) => x !== t.id) : s) : [...s, t.id],
                      )
                    }
                  >
                    C{t.suffix}
                  </button>
                ))}
              </div>
            </div>
            <div className="muted small">
              {qMode === 'listen'
                ? '随机出一个和弦的扫弦,不看图,凭耳朵选出和弦名(含根音)'
                : '随机出一个指法图,选它是哪个和弦(用当前调弦)'}
            </div>
          </div>

          <div className="card question-box">
            {quiz && (
              <>
                <div className="prompt">
                  第 {quizSession.asked + (quizAnswered ? 0 : 1)} 题 · {qMode === 'listen' ? '这是哪个和弦?' : '这个指法是哪个和弦?'}
                </div>

                {qMode === 'listen' && !quizAnswered && (
                  <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
                    <button className="btn primary big" onClick={() => playQuizVoicing(quiz.voicing, quiz.tuningUsed)}>▶ 播放</button>
                  </div>
                )}
                {qMode === 'look' && !quizAnswered && (
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
                    <ChordDiagram voicing={quiz.voicing} tuning={quiz.tuningUsed} size={1.15} />
                  </div>
                )}

                <div className="choices">
                  {quiz.choices.map((c, i) => {
                    let cls = 'choice'
                    if (quizAnswered) {
                      if (i === quiz.answer) cls += ' right'
                      else if (i === quizChosen) cls += ' wrong'
                      else cls += ' dimmed'
                    }
                    return (
                      <button key={i} className={cls} disabled={quizAnswered} onClick={() => answerQuiz(i)}>
                        {chordName(c.rootPc, c.type)}
                      </button>
                    )
                  })}
                </div>

                {!quizAnswered && (
                  <div className="muted small mt">快捷键:1-4 作答{qMode === 'listen' ? ' · 空格重播' : ''}</div>
                )}

                {quizAnswered && (
                  <div className="review-box">
                    <div className={`feedback ${quizChosen === quiz.answer ? 'ok' : 'no'}`}>
                      {quizChosen === quiz.answer
                        ? `✓ 正确!连对 ${quizStreak} 个`
                        : `✗ 这是 ${chordName(quiz.rootPc, quiz.type)}(${quiz.type.name})`}
                    </div>
                    <div className="row" style={{ justifyContent: 'center', alignItems: 'center', marginTop: 10 }}>
                      <ChordDiagram voicing={quiz.voicing} tuning={quiz.tuningUsed} size={0.85} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <button className="btn" onClick={() => playQuizVoicing(quiz.voicing, quiz.tuningUsed)}>🔊 再听这个和弦</button>
                        <button className="btn primary" onClick={() => nextQuiz()}>下一题 →</button>
                      </div>
                    </div>
                    <div className="muted small" style={{ marginTop: 8 }}>复盘提示:{quiz.type.name},参考练耳页「和弦」题型的听感特征(Enter = 下一题)</div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <div className="row">
              <h3 style={{ margin: 0 }}>🏆 考试成绩</h3>
              <div className="spacer" />
              <button
                className="btn sm ghost"
                onClick={() => {
                  setQuizSession({ asked: 0, right: 0 })
                  setQuizStreak(0)
                }}
              >
                重置本轮
              </button>
            </div>
            <div className="stat-grid">
              <div className="stat-box">
                <div className="v">{quizSession.right}/{quizSession.asked}</div>
                <div className="k">本轮答题</div>
              </div>
              <div className="stat-box">
                <div className="v">{quizStreak}</div>
                <div className="k">当前连对</div>
              </div>
              <div className="stat-box">
                <div className="v">{quizStats.best}</div>
                <div className="k">历史最佳连对</div>
              </div>
              <div className="stat-box">
                <div className="v">{quizStats.total ? Math.round((quizStats.right / quizStats.total) * 100) : 0}%</div>
                <div className="k">累计正确率</div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
