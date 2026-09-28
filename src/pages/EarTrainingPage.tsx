// 练耳页:五种题型,自适应难度,统计面板。
// 交互流:出题静音 → 用户点播放作答 → 答后进入复盘(再听/慢速/对比你的答案/特征提示)→ 手动下一题
import { useEffect, useMemo, useState } from 'react'
import {
  EAR_KINDS,
  makeQuestion,
  INTERVAL_HINTS,
  CHORD_HINTS,
  SCALE_HINTS,
  METHOD_HINTS,
  type EarKind,
  type Question,
} from '../ear/engine'
import { INTERVALS, SCALES } from '../theory/notes'
import { CHORD_TYPES as CHORD_TYPES_FULL } from '../theory/chords'
import { loadStats, recordAnswer, resetStats, streakDays, type EarStats } from '../stores/stats'
import { GuitarSynth } from '../audio/synth'
import { getCtx } from '../audio/engine'

/** 选项名 → 听感特征(用于「选项特征」面板) */
function hintOfChoice(kind: EarKind, choice: string): string {
  if (kind === 'interval') {
    const hit = INTERVALS.find((i) => i.name === choice)
    return hit ? INTERVAL_HINTS[hit.short] ?? '' : ''
  }
  if (kind === 'chord') {
    const hit = CHORD_TYPES_FULL.find((t) => t.name === choice)
    return hit ? CHORD_HINTS[hit.id] ?? '' : ''
  }
  if (kind === 'scale') {
    const hit = SCALES.find((s) => s.name === choice)
    return hit ? SCALE_HINTS[hit.id] ?? '' : ''
  }
  return ''
}

