import { useState } from 'react'
import ChordsPage from './pages/ChordsPage'
import EarTrainingPage from './pages/EarTrainingPage'
import TunerPage from './pages/TunerPage'
import TranscribePage from './pages/TranscribePage'
import TonePage from './pages/TonePage'
import PitchTracePage from './pages/PitchTracePage'
import { setMasterVolume } from './audio/engine'

type PageId = 'chords' | 'ear' | 'tuner' | 'transcribe' | 'tone' | 'pitch'

const PAGES: { id: PageId; name: string; icon: string; desc: string }[] = [
  { id: 'chords', name: '和弦图', icon: '🎸', desc: '查询和弦指法 · 试听 · 按指法反查和弦名' },
  { id: 'ear', name: '练耳', icon: '👂', desc: '音程 · 和弦 · 音阶 · 旋律 · 节奏,自适应难度' },
  { id: 'tuner', name: '调音器', icon: '🎛️', desc: '实时音高检测,支持多种调弦' },
  { id: 'transcribe', name: '自动扒谱', icon: '🎧', desc: '音频 → 六线谱,可编辑、试听、导出' },
  { id: 'tone', name: '音色分析', icon: '📊', desc: '实时频谱 · 声谱图 · 谐波与包络分析' },
  { id: 'pitch', name: '音高轨迹', icon: '📈', desc: '短录音的逐帧音高曲线,音名标注 + 音分偏差' },
]

export default function App() {
  const [page, setPage] = useState<PageId>('chords')
  const meta = PAGES.find((p) => p.id === page)!

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          🎸 <div>吉他助手<div className="sub">GuitarMate · 本地运行</div></div>
        </div>
        {PAGES.map((p) => (
          <button key={p.id} className={`nav-item${page === p.id ? ' active' : ''}`} onClick={() => setPage(p.id)}>
            <span>{p.icon}</span>
            <span className="nav-text">{p.name}</span>
          </button>
        ))}
        <div className="foot">
          <div className="vol-row">
            🎚️ 音量
            <input type="range" min="0" max="1" step="0.05" defaultValue="0.9" style={{ width: 90 }}
              onChange={(e) => setMasterVolume(parseFloat(e.target.value))} />
          </div>
          <div style={{ marginTop: 8 }}>v0.1 · 数据不出浏览器</div>
        </div>
      </aside>
      <main className="main">
        <h1 className="page-title">{meta.name}</h1>
        <p className="page-desc">{meta.desc}</p>
        {page === 'chords' && <ChordsPage />}
        {page === 'ear' && <EarTrainingPage />}
        {page === 'tuner' && <TunerPage />}
        {page === 'transcribe' && <TranscribePage />}
        {page === 'tone' && <TonePage />}
        {page === 'pitch' && <PitchTracePage />}
      </main>
    </div>
  )
}
