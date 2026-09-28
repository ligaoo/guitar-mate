// 音色分析页:实时频谱 + 声谱图;单音录音分析(谐波结构/包络/频谱特征/音准)
import { useEffect, useRef, useState } from 'react'
import { MicRecorder } from '../audio/recorder'
import { analyzeTone, type ToneReport } from '../tone/analysis'

function distortionLabel(r: number): string {
  if (r < 1) return '清音 · 温润'
  if (r < 3) return '轻度过驱动(轻微破音/压缩感)'
  return '失真明显(强过载/失真类音色)'
}

export default function TonePage() {
  const [mode, setMode] = useState<'live' | 'note'>('live')
  const [liveOn, setLiveOn] = useState(false)
  const [liveErr, setLiveErr] = useState('')
  const [recording, setRecording] = useState(false)
  const [report, setReport] = useState<ToneReport | null>(null)
  const [prevReport, setPrevReport] = useState<ToneReport | null>(null)
  const [noteErr, setNoteErr] = useState('')

  const recRef = useRef<MicRecorder | null>(null)
  const rafRef = useRef(0)
  const specCanvas = useRef<HTMLCanvasElement>(null)
  const waterCanvas = useRef<HTMLCanvasElement>(null)
  const noteRecRef = useRef<MicRecorder | null>(null)
  const noteTimerRef = useRef(0)

  const stopLive = () => {
    cancelAnimationFrame(rafRef.current)
    recRef.current?.abort()
    recRef.current = null
    setLiveOn(false)
  }

  useEffect(() => () => {
    stopLive()
    noteRecRef.current?.abort()
    window.clearTimeout(noteTimerRef.current)
  }, [])

  const startLive = async () => {
    setLiveErr('')
    try {
      const rec = new MicRecorder()
      await rec.start()
      recRef.current = rec
      setLiveOn(true)
      const freqData = new Uint8Array(rec.analyser!.frequencyBinCount)
      const draw = () => {
        const an = recRef.current?.analyser
        if (!an) return
        an.getByteFrequencyData(freqData)
        drawSpectrum(specCanvas.current, an, freqData)
        drawWaterfall(waterCanvas.current, an, freqData)
        rafRef.current = requestAnimationFrame(draw)
      }
      rafRef.current = requestAnimationFrame(draw)
    } catch (e) {
      setLiveErr('无法访问麦克风:' + String(e) + '(需要 https 或 localhost)')
    }
  }

  const recordNote = async () => {
    setNoteErr('')
    if (recording) return
    try {
      const rec = new MicRecorder()
      await rec.start()
      noteRecRef.current = rec
      setRecording(true)
      noteTimerRef.current = window.setTimeout(async () => {
        const buf = await rec.stop()
        noteRecRef.current = null
        setRecording(false)
        const r = analyzeTone(buf)
        if (!r) {
          setNoteErr('没检测到稳定的单音,请在一个安静环境里持续弹响一个音约 3 秒。')
          return
        }
        setPrevReport(report)
        setReport(r)
      }, 3500)
    } catch (e) {
      setNoteErr('无法访问麦克风:' + String(e))
      setRecording(false)
    }
  }

  return (
    <>
      <div className="row mb">
        <div className="chip-row">
          <button className={`chip${mode === 'live' ? ' active' : ''}`} onClick={() => { stopLive(); setMode('live') }}>实时频谱 / 声谱图</button>
          <button className={`chip${mode === 'note' ? ' active' : ''}`} onClick={() => { stopLive(); setMode('note') }}>单音音色分析</button>
        </div>
      </div>

      {mode === 'live' && (
        <div className="card">
          <div className="row mb">
            <button className={`btn ${liveOn ? 'danger' : 'primary'}`} onClick={liveOn ? stopLive : startLive}>
              {liveOn ? '■ 停止' : '🎤 开启麦克风'}
            </button>
            <span className="muted small">弹琴观察:频谱看泛音分布,声谱图看音高轨迹与延音。</span>
          </div>
          {liveErr && <div className="warn-box">{liveErr}</div>}
          <div className="canvas-box mb">
            <canvas ref={specCanvas} width={880} height={240} />
          </div>
          <div className="canvas-box">
            <canvas ref={waterCanvas} width={880} height={200} />
          </div>
        </div>
      )}

      {mode === 'note' && (
        <>
          <div className="card">
            <div className="row">
              <button className={`btn ${recording ? 'danger' : 'primary'}`} onClick={recordNote} disabled={recording}>
                {recording ? '⏺ 录制中…请持续弹响一个音' : '🎤 录 3.5 秒单音'}
              </button>
              <span className="muted small">建议:清音音色、单音长按,分析谐波结构、起音与音准稳定度。</span>
            </div>
            {noteErr && <div className="warn-box mt">{noteErr}</div>}
          </div>

          {report && (
            <>
              <div className="card">
                <h3>🎵 音准:{report.noteName}({report.freq.toFixed(1)} Hz)</h3>
                <div className="tone-metrics">
                  <div className="metric">
                    <div className="v">{report.cents > 0 ? '+' : ''}{report.cents.toFixed(1)} 音分</div>
                    <div className="k">相对最近半音偏差</div>
                    <div className="hint">{Math.abs(report.cents) < 5 ? '✓ 很准' : Math.abs(report.cents) < 15 ? '可接受' : '建议微调'}</div>
                  </div>
                  <div className="metric">
                    <div className="v">±{report.stabilityCents.toFixed(1)} 音分</div>
                    <div className="k">长音音准抖动</div>
                    <div className="hint">{report.stabilityCents < 8 ? '✓ 稳定' : report.stabilityCents < 20 ? '一般(揉弦/力度造成)' : '波动大'}</div>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3>≋ 谐波结构(H1=基波)</h3>
                <div className="harmonics">
                  {report.harmonics.map((h, i) => (
                    <div key={i} className="hcol">
                      <div className="hbar" style={{ height: `${Math.max(2, Math.min(100, h * 100))}%` }} />
                      <div className="hlab">H{i + 1}</div>
                      <div className="hlab">{(h * 100).toFixed(0)}%</div>
                    </div>
                  ))}
                </div>
                <div className="tone-metrics mt">
                  <div className="metric">
                    <div className="v">{report.oddEven.toFixed(2)}</div>
                    <div className="k">奇/偶次谐波比</div>
                    <div className="hint">偶次偏多→更"温暖";奇次偏多→更"嘶哑/失真感"</div>
                  </div>
                  <div className="metric">
                    <div className="v">{report.distortionRatio.toFixed(2)}</div>
                    <div className="k">谐波总量/基波</div>
                    <div className="hint">{distortionLabel(report.distortionRatio)}</div>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3>📐 频谱与动态特征</h3>
                <div className="tone-metrics">
                  <div className="metric">
                    <div className="v">{report.attackMs.toFixed(0)} ms</div>
                    <div className="k">起音时间(10%→90%)</div>
                    <div className="hint">{report.attackMs < 10 ? '✓ 干脆利落' : '偏慢(指尖软/压缩重)'}</div>
                  </div>
                  <div className="metric">
                    <div className="v">{report.decayS.toFixed(2)} s</div>
                    <div className="k">衰减到 -40dB 用时</div>
                    <div className="hint">延音/混响拖尾参考</div>
                  </div>
                  <div className="metric">
                    <div className="v">{report.centroid.toFixed(0)} Hz</div>
                    <div className="k">频谱质心(亮度)</div>
                    <div className="hint">{prevReport && (report.centroid > prevReport.centroid * 1.1 ? '↑ 比上次更亮' : report.centroid < prevReport.centroid * 0.9 ? '↓ 比上次更暗' : '与上次相近')}</div>
                  </div>
                  <div className="metric">
                    <div className="v">{report.rolloff.toFixed(0)} Hz</div>
                    <div className="k">85% 能量滚降点</div>
                  </div>
                  <div className="metric">
                    <div className="v">{report.flatness.toFixed(3)}</div>
                    <div className="k">频谱平坦度</div>
                    <div className="hint">越低越"有音高感",越高越接近噪声</div>
                  </div>
                </div>
                {prevReport && (
                  <div className="muted small mt">已保留上一次分析用于对比;再次录音会覆盖"上次"。</div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

// ---- 画图 ----

const F_MIN = 60
const F_MAX = 8000

function freqToX(freq: number, w: number): number {
  const t = Math.log2(freq / F_MIN) / Math.log2(F_MAX / F_MIN)
  return Math.max(0, Math.min(1, t)) * w
}

function drawSpectrum(canvas: HTMLCanvasElement | null, an: AnalyserNode, data: Uint8Array) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, w, h)
  const nyquist = an.context.sampleRate / 2
  const bars = 96
  for (let b = 0; b < bars; b++) {
    const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / bars)
    const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / bars)
    const i0 = Math.floor((f0 / nyquist) * data.length)
    const i1 = Math.max(i0 + 1, Math.floor((f1 / nyquist) * data.length))
    let m = 0
    for (let i = i0; i < i1 && i < data.length; i++) m = Math.max(m, data[i])
    const x = (b / bars) * w
    const bw = w / bars - 1
    const bh = (m / 255) * (h - 24)
    ctx.fillStyle = `hsl(${170 - (m / 255) * 60}, 65%, ${30 + (m / 255) * 32}%)`
    ctx.fillRect(x, h - 18 - bh, bw, bh)
  }
  ctx.fillStyle = '#667086'
  ctx.font = '10px sans-serif'
  for (const f of [100, 200, 500, 1000, 2000, 5000]) {
    const x = freqToX(f, w)
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x - 8, h - 5)
    ctx.fillRect(x, h - 18, 1, 4)
  }
}

function drawWaterfall(canvas: HTMLCanvasElement | null, an: AnalyserNode, data: Uint8Array) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height
  // 关闭平滑:左移操作逐帧高斯化会让画面越来越糊
  ctx.imageSmoothingEnabled = false
  // 左移一像素
  ctx.drawImage(canvas, -1, 0)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(w - 1, 0, 1, h)
  const nyquist = an.context.sampleRate / 2
  for (let y = 0; y < h; y++) {
    // 从上(高频)到下(低频),对数刻度
    const f = F_MAX * Math.pow(F_MIN / F_MAX, y / h)
    const idx = Math.min(data.length - 1, Math.floor((f / nyquist) * data.length))
    const v = data[idx] / 255
    if (v > 0.03) {
      ctx.fillStyle = `hsl(${170 - v * 60}, 70%, ${10 + v * 55}%)`
      ctx.fillRect(w - 1, y, 1, 1)
    }
  }
}