export default function EarTrainingPage() {
  const [kind, setKind] = useState<EarKind>('interval')
  const [stats, setStats] = useState<EarStats>(() => loadStats())
  const [q, setQ] = useState<Question | null>(null)
  const [answered, setAnswered] = useState(false)
  const [wasRight, setWasRight] = useState(false)
  const [chosen, setChosen] = useState<number[]>([])
  const [seqInput, setSeqInput] = useState<number[]>([])
  const [patternInput, setPatternInput] = useState<boolean[]>([])
  const [showHints, setShowHints] = useState(false) // 选项特征面板

  const level = stats.kinds[kind]?.level ?? 1

  const nextQuestion = (k: EarKind = kind, lvl = level) => {
    // 只出题,不自动播放(静音进入,等用户点播放)
    setQ(makeQuestion(k, Math.max(1, Math.min(5, lvl))))
    setAnswered(false)
    setChosen([])
    setSeqInput([])
    setPatternInput(new Array(16).fill(false))
  }

  useEffect(() => {
    nextQuestion(kind, stats.kinds[kind]?.level ?? 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const finish = (ok: boolean) => {
    setAnswered(true)
    setWasRight(ok)
    setStats(recordAnswer(kind, ok))
  }

  const choose = (i: number) => {
    if (answered || !q) return
    setChosen([i])
    finish(i === q.answer)
  }

  const submitSeq = () => {
    if (answered || !q?.answerSeq) return
    finish(seqInput.length === q.answerSeq.length && seqInput.every((v, i) => v === q.answerSeq![i]))
  }

  const submitPattern = () => {
    if (answered || !q?.answerPattern) return
    const target = q.answerPattern
    const input = patternInput.slice(0, q.slots)
    finish(input.every((v, i) => v === target[i]))
  }

  // 复盘:播放「你的答案」
  const playUserMelody = () => {
    if (!q) return
    const degrees = [60, 62, 64, 65, 67, 69, 71, 72]
    const t0 = getCtx().currentTime + 0.05
    seqInput.forEach((d, i) => GuitarSynth.pluckMidi(degrees[d - 1] ?? 60, { when: t0 + i * 0.5, gain: 0.42 }))
  }

  const playUserRhythm = () => {
    if (!q?.slots) return
    const t0 = getCtx().currentTime + 0.08
    const d = 0.28
    patternInput.slice(0, q.slots).forEach((hit, i) => {
      if (hit) GuitarSynth.click(t0 + i * d, i === 0, 0.55)
    })
  }

  // 键盘:数字作答 / Backspace 删除 / Enter 下一题 / 空格重播
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!q) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (answered && e.key === 'Enter') {
        nextQuestion()
        return
      }
      const n = parseInt(e.key, 10)
      if (!isNaN(n) && n >= 1) {
        if (q.kind === 'melody' && !answered && n <= 8) {
          if (seqInput.length < (q.answerSeq?.length ?? 8)) setSeqInput((s) => [...s, n])
        } else if (!answered && q.choices.length > 0 && n <= q.choices.length && q.answer >= 0) {
          choose(n - 1)
        }
      }
      if (e.key === 'Backspace' && q.kind === 'melody' && !answered) setSeqInput((s) => s.slice(0, -1))
      if (e.key === 'Enter' && q.kind === 'melody' && !answered) submitSeq()
      if (e.key === ' ' && !answered) {
        e.preventDefault()
        q.replay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const kindStat = stats.kinds[kind]
  const todayKey = (() => {
    const d = new Date()
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })()
  const today = stats.daily[todayKey]
  const streak = useMemo(() => streakDays(stats), [stats])
  const recentHistory = (kindStat?.history ?? []).slice(-30)
  const hasChoiceHints = kind === 'interval' || kind === 'chord' || kind === 'scale'

  return (
    <>
      <div className="ear-tabs">
        {EAR_KINDS.map((k) => (
          <button key={k.id} className={`chip${kind === k.id ? ' active' : ''}`} onClick={() => setKind(k.id)}>
            {k.icon} {k.name}
          </button>
        ))}
        <div className="spacer" />
        <span className="muted small">
          难度 <LevelDots level={kindStat?.level ?? 1} /> 连对升级 · 连错降级
        </span>
      </div>

      <div className="card question-box">
        {q && (
          <>
            <div className="prompt">{q.prompt}{!answered && <span className="muted small">(点下方播放开始)</span>}</div>
            <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
              <button className="btn primary big" onClick={() => q.replay()}>▶ 播放</button>
              {q.replaySlow && <button className="btn big" onClick={() => q.replaySlow!()}>🐢 慢速</button>}
              {hasChoiceHints && (
                <button className={`chip${showHints ? ' warn-active' : ''}`} onClick={() => setShowHints(!showHints)}>
                  💡 选项特征{showHints ? '(开)' : ''}
                </button>
              )}
            </div>

            {/* 选项听感特征面板(答题前后都可用,不泄露答案) */}
            {showHints && hasChoiceHints && (
              <div className="hint-panel">
                {q.choices.map((c) => (
                  <div key={c} className="hint-row">
                    <span className="hint-name">{c}</span>
                    <span className="muted small">{hintOfChoice(kind, c) || '—'}</span>
                  </div>
                ))}
              </div>
            )}
            {!hasChoiceHints && (
              <div className="muted small" style={{ marginBottom: 10 }}>💡 {METHOD_HINTS[kind]}</div>
            )}

            {/* 音程/和弦/音阶:选择题 */}
            {q.choices.length > 0 && q.answer >= 0 && (
              <div className="choices">
                {q.choices.map((c, i) => {
                  let cls = 'choice'
                  if (answered) {
                    if (i === q.answer) cls += ' right'
                    else if (chosen.includes(i)) cls += ' wrong'
                    else cls += ' dimmed'
                  }
                  return (
                    <button key={i} className={cls} disabled={answered} onClick={() => choose(i)}>
                      {c}
                    </button>
                  )
                })}
              </div>
            )}

            {/* 旋律听写:音级序列输入 */}
            {q.kind === 'melody' && (
              <>
                <div className="degree-input">
                  {q.choices.map((c, i) => (
                    <button
                      key={i}
                      className="degree-btn"
                      disabled={answered || seqInput.length >= (q.answerSeq?.length ?? 8)}
                      onClick={() => setSeqInput((s) => [...s, i + 1])}
                    >{c}</button>
                  ))}
                </div>
                <div className="seq-chips">
                  {seqInput.map((v, i) => {
                    let cls = 'seq-chip'
                    if (answered && q.answerSeq) cls += v === q.answerSeq[i] ? ' good' : ' bad'
                    return <div key={i} className={cls}>{v}</div>
                  })}
                  {!answered && Array.from({ length: (q.answerSeq?.length ?? 0) - seqInput.length }, (_, i) => (
                    <div key={`e${i}`} className="seq-chip" style={{ opacity: 0.25 }}>?</div>
                  ))}
                </div>
                {!answered ? (
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <button className="btn" onClick={() => setSeqInput((s) => s.slice(0, -1))}>⌫ 删除</button>
                    <button className="btn primary" onClick={submitSeq} disabled={seqInput.length !== q.answerSeq?.length}>
                      ✓ 提交答案
                    </button>
                  </div>
                ) : null}
              </>
            )}

            {/* 节奏:网格输入 */}
            {q.kind === 'rhythm' && q.slots && (
              <>
                <div className="grid-rhythm" style={{ gridTemplateColumns: `repeat(${q.slots / 2}, 1fr)` }}>
                  {Array.from({ length: q.slots }, (_, i) => {
                    let cls = 'slot'
                    if (answered && q.answerPattern) {
                      if (q.answerPattern[i]) cls += ' right'
                      else if (patternInput[i]) cls += ' wronghit'
                    } else if (patternInput[i]) cls += ' on'
                    return (
                      <button key={i} className={cls} disabled={answered}
                        onClick={() => setPatternInput((p) => p.map((v, j) => (j === i ? !v : v)))} />
                    )
                  })}
                </div>
                <div className="muted small mt" style={{ textAlign: 'center', marginBottom: 10 }}>
                  上半 = 前半小节,下半 = 后半小节(每格 8 分音符)
                </div>
                {!answered ? (
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <button className="btn primary" onClick={submitPattern}>✓ 提交答案</button>
                    <button className="btn ghost" onClick={() => setPatternInput(new Array(q.slots).fill(false))}>清空</button>
                  </div>
                ) : null}
              </>
            )}

            {/* 复盘环节:答完不自动跳题 */}
            {answered && (
              <div className="review-box">
                <div className={`feedback ${wasRight ? 'ok' : 'no'}`}>{wasRight ? '✓ 正确!' : '✗ 没关系,听听区别'} {q.detail}</div>
                {q.hint && <div className="review-hint">💡 听感特征:{q.hint}</div>}
                <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
                  <button className="btn" onClick={() => q.replay()}>🔊 再听题目</button>
                  {q.replaySlow && <button className="btn" onClick={() => q.replaySlow!()}>🐢 慢速</button>}
                  {q.kind === 'melody' && seqInput.length > 0 && (
                    <button className="btn" onClick={playUserMelody}>🔊 你的答案</button>
                  )}
                  {q.kind === 'rhythm' && patternInput.some(Boolean) && (
                    <button className="btn" onClick={playUserRhythm}>🔊 你的答案</button>
                  )}
                  <button className="btn primary" onClick={() => nextQuestion()}>下一题 →</button>
                </div>
                <div className="muted small" style={{ marginTop: 8 }}>复盘完再走:反复听、对比你的答案,是练耳进步最快的方式(Enter = 下一题)</div>
              </div>
            )}
            {!answered && (
              <div className="muted small mt">快捷键:空格重播 · 数字键作答 · Backspace 删除</div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3>📊 练习统计</h3>
        <div className="stat-grid">
          <div className="stat-box">
            <div className="v">{today ? `${today.correct}/${today.total}` : '0'}</div>
            <div className="k">今日答题</div>
          </div>
          <div className="stat-box">
            <div className="v">{streak} 天</div>
            <div className="k">连续练习</div>
          </div>
          <div className="stat-box">
            <div className="v">{kindStat ? Math.round((kindStat.correct / Math.max(1, kindStat.total)) * 100) : 0}%</div>
            <div className="k">当前题型正确率</div>
          </div>
          <div className="stat-box">
            <div className="v">{kindStat?.total ?? 0}</div>
            <div className="k">当前题型总题数</div>
          </div>
        </div>
        {recentHistory.length > 0 && (
          <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 46, marginTop: 14 }}>
            {recentHistory.map((h, i) => (
              <div key={i} title={h.ok ? '正确' : '错误'}
                style={{ width: 8, flex: 1, maxWidth: 14, height: `${30 + (h.ok ? 70 : 0) * 0.2}%`, minHeight: 6, borderRadius: 3, background: h.ok ? 'var(--ok)' : 'var(--err)', opacity: 0.85 }} />
            ))}
          </div>
        )}
        <div className="row mt">
          <span className="muted small">各题型进度:{EAR_KINDS.map((k) => {
            const s = stats.kinds[k.id]
            return `${k.name} L${s?.level ?? 1}(${s?.total ?? 0}题)`
          }).join(' · ')}</span>
          <div className="spacer" />
          <button className="btn sm danger ghost" onClick={() => { if (confirm('确定清空全部练耳记录?')) setStats(resetStats()) }}>清空记录</button>
        </div>
      </div>
    </>
  )
}

function LevelDots({ level }: { level: number }) {
  return (
    <span className="level-dots">
      {Array.from({ length: 5 }, (_, i) => <i key={i} className={i < level ? 'on' : ''} />)}
    </span>
  )
}
