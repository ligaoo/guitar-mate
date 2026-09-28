// 自动扒谱页:导入/录音 → 识别(DSP 或 Basic Pitch)→ 量化/指法 → 六线谱编辑 → 试听 → 导出/曲库
import { useEffect, useMemo, useRef, useState } from 'react'
import { MicRecorder, decodeFile } from '../audio/recorder'
import type { TranscribeResult } from '../transcription/pipeline'
import { assignFingering, type TabNote, type DroppedNote } from '../transcription/fingering'
import { tabToText, tabToMidi, downloadBlob } from '../transcription/exporters'
import { transcribeWithBasicPitch } from '../transcription/basicPitch'
import TabView from '../components/TabView'
import { GuitarSynth } from '../audio/synth'
import { getCtx, getMaster } from '../audio/engine'
import { TUNINGS, STANDARD_TUNING } from '../theory/tunings'
import { loadSongs, saveSong, deleteSong, type SavedSong } from '../stores/songs'

// 每拍 12 细分:直 16 分=3 格、三连 8 分=4 格、三连 16 分=2 格 —— 同一整数网格支持直音与三连音
const SUBDIV = 12
const DUR_CYCLE = [3, 4, 6, 12, 24, 48] // 16分 → 3连8分 → 8分 → 4分 → 2分 → 全音符
const SNAP_DURS = [2, 3, 4, 6, 8, 9, 12, 16, 18, 24, 32, 36, 48]

type Status = 'idle' | 'working' | 'done' | 'error'
type Engine = 'dsp' | 'bp'

