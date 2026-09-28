// 音高轨迹页:短录音 → 逐帧音高曲线(纵轴音名分格)+ 稳定段标注 + 原音频对照播放
import { useCallback, useEffect, useRef, useState } from 'react'
import { MicRecorder, decodeFile } from '../audio/recorder'
import { getCtx, getMaster } from '../audio/engine'
import { GuitarSynth } from '../audio/synth'
import { computePitchTrack, type PitchTrackResult, type PitchSegment } from '../pitch/trace'
import { midiToFreq, midiToName } from '../theory/notes'

export default function PitchTracePage() {
  const [audio, setAudio] = useState<AudioBuffer | null>(null)
  const [fileName, setFileName] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<PitchTrackResult | null>(null)
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  const [err, setErr] = useState('')
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recRef = useRef<MicRecorder | null>(null)
  const srcRef = useRef<AudioBufferSourceNode | null>(null)
  const rafRef = useRef(0)
  const playT0Ref = useRef(0) // ctx.currentTime - 播放起点偏移
  const resultRef = useRef<PitchTrackResult | null>(null)
  const audioRef = useRef<AudioBuffer | null>(null)
  const playheadRef = useRef<number | null>(null)
  const layoutRef = useRef<{ x0: number; y0: number; w: number; h: number; tMax: number; mMin: number; mMax: number } | null>(null)

  useEffect(() => {
    resultRef.current = result
  }, [result])
  useEffect(() => {
    audioRef.current = audio
  }, [audio])

  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (srcRef.current) {
      try {
        srcRef.current.stop()
      } catch {
        /* 已停 */
      }
      srcRef.current = null
    }
    playheadRef.current = null
    setPlaying(false)
    draw()
  }, [])

  useEffect(
    () => () => {
      stopPlayback()
      recRef.current?.abort()
    },
    [stopPlayback],
  )

  // ---------- 音源 ----------

  const loadBuffer = async (buf: AudioBuffer, name: string) => {
    stopPlayback()
    setErr('')
    setResult(null)
    setAudio(buf)
    setFileName(name)
    if (buf.duration > 180) {
      setErr(`录音较长(${buf.duration.toFixed(0)}s),分析会需要一段时间,建议截取 2 分钟以内的片段。`)
    }
    setAnalyzing(true)
    setProgress(0)
    try {
      const sr = buf.sampleRate
      const data = buf.getChannelData(0)
      const r = await computePitchTrack(data as Float32Array, sr, setProgress)
      setResult(r)
    } catch (e) {
      setErr('分析出错:' + String(e))
    } finally {
      setAnalyzing(false)
    }
  }

  const onFile = async (file: File) => {
    try {
      const buf = await decodeFile(file)
      await loadBuffer(buf, `${file.name}(${buf.duration.toFixed(1)}s)`)
    } catch {
      setErr('无法解码该音频,请换 mp3/wav/m4a 格式。')
    }
  }

  const toggleRecord = async () => {
    if (recording) {
      const rec = recRef.current
      if (!rec) return
      setRecording(false)
      const buf = await rec.stop()
      recRef.current = null
      await loadBuffer(buf, `麦克风录音(${buf.duration.toFixed(1)}s)`)
    } else {
      setErr('')
      try {
        const rec = new MicRecorder()
        await rec.start()
        recRef.current = rec
        setRecording(true)
      } catch (e) {
        setErr('无法访问麦克风:' + String(e))
      }
    }
  }

  // ---------- 播放(点击曲线任意处从该时刻播放) ----------

  const playFrom = (t: number) => {
    if (!audio) return
    stopPlayback()
    const ctx = getCtx()
    const src = ctx.createBufferSource()
    src.buffer = audio
    src.connect(getMaster())
    src.onended = () => {
      if (srcRef.current === src) stopPlayback()
    }
    src.start(0, Math.max(0, Math.min(t, audio.duration - 0.02)))
    srcRef.current = src
    playT0Ref.current = ctx.currentTime - t
    setPlaying(true)
    const tick = () => {
      const cur = getCtx().currentTime - playT0Ref.current
      playheadRef.current = cur <= audio.duration ? cur : null
      draw()
      if (cur <= audio.duration && srcRef.current) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // ---------- 绘制 ----------

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    const r = resultRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const W = wrap.clientWidth
    const H = 420
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr
      canvas.height = H * dpr
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0b0d11'
    ctx.fillRect(0, 0, W, H)

    const ML = 46
    const MR = 10
    const MT = 10
    const MB = 24
    const plotW = W - ML - MR
    const plotH = H - MT - MB
    const tMax = Math.max(1, audioRef.current?.duration ?? 1)
    let mMin = 40
    let mMax = 76
    if (r && r.minMidi < r.maxMidi) {
      mMin = Math.max(24, Math.floor(r.minMidi) - 2)
      mMax = Math.min(104, Math.ceil(r.maxMidi) + 2)
      if (mMax - mMin < 14) {
        const c = (mMin + mMax) / 2
        mMin = Math.floor(c - 7)
        mMax = Math.ceil(c + 7)
      }
    }
    layoutRef.current = { x0: ML, y0: MT, w: plotW, h: plotH, tMax, mMin, mMax }
    const xOf = (t: number) => ML + (t / tMax) * plotW
    const yOf = (m: number) => MT + plotH - ((m - mMin) / (mMax - mMin)) * plotH

    // 半音格线 + 音名(密度自适应)
    const span = mMax - mMin
    const labelEvery = span <= 26 ? 1 : span <= 48 ? 2 : 12
    ctx.font = '11px sans-serif'
    for (let m = Math.ceil(mMin); m <= mMax; m++) {
      const y = yOf(m)
      const isOctave = ((m % 12) + 12) % 12 === 0
      ctx.strokeStyle = isOctave ? '#3a4356' : '#1d222b'
      ctx.lineWidth = isOctave ? 1.4 : 1
      ctx.beginPath()
      ctx.moveTo(ML, y)
      ctx.lineTo(ML + plotW, y)
      ctx.stroke()
      if (m % labelEvery === 0) {
        ctx.fillStyle = isOctave ? '#8b93a7' : '#5a6273'
        ctx.textAlign = 'right'
        ctx.fillText(midiToName(m), ML - 6, y + 3.5)
      }
    }
    // 时间刻度
    const step = tMax <= 6 ? 1 : tMax <= 15 ? 2 : tMax <= 40 ? 5 : tMax <= 90 ? 10 : 30
    ctx.textAlign = 'center'
    ctx.fillStyle = '#5a6273'
    for (let t = 0; t <= tMax; t += step) {
      const x = xOf(t)
      ctx.strokeStyle = '#1d222b'
      ctx.beginPath()
      ctx.moveTo(x, MT)
      ctx.lineTo(x, MT + plotH)
      ctx.stroke()
      ctx.fillText(t.toFixed(0) + 's', x, H - 8)
    }

    // 音高曲线(相邻有声帧连线;跳变 > 1.5 半音或断帧则断开)
    if (r) {
      ctx.strokeStyle = '#4cc2a9'
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      let drawing = false
      let prevMidi = 0
      ctx.beginPath()
      for (const f of r.frames) {
        const voiced = f.freq > 0 && f.prob > 0.6 && f.rms > 0.008
        if (!voiced) {
          drawing = false
          continue
        }
        const m = 69 + 12 * Math.log2(f.freq / 440)
        const x = xOf(f.t)
        const y = yOf(m)
        if (!drawing || Math.abs(m - prevMidi) > 1.5) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
        drawing = true
        prevMidi = m
      }
      ctx.stroke()

      // 稳定段标注:音名 + 音分偏差
      ctx.font = 'bold 11px sans-serif'
      for (const s of r.segments) {
        const x1 = xOf(s.start)
        const x2 = xOf(s.end)
        if (x2 - x1 < 34) continue
        const label = `${s.noteName}${s.cents >= 0 ? '+' : ''}${s.cents.toFixed(0)}¢`
        const y = yOf(s.midi)
        const tw = ctx.measureText(label).width
        const cx = (x1 + x2) / 2
        ctx.fillStyle = 'rgba(124,108,240,0.85)'
        roundRect(ctx, cx - tw / 2 - 5, y - 22, tw + 10, 15, 4)
        ctx.fill()
        ctx.fillStyle = '#e6e9f0'
        ctx.textAlign = 'center'
        ctx.fillText(label, cx, y - 11)
        // 段落下划线
        ctx.strokeStyle = 'rgba(124,108,240,0.6)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x1, y + 7)
        ctx.lineTo(x2, y + 7)
        ctx.stroke()
      }
    }

    // 播放指针
    if (playheadRef.current !== null) {
      const x = xOf(playheadRef.current)
      ctx.strokeStyle = '#f0b45c'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(x, MT)
      ctx.lineTo(x, MT + plotH)
      ctx.stroke()
    }
  }, [])

  useEffect(() => {
    draw()
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw, result])

  // ---------- 悬停与点击 ----------

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = resultRef.current
    const lay = layoutRef.current
    const canvas = canvasRef.current
    if (!r || !lay || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (px < lay.x0 || px > lay.x0 + lay.w) {
      setHover(null)
      return
    }
    const t = ((px - lay.x0) / lay.w) * lay.tMax
    const m = lay.mMin + (1 - (py - lay.y0) / lay.h) * (lay.mMax - lay.mMin)
    // 找最近帧
    let best = r.frames[0]
    let bestD = Infinity
    for (const f of r.frames) {
      const d = Math.abs(f.t - t)
      if (d < bestD) {
        bestD = d
        best = f
      }
    }
    let text: string
    if (best && best.freq > 0 && best.prob > 0.6) {
      const mf = 69 + 12 * Math.log2(best.freq / 440)
      const cents = (mf - Math.round(mf)) * 100
      text = `${best.t.toFixed(2)}s · ${best.freq.toFixed(1)}Hz · ${midiToName(Math.round(mf))} ${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢`
    } else {
      text = `${t.toFixed(2)}s ·(此处无声或音高不可辨)`
    }
    void m
    setHover({ x: px, y: py, text })
  }

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const lay = layoutRef.current
    if (!lay) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (px < lay.x0 || px > lay.x0 + lay.w) return
    const t = ((px - lay.x0) / lay.w) * lay.tMax
    playFrom(t)
  }

  const playSegmentNote = (s: PitchSegment) => {
    GuitarSynth.pluck(midiToFreq(s.midi), { gain: 0.4 })
  }

  const rangeText = result && result.minMidi < result.maxMidi
    ? `${midiToName(Math.round(result.minMidi))} – ${midiToName(Math.round(result.maxMidi))}`
    : '--'

  return (
    <>
      <div className="card">
        <div className="source-row">
          <input ref={fileRef} type="file" accept="audio/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
          <button className="btn" onClick={() => fileRef.current?.click()}>📁 导入录音</button>
          <button className={`btn ${recording ? 'danger' : ''}`} onClick={toggleRecord}>
            {recording ? <><span className="rec-dot" />停止录音</> : '🎤 录音'}
          </button>
          {audio && (
            <>
              <button className="btn ghost" onClick={playing ? stopPlayback : () => playFrom(0)}>
                {playing ? '■ 停止' : '▶ 播放原音频'}
              </button>
              <span className="muted small">{fileName}</span>
            </>
          )}
          <div className="spacer" />
          {analyzing && <span className="muted small">分析中… {(progress * 100).toFixed(0)}%</span>}
        </div>
        {err && <div className="warn-box mt">{err}</div>}
        <div className="muted small mt">适合清唱/单音旋律/口哨等单声部短录音;点击曲线任意位置可从该时刻播放对照。</div>
      </div>

      <div className="card">
        <div ref={wrapRef} className="canvas-box" style={{ position: 'relative' }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', width: '100%', height: 420, cursor: audio ? 'pointer' : 'default' }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            onClick={onClick}
          />
          {hover && (
            <div style={{
              position: 'absolute',
              left: Math.min(hover.x + 12, (wrapRef.current?.clientWidth ?? 400) - 220),
              top: Math.max(4, hover.y - 30),
              background: 'rgba(11,13,17,0.92)',
              border: '1px solid #262b36',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 12,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}>{hover.text}</div>
          )}
        </div>
        {result && (
          <div className="tone-metrics mt">
            <div className="metric">
              <div className="v">{rangeText}</div>
              <div className="k">音域范围</div>
            </div>
            <div className="metric">
              <div className="v">{(result.voicedRatio * 100).toFixed(0)}%</div>
              <div className="k">有声(可辨音高)占比</div>
            </div>
            <div className="metric">
              <div className="v">{result.segments.length}</div>
              <div className="k">稳定音高段数</div>
            </div>
          </div>
        )}
      </div>

      {result && result.segments.length > 0 && (
        <div className="card">
          <h3>🎼 音高段落(点击行播放原音频对应位置,▶ 试听该音)</h3>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <thead>
                <tr style={{ color: 'var(--dim)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>#</th>
                  <th style={{ padding: '6px 8px' }}>音名</th>
                  <th style={{ padding: '6px 8px' }}>偏差</th>
                  <th style={{ padding: '6px 8px' }}>开始</th>
                  <th style={{ padding: '6px 8px' }}>时长</th>
                  <th style={{ padding: '6px 8px' }}>稳定度</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {result.segments.map((s, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => playFrom(s.start)}>
                    <td style={{ padding: '6px 8px', color: 'var(--dim)' }}>{i + 1}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 700 }}>{s.noteName}</td>
                    <td style={{ padding: '6px 8px', color: Math.abs(s.cents) > 20 ? 'var(--warn)' : 'var(--muted)' }}>
                      {s.cents >= 0 ? '+' : ''}{s.cents.toFixed(0)}¢
                    </td>
                    <td style={{ padding: '6px 8px' }}>{s.start.toFixed(2)}s</td>
                    <td style={{ padding: '6px 8px' }}>{(s.end - s.start).toFixed(2)}s</td>
                    <td style={{ padding: '6px 8px', color: s.stability < 15 ? 'var(--ok)' : s.stability < 40 ? 'var(--muted)' : 'var(--warn)' }}>
                      ±{s.stability.toFixed(0)}¢
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); playSegmentNote(s) }}>▶</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
