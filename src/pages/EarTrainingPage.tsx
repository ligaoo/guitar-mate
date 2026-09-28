// 练耳页:五种题型,自适应难度,统计面板
import { useEffect, useMemo, useRef, useState } from 'react'
import { EAR_KINDS, makeQuestion, type EarKind, type Question } from '../ear/engine'
import { loadStats, recordAnswer, resetStats, streakDays, type EarStats } from '../stores/stats'

export default function EarTrainingPage() {
  const [kind, setKind] = useState<EarKind>('interval')
  const [stats, setStats] = useState<EarStats>(() => loadStats())
  const [q, setQ] = useState<Question | null>(null)
  const [answered, setAnswered] = useState(false)
  const [wasRight, setWasRight] = useState(false)
  const [chosen, setChosen] = useState<number[]>([])
  const [seqInput, setSeqInput] = useState<number[]>([])
  const [patternInput, setPatternInput] = useState<boolean[]>([])
  const timerRef = useRef<number>(0)

  const level = stats.kinds[kind]?.level ?? 1

  const nextQuestion = (k: EarKind = kind, lvl = level) => {
    setQ(makeQuestion(k, Math.max(1, Math.min(5, lvl))))
    setAnswered(false)
    setChosen([])
    setSeqInput([])
    setPatternInput(new Array(16).fill(false))
    window.setTimeout(() => setQ((cur) => {
      cur?.replay()
      return cur
    }), 60)
  }

  useEffect(() => {
    nextQuestion(kind, stats.kinds[kind]?.level ?? 1)
    return () => window.clearTimeout(timerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  // 卸载时清理自动下一题的定时器
  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const finish = (ok: boolean) => {
    setAnswered(true)
    setWasRight(ok)
    setStats(recordAnswer(kind, ok))
    timerRef.current = window.setTimeout(() => nextQuestion(), ok ? 1100 : 2000)
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

  // 键盘 1-9 快捷选择(输入控件聚焦时不触发)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!q) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      const n = parseInt(e.key, 10)
      if (!isNaN(n) && n >= 1) {
        if (q.kind === 'melody' && n <= 8) {
          if (!answered && seqInput.length < (q.answerSeq?.length ?? 8)) setSeqInput((s) => [...s, n])
        } else if (q.choices.length > 0 && n <= q.choices.length && q.answer >= 0) {
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
            <div className="prompt">{q.prompt}</div>
            <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
              <button className="btn primary big" onClick={() => q.replay()}>▶ 播放</button>
              {q.replaySlow && <button className="btn big" onClick={() => q.replaySlow!()}>🐢 慢速</button>}
            </div>

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
                ) : (
                  <div className="feedback">{q.detail}</div>
                )}
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
                ) : (
                  <div className="feedback">{q.detail}</div>
                )}
              </>
            )}

            {answered && q.answer >= 0 && <div className={`feedback ${wasRight ? 'ok' : 'no'}`}>{wasRight ? '✓ 正确!' : '✗ 再听一遍'} {q.detail}</div>}
            <div className="muted small mt">快捷键:空格重播 · 数字键作答 · Backspace 删除</div>
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