export default function TranscribePage() {
  const [audio, setAudio] = useState<AudioBuffer | null>(null)
  const [fileName, setFileName] = useState('')
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [result, setResult] = useState<TranscribeResult | null>(null)
  const [rawNotes, setRawNotes] = useState<TranscribeResult['notes']>([])

  const [engine, setEngine] = useState<Engine>('dsp')
  const [bpProgress, setBpProgress] = useState<number | null>(null)
  const [bpStage, setBpStage] = useState<'model' | 'infer' | 'notes' | null>(null)
  const [bpBackend, setBpBackend] = useState('')
  const [onsetThresh, setOnsetThresh] = useState(0.35)
  const [frameThresh, setFrameThresh] = useState(0.2)
  const [ghostFilter, setGhostFilter] = useState(true)
  const [visibleBars, setVisibleBars] = useState(8)

  // 响度过滤默认值随引擎切换:BP 的 amplitude≈响度,真实歌曲大量音符低于 0.55,
  // 会被整段删掉(实测 1151 音符只剩 80);DSP 的置信度保持 0.55
  const switchEngine = (e: Engine) => {
    setEngine(e)
    setMinConf(e === 'bp' ? 0.25 : 0.55)
  }

  const [bpm, setBpm] = useState(90)
  const [offsetSteps, setOffsetSteps] = useState(0)
  const [minConf, setMinConf] = useState(0.55)
  const [maxFret, setMaxFret] = useState(15)
  const [tuningId, setTuningId] = useState('standard')

  const [notes, setNotes] = useState<TabNote[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [penFret, setPenFret] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playheadStep, setPlayheadStep] = useState<number | null>(null)
  const [speed, setSpeed] = useState(1)
  const [metronome, setMetronome] = useState(false)

  const [songs, setSongs] = useState<SavedSong[]>(() => loadSongs())
  const [loadedSongName, setLoadedSongName] = useState<string | null>(null)
  const [droppedNotes, setDroppedNotes] = useState<DroppedNote[]>([])
  const [staleParams, setStaleParams] = useState(false)
  const [srcPlaying, setSrcPlaying] = useState(false)
  const [swingInfo, setSwingInfo] = useState<string | null>(null)
  // A/B 片段
  const [segStart, setSegStart] = useState(0)
  const [segLen, setSegLen] = useState(4)
  const [looping, setLooping] = useState(false)
  const [abPlaying, setAbPlaying] = useState(false)
  const dirtyRef = useRef(false) // 有手工编辑时,参数变化不再自动重建
  const shiftRef = useRef(0) // 量化时的整体归一偏移(谱面 step ↔ 原音频时间的换算)
  const autoSaveRef = useRef(false) // 识别成功后自动保存到曲库
  const autoNameRef = useRef('')
  const abTimerRef = useRef(0)

  const recRef = useRef<MicRecorder | null>(null)
  const recTimerRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const nextIdRef = useRef(1)
  const stopNodesRef = useRef<{ stop: (t: number) => void }[]>([])
  const rafRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const srcNodeRef = useRef<AudioBufferSourceNode | null>(null)
  const loopRef = useRef<AudioBufferSourceNode | null>(null)

  const tuning = TUNINGS.find((t) => t.id === tuningId)?.midi ?? STANDARD_TUNING

  /** 用音符起点序列细化 BPM:在估计值 ½–2 倍范围搜索,字典序目标——
   *  ① 最优 60% 残差(RANSAC 式抗离群:伪起音造成的错位音不参与)尽量小;
   *  ② 残差近最优(≤ 最优×1.5 + 0.02)的候选里取最接近初估者;③ 间隔 <2 格硬淘汰。
   *  纯残差评分会退化地偏向慢速或任意倍速(均匀节奏在多个 BPM 下都是整数格),先验做最终裁决。 */
  const refineBpm = (starts: number[], bpm0: number): number => {
    if (starts.length < 4) return bpm0
    const t0 = starts[0]
    const evalAt = (c: number) => {
      const g = 60 / c / SUBDIV
      const residuals: number[] = []
      const rounded: number[] = []
      for (const t of starts) {
        const r = (t - t0) / g
        residuals.push(Math.abs(r - Math.round(r)))
        rounded.push(Math.round(r))
      }
      residuals.sort((a, b) => a - b)
      const k = Math.max(3, Math.floor(residuals.length * 0.6))
      const robust = residuals.slice(0, k).reduce((a, b) => a + b, 0) / k
      rounded.sort((a, b) => a - b)
      let tooClose = 0
      for (let i = 1; i < rounded.length; i++) {
        if (rounded[i] - rounded[i - 1] < 2) tooClose++
      }
      return { robust, tooClose }
    }
    // 第一轮:最小 robust(忽略 tooClose,只作基准)
    let minRobust = Infinity
    for (let c = Math.max(40, bpm0 * 0.45); c <= bpm0 * 2.1 + 1e-9; c += 0.25) {
      const { robust } = evalAt(c)
      if (robust < minRobust) minRobust = robust
    }
    // 第二轮:残差近最优 + 无 tooClose 的候选里,取最接近初估者
    let best = bpm0
    let bestPrior = Infinity
    for (let c = Math.max(40, bpm0 * 0.45); c <= bpm0 * 2.1 + 1e-9; c += 0.25) {
      const { robust, tooClose } = evalAt(c)
      if (tooClose > 0) continue
      if (robust > minRobust * 1.5 + 0.02) continue
      const prior = Math.abs(Math.log2(c / bpm0))
      if (prior < bestPrior) {
        bestPrior = prior
        best = c
      }
    }
    return Math.max(40, Math.min(220, Math.round(best)))
  }

  useEffect(
    () => () => {
      workerRef.current?.terminate()
      cancelAnimationFrame(rafRef.current)
      window.clearTimeout(abTimerRef.current)
      try {
        loopRef.current?.stop()
      } catch {
        /* ignore */
      }
      try {
        srcNodeRef.current?.stop()
      } catch {
        /* ignore */
      }
    },
    [],
  )

  // 识别进行中 / 有未保存编辑时,刷新或关闭页面前弹确认,防止误丢
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (status === 'working' || dirtyRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [status])

  // ---------- 音源 ----------

  const loadFile = async (file: File) => {
    stopPlayback()
    stopLoop()
    setStatus('idle')
    setResult(null)
    setLoadedSongName(null)
    try {
      const buf = await decodeFile(file)
      setAudio(buf)
      setFileName(`${file.name}(${buf.duration.toFixed(1)}s)`)
      setSegStart(0)
      setSegLen(Math.min(4, buf.duration))
    } catch {
      setErrMsg('无法解码该音频文件,请换 mp3/wav/m4a 格式。')
      setStatus('error')
    }
  }

  const toggleRecord = async () => {
    if (recording) {
      const rec = recRef.current
      if (!rec) return
      setRecording(false)
      window.clearInterval(recTimerRef.current)
      const buf = await rec.stop()
      recRef.current = null
      if (buf.duration < 0.5) {
        setErrMsg('录音太短,请至少录一小段。')
        setStatus('error')
        return
      }
      setAudio(buf)
      setFileName(`麦克风录音(${buf.duration.toFixed(1)}s)`)
      setStatus('idle')
      setResult(null)
      setLoadedSongName(null)
      stopLoop()
      setSegStart(0)
      setSegLen(Math.min(4, buf.duration))
    } else {
      setErrMsg('')
      try {
        const rec = new MicRecorder()
        await rec.start()
        recRef.current = rec
        setRecording(true)
        setRecSecs(0)
        const t0 = Date.now()
        recTimerRef.current = window.setInterval(() => setRecSecs((Date.now() - t0) / 1000), 200)
      } catch (e) {
        setErrMsg('无法访问麦克风:' + String(e))
        setStatus('error')
      }
    }
  }

  const playSource = () => {
    if (srcNodeRef.current) {
      // 再次点击 = 停止,避免多次叠加
      try {
        srcNodeRef.current.stop()
      } catch {
        /* 已停 */
      }
      srcNodeRef.current = null
      setSrcPlaying(false)
      return
    }
    if (!audio) return
    const ctx = getCtx()
    const src = ctx.createBufferSource()
    src.buffer = audio
    src.connect(getMaster()) // 走主音量/限幅器,不再直连 destination
    src.onended = () => {
      if (srcNodeRef.current === src) {
        srcNodeRef.current = null
        setSrcPlaying(false)
      }
    }
    src.start()
    srcNodeRef.current = src
    setSrcPlaying(true)
  }

  // ---------- 识别 ----------

  const runTranscribe = async () => {
    if (!audio) return
    stopPlayback()
    setErrMsg('')
    setStatus('working')
    setLoadedSongName(null)
    if (engine === 'bp') {
      setBpProgress(0)
      setBpStage('model')
      try {
        const r = await transcribeWithBasicPitch(
          audio,
          { onsetThresh, frameThresh, removeOctaveGhosts: ghostFilter },
          (p) => setBpProgress(p),
          (stage, info) => {
            setBpStage(stage)
            if (info) setBpBackend(info)
          },
        )
        if (r.notes.length === 0) {
          setStatus('error')
          setErrMsg('Basic Pitch 没有识别出音符。可尝试调高灵敏度(降低起音阈值)后重试。')
          return
        }
        setResult(r)
        setRawNotes(r.notes)
        setBpm(refineBpm(r.notes.map((n) => n.start), r.bpm))
        autoSaveRef.current = true
        autoNameRef.current = fileName.replace(/\(\d+(\.\d+)?s\)$/, '').trim() || '识别结果'
        setVisibleBars(8)
        setStatus('done')
      } catch (e) {
        setStatus('error')
        const msg = String(e)
        if (msg.includes('WEBGL_HANG') || msg.includes('超时')) {
          setErrMsg('AI 推理超时:已依次尝试 Worker-GPU、页面内 GPU 与 CPU 均未在时限内出结果。建议:① 用片段功能截取 1-2 分钟再扒;② 或改用内置 DSP 引擎。')
        } else {
          setErrMsg('Basic Pitch 引擎出错:' + msg + '。可切回内置 DSP 引擎重试。')
        }
      } finally {
        setBpProgress(null)
        setBpStage(null)
      }
      return
    }
    // 内置 DSP 管线(Web Worker)
    setBpProgress(null)
    setBpStage(null)
    workerRef.current?.terminate()
    const worker = new Worker(new URL('../transcription/worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'done') {
        const r = e.data.result as TranscribeResult
        worker.terminate()
        workerRef.current = null
        if (r.notes.length === 0) {
          setStatus('error')
          setErrMsg('没有识别出音符。建议:更接近吉他、单音旋律、减少背景噪声;或切换 Basic Pitch 引擎识别复音。')
          return
        }
        setResult(r)
        setRawNotes(r.notes)
        setBpm(refineBpm(r.notes.map((n) => n.start), r.bpm))
        autoSaveRef.current = true
        autoNameRef.current = fileName.replace(/\(\d+(\.\d+)?s\)$/, '').trim() || '识别结果'
        setVisibleBars(8)
        setStatus('done')
      } else if (e.data.type === 'error') {
        worker.terminate()
        workerRef.current = null
        setStatus('error')
        setErrMsg('分析出错:' + e.data.message)
      }
    }
    const ch = audio.getChannelData(0).slice()
    worker.postMessage({ type: 'transcribe', channel: ch, sampleRate: audio.sampleRate }, [ch.buffer])
  }

  // ---------- 量化 + 指法 ----------

  const rebuild = () => {
    if (!result) return
    const gridSec = 60 / bpm / SUBDIV
    const anchor = result.offset - offsetSteps * gridSec
    const filtered = rawNotes.filter((n) => n.confidence >= minConf)
    const q: { midi: number; step: number; dur: number }[] = []
    for (const n of filtered) {
      // 不 clamp 到 0:起音检测滞后时音符可以在锚点之前(往左对齐的物理基础)
      const step = Math.round((n.start - anchor) / gridSec)
      let dur = Math.round((n.end - n.start) / gridSec)
      dur = SNAP_DURS.reduce((best, d) => (Math.abs(d - dur) < Math.abs(best - dur) ? d : best), 3)
      dur = Math.max(2, dur)
      q.push({ midi: n.midi, step, dur })
    }
    q.sort((a, b) => a.step - b.step)
    // 去掉完全同 step 同 midi 的重复
    const dedup = q.filter((n, i) => !(i > 0 && n.step === q[i - 1].step && n.midi === q[i - 1].midi))
    // 负步整体归一:最早音符落在 step 0(渲染层不支持负步)
    const shift = Math.min(0, ...dedup.map((n) => n.step))
    shiftRef.current = shift
    const shifted0 = shift < 0 ? dedup.map((n) => ({ ...n, step: n.step - shift })) : dedup
    // 步进吸附清理:±1 格内吸附到最近的直音(3 的倍数)或三连音(4 的倍数)网格,消除检测抖动
    const shifted = shifted0.map((n) => {
      const near3 = Math.round(n.step / 3) * 3
      const near4 = Math.round(n.step / 4) * 4
      const d3 = Math.abs(n.step - near3)
      const d4 = Math.abs(n.step - near4)
      let step = n.step
      if (d3 <= 1 && d3 < d4) step = near3
      else if (d4 <= 1 && d4 <= d3) step = near4
      return { ...n, step }
    })
    // 吸附后可能撞出重复(同 step 同 midi),再去重
    const dedup2 = shifted.filter((n, i) => !(i > 0 && n.step === shifted[i - 1].step && n.midi === shifted[i - 1].midi))
    // swing/shuffle 检测:拍内位置(模 12)集中于 7-9(三连音反拍)即有 swing 感
    const modCounts = new Array(SUBDIV).fill(0)
    for (const n of dedup2) modCounts[((n.step % SUBDIV) + SUBDIV) % SUBDIV]++
    const totalN = dedup2.length
    const swung = modCounts[7] + modCounts[8] + modCounts[9]
    if (totalN >= 6 && swung / totalN >= 0.25) {
      const mode = [7, 8, 9].reduce((a, b) => (modCounts[b] > modCounts[a] ? b : a), 7)
      setSwingInfo(
        mode === 8
          ? '检测到 shuffle/swing 节奏(反拍落在三连音位置,≈67%)—— 12 细分网格已自动对齐三连音'
          : `检测到轻微 swing(反拍偏移至 ${Math.round((mode / 6) * 100)}%)`,
      )
    } else {
      setSwingInfo(null)
    }
    const { notes: tab, dropped } = assignFingering(dedup2, tuning, maxFret)
    nextIdRef.current = tab.length + 1
    setNotes(tab)
    setDroppedNotes(dropped)
    setSelectedId(null)
    dirtyRef.current = false
    setStaleParams(false)
    // 识别成功后的第一次重建 → 自动保存到曲库(同名覆盖),刷新/切页不再丢结果
    if (autoSaveRef.current) {
      autoSaveRef.current = false
      setSongs(saveSong(autoNameRef.current, bpm, tuningId, tab, SUBDIV))
    }
  }

  // 参数变化:无手工编辑 → 自动重建;有手工编辑 → 仅标记过期,等用户确认(不再静默丢弃编辑)
  useEffect(() => {
    if (!result) return
    if (dirtyRef.current) {
      setStaleParams(true)
      return
    }
    rebuild()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, bpm, offsetSteps, minConf, maxFret, tuningId])

  const totalSteps = useMemo(
    () => Math.max(48, ...notes.map((n) => n.step + n.dur)),
    [notes],
  )
  // 长谱分页渲染:默认只渲染前 N 小节(每小节 48 格 × 6 弦的交互热区会让 DOM 爆炸)
  const totalBars = Math.max(1, Math.ceil(totalSteps / 48))
  const visibleNotes = useMemo(
    () => notes.filter((n) => n.step < visibleBars * 48),
    [notes, visibleBars],
  )
  const visibleSteps = Math.min(totalSteps, visibleBars * 48)
  const avgConf = useMemo(
    () => (rawNotes.length ? rawNotes.reduce((s, n) => s + n.confidence, 0) / rawNotes.length : 0),
    [rawNotes],
  )

  // ---------- 编辑(任何手工编辑都会置脏,参数变化不再自动覆盖) ----------

  const markDirty = () => {
    dirtyRef.current = true
  }

  const updateNote = (id: number, patch: Partial<TabNote>) => {
    markDirty()
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }

  const shiftString = (dir: number) => {
    if (selectedId === null) return
    const n = notes.find((x) => x.id === selectedId)
    if (!n) return
    const ns = n.string + dir
    if (ns < 0 || ns >= tuning.length) return
    const fret = n.midi - tuning[ns]
    if (fret < 0 || fret > maxFret) return
    updateNote(n.id, { string: ns, fret })
  }

  const cycleDur = () => {
    if (selectedId === null) return
    const n = notes.find((x) => x.id === selectedId)
    if (!n) return
    const i = DUR_CYCLE.indexOf(n.dur)
    updateNote(n.id, { dur: DUR_CYCLE[(i + 1 + DUR_CYCLE.length) % DUR_CYCLE.length] })
  }

  const deleteSelected = () => {
    if (selectedId === null) return
    markDirty()
    setNotes((ns) => ns.filter((n) => n.id !== selectedId))
    setSelectedId(null)
  }

  const insertAt = (step: number, string: number) => {
    if (penFret === null) {
      setSelectedId(null)
      return
    }
    const midi = tuning[string] + penFret
    const id = nextIdRef.current++
    markDirty()
    setNotes((ns) => [...ns, { id, step, dur: 6, midi, string, fret: penFret }].sort((a, b) => a.step - b.step))
    setSelectedId(id)
  }

  // ---------- 曲库 ----------

  const saveCurrent = () => {
    if (notes.length === 0) return
    const name = window.prompt('曲谱名称:', (loadedSongName ?? fileName.replace(/\(.*$/, '')) || '未命名')
    if (name === null) return
    setSongs(saveSong(name, bpm, tuningId, notes, SUBDIV))
    setLoadedSongName(name)
  }

  const loadSong = (s: SavedSong) => {
    stopPlayback()
    stopLoop()
    setBpm(s.bpm)
    setTuningId(s.tuningId)
    setResult(null)
    setRawNotes([])
    setStatus('done')
    setLoadedSongName(s.name)
    setDroppedNotes([])
    setSwingInfo(null)
    dirtyRef.current = false
    setStaleParams(false)
    // 旧曲库(每拍 4 细分)迁移到 12 细分:步数/时值 ×3
    const mult = s.grid === SUBDIV ? 1 : 3
    const restored = s.notes.map((n, i) => ({ ...n, id: i + 1, step: n.step * mult, dur: n.dur * mult }))
    setVisibleBars(8)
    nextIdRef.current = restored.length + 1
    setNotes(restored)
    setSelectedId(null)
  }

  const removeSong = (id: string) => {
    if (!confirm('删除这首曲谱?')) return
    setSongs(deleteSong(id))
  }

  // ---------- 试听 ----------

  const stopPlayback = () => {
    cancelAnimationFrame(rafRef.current)
    const t = getCtx().currentTime
    stopNodesRef.current.forEach((n) => {
      try {
        n.stop(t)
      } catch {
        /* 已停 */
      }
    })
    stopNodesRef.current = []
    setPlaying(false)
    setPlayheadStep(null)
  }

  const playTab = () => {
    if (playing) {
      stopPlayback()
      return
    }
    if (notes.length === 0) return
    stopLoop()
    stopAB()
    const ctx = getCtx()
    const stepDur = 60 / bpm / SUBDIV / speed
    const t0 = ctx.currentTime + 0.12
    const nodes: { stop: (t: number) => void }[] = []
    for (const n of notes) {
      const node = GuitarSynth.pluckMidi(n.midi, {
        when: t0 + n.step * stepDur,
        dur: Math.max(0.25, n.dur * stepDur),
        gain: 0.4,
      })
      nodes.push(node)
    }
    if (metronome) {
      for (let s = 0; s < totalSteps; s += SUBDIV) {
        nodes.push(GuitarSynth.click(t0 + s * stepDur, s % 48 === 0, 0.28))
      }
    }
    stopNodesRef.current = nodes
    setPlaying(true)
    // 多留 150ms 尾部,长音不被 stop() 掐掉
    const endTime = t0 + totalSteps * stepDur + 0.15
    const tick = () => {
      const t = ctx.currentTime
      if (t >= endTime) {
        stopPlayback()
        return
      }
      setPlayheadStep(Math.floor((t - t0) / stepDur))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // ---------- 导出 ----------

  const exportText = () => downloadBlob(tabToText(notes), 'guitarmate-tab.txt', 'text/plain;charset=utf-8')
  const exportMidi = () => downloadBlob(tabToMidi(notes, bpm), 'guitarmate.mid', 'audio/midi')

  const selected = notes.find((n) => n.id === selectedId) ?? null

  // ---------- A/B 片段循环与对比 ----------

  const stopLoop = () => {
    if (loopRef.current) {
      try {
        loopRef.current.stop()
      } catch {
        /* 已停 */
      }
      loopRef.current = null
    }
    setLooping(false)
  }

  const toggleLoop = () => {
    if (loopRef.current) {
      stopLoop()
      return
    }
    if (!audio) return
    const ctx = getCtx()
    const src = ctx.createBufferSource()
    src.buffer = audio
    src.loop = true
    src.loopStart = segStart
    src.loopEnd = Math.min(segStart + segLen, audio.duration)
    src.connect(getMaster())
    src.start(0, segStart)
    loopRef.current = src
    setLooping(true)
  }

  const stopAB = () => {
    window.clearTimeout(abTimerRef.current)
    const t = getCtx().currentTime
    stopNodesRef.current.forEach((n) => {
      try {
        n.stop(t)
      } catch {
        /* 已停 */
      }
    })
    stopNodesRef.current = []
    setAbPlaying(false)
  }

  /** A/B 对比:原音频片段 → 同一时间段的谱面合成,背靠背两轮,用于核对扒谱 */
  const playAB = () => {
    if (!audio || !result) return
    stopPlayback()
    stopLoop()
    const ctx = getCtx()
    const grid = 60 / bpm / SUBDIV
    const anchor = result.offset - offsetSteps * grid
    const segEnd = Math.min(segStart + segLen, audio.duration)
    const t0 = ctx.currentTime + 0.15
    const nodes: { stop: (t: number) => void }[] = []
    const REPS = 2
    const gapA = 0.5 // A 结束到 B 开始
    const gapB = 0.9 // 一轮结束到下一轮
    const cycle = segLen + gapA + segLen + gapB
    for (let rep = 0; rep < REPS; rep++) {
      const repOff = rep * cycle
      // A:原音频片段
      const sA = ctx.createBufferSource()
      sA.buffer = audio
      sA.connect(getMaster())
      sA.start(t0 + repOff, segStart, segLen)
      nodes.push(sA)
      // B:谱面合成(按原音频时间轴对齐同一时间段)
      for (const n of notes) {
        const tNote = anchor + (n.step + shiftRef.current) * grid
        if (tNote < segStart - 0.05 || tNote >= segEnd) continue
        const when = t0 + repOff + segLen + gapA + (tNote - segStart)
        nodes.push(GuitarSynth.pluckMidi(n.midi, { when, dur: Math.max(0.25, n.dur * grid), gain: 0.4 }))
      }
    }
    stopNodesRef.current = [...stopNodesRef.current, ...nodes]
    setAbPlaying(true)
    abTimerRef.current = window.setTimeout(() => setAbPlaying(false), (REPS * cycle + 0.5) * 1000)
  }

  /** 把 A/B 片段定位到选中音符对应的原音频时间 */
  const focusSelected = () => {
    const n = notes.find((x) => x.id === selectedId)
    if (!n || !result) return
    const grid = 60 / bpm / SUBDIV
    const anchor = result.offset - offsetSteps * grid
    const t = anchor + (n.step + shiftRef.current) * grid
    setSegStart(Math.max(0, t - 0.3))
    setSegLen(2)
  }

  return (
    <>
      <div className="card">
        <div className="source-row">
          <input ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f) }} />
          <button className="btn" onClick={() => fileInputRef.current?.click()}>📁 导入音频</button>
          <button className={`btn ${recording ? 'danger' : ''}`} onClick={toggleRecord}>
            {recording ? <><span className="rec-dot" />停止 ({recSecs.toFixed(0)}s)</> : '🎤 录音'}
          </button>
          {audio && (
            <>
              <button className="btn ghost" onClick={playSource}>{srcPlaying ? '■ 停止原音频' : '▶ 试听原音频'}</button>
              <span className="muted small">{fileName}</span>
            </>
          )}
          <div className="spacer" />
          <button className="btn primary" disabled={!audio || status === 'working'} onClick={runTranscribe}>
            {status === 'working'
              ? bpStage === 'model'
                ? `⏳ 初始化 AI 引擎${bpBackend ? `(${bpBackend.startsWith('cpu') ? 'CPU' : bpBackend})` : '…'}`
                : bpStage === 'notes'
                  ? '⏳ 提取音符中…'
                  : bpProgress !== null
                    ? `⏳ AI 推理 ${(bpProgress * 100).toFixed(0)}%${bpBackend.startsWith('cpu') ? '(CPU)' : ''}`
                    : '⏳ 分析中…'
              : '✨ 开始扒谱'}
          </button>
        </div>
        <div className="row mt">
          <div className="chip-row">
            <button className={`chip${engine === 'dsp' ? ' active' : ''}`} onClick={() => switchEngine('dsp')}
              title="纯信号处理,零模型加载,适合单音旋律">⚡ 内置 DSP(离线 · 单音)</button>
            <button className={`chip${engine === 'bp' ? ' active' : ''}`} onClick={() => switchEngine('bp')}
              title="Spotify Basic Pitch 神经网络,支持和弦等复音;首次使用需加载 AI 引擎(约 2MB,之后有缓存)">🧠 Basic Pitch(复音 · AI)</button>
          </div>
          {engine === 'bp' && (
            <>
              <label className="field">起音阈值 {onsetThresh.toFixed(2)}(识别过多调高)
                <input type="range" min="0.2" max="0.7" step="0.05" value={onsetThresh}
                  onChange={(e) => setOnsetThresh(parseFloat(e.target.value))} style={{ width: 150 }} />
              </label>
              <label className="field">延音阈值 {frameThresh.toFixed(2)}(尾音拖长调高)
                <input type="range" min="0.08" max="0.5" step="0.02" value={frameThresh}
                  onChange={(e) => setFrameThresh(parseFloat(e.target.value))} style={{ width: 150 }} />
              </label>
              <button className={`chip${ghostFilter ? ' active' : ''}`} onClick={() => setGhostFilter(!ghostFilter)}
                title="模型常见幻觉:同一时间多出高/低八度的音。单旋律保持开启;和弦含真八度时关闭">
                八度重影过滤{ghostFilter ? '开' : '关'}
              </button>
            </>
          )}
        </div>
        {status === 'error' && <div className="warn-box mt">{errMsg}</div>}
        {status === 'working' && (
          <div className="muted small mt">
            {engine === 'bp'
              ? bpStage === 'notes'
                ? '推理完成,正在提取音符——长音频的音符提取可能需要一两分钟,推理与提取都在后台 Worker 进行,页面不会被卡住。'
                : `Basic Pitch 复音识别中:${fileName}。首次运行需初始化 AI 引擎,之后会快很多。`
              : `正在分析:${fileName}(起音检测 → 逐帧音高 → 音符分割 → 节拍量化)。长音频可能需要几十秒。`}
          </div>
        )}
        {engine === 'bp' && audio && audio.duration > 240 && status !== 'done' && (
          <div className="warn-box mt">
            音频较长({Math.round(audio.duration / 60)} 分钟):AI 推理与音符提取耗时随长度增长,建议先用下方「片段」功能截取 1-2 分钟分段扒谱,再逐段核对。
          </div>
        )}
      </div>

      {audio && (
        <div className="card">
          <h3>🎧 片段循环 / A-B 对比{abPlaying ? ' · 播放中…' : ''}</h3>
          <div className="row">
            <label className="field">片段起点 {segStart.toFixed(1)}s
              <input type="range" min={0} max={Math.max(0.5, audio.duration - 0.5)} step={0.1} value={segStart}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setSegStart(v)
                  setSegLen(Math.min(segLen, audio.duration - v))
                }} style={{ width: 150 }} />
            </label>
            <label className="field">长度 {segLen.toFixed(1)}s
              <input type="range" min={0.5} max={Math.max(0.6, Math.min(8, audio.duration - segStart))} step={0.1} value={segLen}
                onChange={(e) => setSegLen(parseFloat(e.target.value))} style={{ width: 130 }} />
            </label>
            <button className={`btn ${looping ? 'primary playing' : ''}`} onClick={toggleLoop}>
              {looping ? '■ 停止循环' : '🔁 循环原片段'}
            </button>
            {result && (
              <button className={`btn ${abPlaying ? 'primary playing' : ''}`} onClick={abPlaying ? stopAB : playAB}>
                {abPlaying ? '■ 停止对比' : '⇄ A/B 对比'}
              </button>
            )}
            {result && selected && (
              <button className="btn sm" onClick={focusSelected} title="把片段定位到选中音符对应的原音频位置">🎯 定位选中音</button>
            )}
          </div>
          <div className="muted small mt">
            A/B 对比 = 先播原音频片段、紧接播放谱面合成(背靠背两轮),用于核对扒谱是否准确;循环原片段适合跟练。
            {result ? '选中谱面音符后可一键定位片段。' : '(识别后可用对比功能)'}
          </div>
        </div>
      )}

      {songs.length > 0 && (
        <div className="card">
          <h3>📚 曲库({songs.length})</h3>
          <div className="chip-row">
            {songs.map((s) => (
              <span key={s.id} className={`chip${loadedSongName === s.name ? ' active' : ''}`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span style={{ cursor: 'pointer' }} onClick={() => loadSong(s)}
                  title={`${s.bpm} BPM · ${s.notes.length} 音符 · ${new Date(s.updatedAt).toLocaleString('zh-CN')} · 点击加载`}>
                  {s.name} · {s.bpm}bpm · {new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ cursor: 'pointer', color: 'var(--err)' }} onClick={() => removeSong(s.id)} title="删除">×</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {status === 'done' && (
        <>
          {result ? (
            <div className="card">
              <div className="row">
                <label className="field">BPM
                  <input type="number" min="40" max="220" value={bpm}
                    onChange={(e) => setBpm(Math.max(40, Math.min(220, parseInt(e.target.value) || 90)))} style={{ width: 76 }} />
                </label>
                <label className="field">整体左右移动
                  <div className="row">
                    <button className="btn sm" onClick={() => setOffsetSteps(offsetSteps - 1)}>◀</button>
                    <span className="chip">{offsetSteps === 0 ? '未偏移' : `${offsetSteps > 0 ? '+' : ''}${offsetSteps} 步`}</span>
                    <button className="btn sm" onClick={() => setOffsetSteps(offsetSteps + 1)}>▶</button>
                  </div>
                </label>
                <label className="field">{engine === 'bp' ? `响度 ≥ ${minConf.toFixed(2)}` : `置信度 ≥ ${minConf.toFixed(2)}`}
                  <input type="range" min="0.3" max="0.95" step="0.05" value={minConf}
                    onChange={(e) => setMinConf(parseFloat(e.target.value))} style={{ width: 130 }} />
                </label>
                <label className="field">最高品
                  <select value={maxFret} onChange={(e) => setMaxFret(parseInt(e.target.value))}>
                    {[12, 15, 18, 22].map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
                <label className="field">调弦
                  <select value={tuningId} onChange={(e) => setTuningId(e.target.value)}>
                    {TUNINGS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="muted small mt">
                识别到 {rawNotes.length} 个音符{engine === 'bp' ? '(复音,含同时发声;响度过滤会删掉弱奏音,慎用)' : ''} · 平均置信度 {(avgConf * 100).toFixed(0)}% · 建议先核对节奏(用◀▶对齐第一拍)。结果<b>已自动保存到下方曲库</b>(同名覆盖),刷新不丢;调整参数会重建谱面并更新曲库。
              </div>
              {swingInfo && (
                <div className="mt" style={{ background: 'rgba(124,108,240,0.1)', border: '1px solid rgba(124,108,240,0.35)', borderRadius: 10, padding: '8px 12px', color: 'var(--accent2)', fontSize: 13 }}>
                  ♪ {swingInfo}
                </div>
              )}
              {result.likelyPolyphonic && (
                <div className="warn-box mt">
                  ⚠ 疑似复音输入(和弦/双音):DSP 引擎每个起音只取一个音,结果不可靠。建议切换上方 <b>🧠 Basic Pitch</b> 引擎重新识别。
                </div>
              )}
              {droppedNotes.length > 0 && (
                <div className="warn-box mt">
                  ⚠ 有 {droppedNotes.length} 个音无法安排到指板({droppedNotes.filter((d) => d.reason === 'range').length} 个超出音域、{droppedNotes.filter((d) => d.reason === 'conflict').length} 个同弦冲突),已丢弃。可调高「最高品」或更换调弦后重建。
                </div>
              )}
              {staleParams && (
                <div className="row mt" style={{ background: 'rgba(240,180,92,0.08)', border: '1px solid rgba(240,180,92,0.3)', borderRadius: 10, padding: '8px 12px' }}>
                  <span className="muted small">参数已变化,当前谱面含手工编辑</span>
                  <div className="spacer" />
                  <button className="btn sm primary" onClick={rebuild}>应用参数并重建(丢弃编辑)</button>
                </div>
              )}
            </div>
          ) : (
            <div className="card">
              <div className="muted small">
                已从曲库加载:<b>{loadedSongName}</b> · {bpm} BPM · {notes.length} 音符。可直接试听/编辑/导出;重新扒谱会替换当前谱面。
              </div>
            </div>
          )}

          <div className="card">
            <h3>🎼 六线谱(点击音符选中编辑)</h3>
            <div className="edit-toolbar">
              <button className={`btn ${playing ? 'primary playing' : 'primary'}`} onClick={playTab}>
                {playing ? '■ 停止' : '▶ 播放谱面'}
              </button>
              <label className="field">速度 {speed.toFixed(2)}x
                <input type="range" min="0.4" max="1" step="0.05" value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))} style={{ width: 110 }} />
              </label>
              <button className={`chip${metronome ? ' active' : ''}`} onClick={() => setMetronome(!metronome)}>🥁 节拍器</button>
              <div className="spacer" />
              <span className="muted small">选中:</span>
              <button className="btn sm" disabled={!selected} onClick={() => shiftString(-1)} title="移到相邻的低音弦">弦↓</button>
              <button className="btn sm" disabled={!selected} onClick={() => shiftString(1)} title="移到相邻的高音弦">弦↑</button>
              <button className="btn sm" disabled={!selected} onClick={cycleDur}>时值切换</button>
              <button className="btn sm danger" disabled={!selected} onClick={deleteSelected}>删除</button>
            </div>
            <div className="edit-toolbar">
              <span className="pen-lbl">插入笔:</span>
              {[0, 1, 2, 3, 4, 5, 7, 9, 12].map((f) => (
                <button key={f} className={`fret-btn${penFret === f ? ' active-f' : ''}`} onClick={() => setPenFret(penFret === f ? null : f)}>
                  {f === 0 ? '○' : f}
                </button>
              ))}
              <input type="number" min="0" max="22" value={penFret ?? ''} placeholder="品"
                style={{ width: 58 }} onChange={(e) => {
                  const v = e.target.value === '' ? null : Math.max(0, Math.min(22, parseInt(e.target.value)))
                  setPenFret(v)
                }} />
              {penFret !== null && <span className="muted small">笔:第 {penFret} 品,点谱面空位插入</span>}
            </div>
            <TabView
              notes={visibleNotes}
              tuning={tuning}
              totalSteps={visibleSteps}
              selectedId={selectedId}
              playheadStep={playheadStep}
              onSelect={(id) => { setSelectedId(id); if (id !== null) setPenFret(null) }}
              onSlotClick={penFret !== null ? insertAt : undefined}
            />
            {totalBars > visibleBars && (
              <div className="row mt" style={{ justifyContent: 'center' }}>
                <button className="btn sm" onClick={() => setVisibleBars((b) => b + 8)}>显示更多小节(+8)</button>
                <button className="btn sm ghost" onClick={() => setVisibleBars(totalBars)}>显示全部 {totalBars} 小节</button>
                <span className="muted small">(为保持流畅,长谱默认只渲染前 {visibleBars} 小节;播放/导出/保存始终包含全部音符)</span>
              </div>
            )}
            <div className="row mt">
              <span className="muted small">共 {notes.length} 音符 · {Math.ceil(totalSteps / 48)} 小节</span>
              <div className="spacer" />
              <button className="btn" onClick={saveCurrent} disabled={notes.length === 0}>💾 保存到曲库</button>
              <button className="btn" onClick={exportText}>⬇ 导出文本 Tab</button>
              <button className="btn" onClick={exportMidi}>⬇ 导出 MIDI</button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
