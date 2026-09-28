// 调音器:麦克风实时音高(YIN)+ 指针表盘 + 目标弦高亮
import { useEffect, useRef, useState } from 'react'
import { MicRecorder } from '../audio/recorder'
import { yin, makeYinScratch, type YinScratch } from '../audio/pitch'
import { TUNINGS } from '../theory/tunings'
import { midiToFreq, midiToName } from '../theory/notes'
import { GuitarSynth } from '../audio/synth'

export default function TunerPage() {
  const [tuningId, setTuningId] = useState('standard')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 表盘状态
  const [cents, setCents] = useState<number | null>(null)
  const [noteName, setNoteName] = useState('--')
  const [freq, setFreq] = useState(0)
  const [targetString, setTargetString] = useState(-1)
  const [stable, setStable] = useState(false)

  const recRef = useRef<MicRecorder | null>(null)
  const rafRef = useRef(0)
  const smoothRef = useRef<number | null>(null)
  const targetRef = useRef(-1)

  const tuning = TUNINGS.find((t) => t.id === tuningId)!

  const stop = () => {
    cancelAnimationFrame(rafRef.current)
    recRef.current?.abort()
    recRef.current = null
    setRunning(false)
    setCents(null)
    setNoteName('--')
    setFreq(0)
    setTargetString(-1)
    smoothRef.current = null
  }

  useEffect(() => () => stop(), [])

  const start = async () => {
    setErr(null)
    try {
      const rec = new MicRecorder()
      await rec.start()
      recRef.current = rec
      setRunning(true)
      const buf = new Float32Array(2048)
      const scratch: YinScratch = makeYinScratch(2048, rec.analyser?.context.sampleRate ?? 48000, 70)
      const loop = () => {
        const an = recRef.current?.analyser
        if (!an) return
        an.getFloatTimeDomainData(buf)
        const { freq: f, prob } = yin(buf, an.context.sampleRate, 0.12, 70, 700, scratch)
        if (f > 0 && prob > 0.6) {
          setFreq(f)
          // 找最近的目标弦
          let bestS = 0
          let bestD = Infinity
          tuning.midi.forEach((m, i) => {
            const d = Math.abs(1200 * Math.log2(f / midiToFreq(m)))
            if (d < bestD) {
              bestD = d
              bestS = i
            }
          })
          // 距离上限:偏差超过 55 音分不吸附到任何弦,按最近的半音显示,避免误导
          const matched = bestD <= 55
          targetRef.current = matched ? bestS : -1
          setTargetString(matched ? bestS : -1)
          const refMidi = matched ? tuning.midi[bestS] : Math.round(69 + 12 * Math.log2(f / 440))
          const dev = 1200 * Math.log2(f / midiToFreq(refMidi))
          // 平滑显示
          smoothRef.current = smoothRef.current === null ? dev : smoothRef.current * 0.7 + dev * 0.3
          setCents(Math.max(-50, Math.min(50, smoothRef.current)))
          setNoteName(midiToName(refMidi))
          setStable(matched && Math.abs(smoothRef.current) < 5)
        } else {
          setFreq(0)
          setStable(false)
        }
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    } catch (e) {
      setErr('无法访问麦克风:' + String(e) + '。请检查浏览器权限(需要 https 或 localhost)。')
    }
  }

  // 指针角度:-50 音分 → -70°,+50 → +70°
  const angle = cents === null ? 0 : (cents / 50) * 70
  const inTune = cents !== null && Math.abs(cents) < 5

  return (
    <div className="tuner-wrap">
      <div className="row mb">
        <label className="field">调弦
          <select value={tuningId} onChange={(e) => setTuningId(e.target.value)} disabled={running}>
            {TUNINGS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <button className={`btn ${running ? 'danger' : 'primary'}`} onClick={running ? stop : start}>
          {running ? '■ 停止' : '🎤 开启麦克风'}
        </button>
      </div>

      {err && <div className="warn-box" style={{ maxWidth: 520 }}>{err}</div>}

      <svg width="340" height="190" viewBox="0 0 340 190">
        {/* 表盘弧 */}
        <path d="M 40 160 A 130 130 0 0 1 300 160" fill="none" stroke="#262b36" strokeWidth="10" strokeLinecap="round" />
        {/* 准音区 */}
        <path d="M 154 37.5 A 130 130 0 0 1 186 37.5" fill="none" stroke="#58c98a" strokeWidth="10" strokeLinecap="round" transform="rotate(-4.5 170 160)" />
        {/* 刻度 */}
        {[-50, -25, 0, 25, 50].map((c) => {
          const a = ((c / 50) * 70 - 90) * (Math.PI / 180)
          const x1 = 170 + Math.sin(a) * 118
          const y1 = 160 + Math.cos(a) * 118
          const x2 = 170 + Math.sin(a) * 128
          const y2 = 160 + Math.cos(a) * 128
          return <line key={c} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#667086" strokeWidth="2" />
        })}
        {/* 指针 */}
        <g transform={`rotate(${angle} 170 160)`}>
          <line x1="170" y1="160" x2="170" y2="45" stroke={inTune ? '#58c98a' : '#f0b45c'} strokeWidth="4" strokeLinecap="round" />
        </g>
        <circle cx="170" cy="160" r="9" fill="#4a5468" />
        <text x="170" y="185" textAnchor="middle" fill="#667086" fontSize="11">
          {running ? (freq > 0 ? `${freq.toFixed(1)} Hz` : '请弹响一根弦…') : '麦克风未开启'}
        </text>
      </svg>

      <div className={`note-big${inTune ? ' in' : ''}`}>{noteName}</div>
      <div className="cents-big">
        {cents === null ? '--' : `${cents > 0 ? '+' : ''}${cents.toFixed(0)} 音分`}
        {stable && <span style={{ color: 'var(--ok)' }}> ✓ 已准</span>}
        {cents !== null && !stable && cents < 0 && <span style={{ color: 'var(--muted)' }}> 偏低,拧紧</span>}
        {cents !== null && !stable && cents > 0 && <span style={{ color: 'var(--muted)' }}> 偏高,放松</span>}
      </div>

      <div className="string-btns">
        {tuning.midi.map((m, i) => (
          <button
            key={i}
            className={`string-btn${targetString === i ? ' active' : ''}`}
            onClick={() => GuitarSynth.pluckMidi(m, { gain: 0.4 })}
            title="点击听标准音"
          >
            <span className="n">{midiToName(m)}</span>
            <span>{6 - i} 弦</span>
          </button>
        ))}
      </div>
      <div className="muted small">点弦钮可听该弦标准音;弹琴时最接近的弦会自动高亮。</div>
    </div>
  )
}
