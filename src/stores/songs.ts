// 曲库:扒谱结果保存/加载(localStorage)
import type { TabNote } from '../transcription/fingering'

export interface SavedSong {
  id: string
  name: string
  bpm: number
  tuningId: string
  notes: TabNote[]
  updatedAt: number
  grid?: 12 | 16 // 步进网格:12 = 每拍 12 细分(新);缺省/16 = 旧版每拍 4 细分,加载时 ×3 迁移
}

const KEY = 'gm-songs'

export function loadSongs(): SavedSong[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(arr) ? (arr as SavedSong[]) : []
  } catch {
    return []
  }
}

function saveAll(songs: SavedSong[]) {
  localStorage.setItem(KEY, JSON.stringify(songs))
}

export function saveSong(name: string, bpm: number, tuningId: string, notes: TabNote[], grid: 12 | 16 = 12): SavedSong[] {
  const cleanName = name.trim() || `曲谱 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
  const songs = loadSongs()
  const song: SavedSong = {
    id: `s${Date.now()}${Math.floor(Math.random() * 1000)}`,
    name: cleanName,
    bpm,
    tuningId,
    notes,
    updatedAt: Date.now(),
    grid,
  }
  // 同名覆盖(更新时间):自动保存/重新识别不会堆重复条目
  const idx = songs.findIndex((s) => s.name === cleanName)
  if (idx >= 0) songs.splice(idx, 1)
  songs.unshift(song)
  // 最多保留 30 首,防超 localStorage 配额
  saveAll(songs.slice(0, 30))
  return loadSongs()
}

export function deleteSong(id: string): SavedSong[] {
  saveAll(loadSongs().filter((s) => s.id !== id))
  return loadSongs()
}

export function renameSong(id: string, name: string): SavedSong[] {
  saveAll(loadSongs().map((s) => (s.id === id ? { ...s, name, updatedAt: Date.now() } : s)))
  return loadSongs()
}

/** 导出全部曲库为 JSON(跨浏览器/设备转移) */
export function exportLibrary(): string {
  return JSON.stringify({ version: 1, songs: loadSongs() }, null, 0)
}

/** 导入曲库 JSON(合并,同名覆盖) */
export function importLibrary(json: string): SavedSong[] {
  const data = JSON.parse(json) as { songs?: SavedSong[] }
  if (!Array.isArray(data.songs)) throw new Error('文件格式不正确(缺少 songs 字段)')
  const existing = loadSongs()
  for (const s of data.songs) {
    if (!s.name || !Array.isArray(s.notes)) continue // 跳过无效条目
    const idx = existing.findIndex((e) => e.name === s.name)
    if (idx >= 0) existing.splice(idx, 1)
    existing.push(s)
  }
  saveAll(existing.slice(0, 30))
  return loadSongs()
}
