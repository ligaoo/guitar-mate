// 曲库:扒谱结果保存/加载(localStorage)
//
// 用户实测反馈过"扒完一刷新曲库就空了"。排查出两个真问题,都在这里修掉:
//   ① 写入没有任何 try/catch:localStorage 配额满(浏览器约 5MB)、被隐私设置禁用、
//      或数据损坏时,setItem 会抛异常 —— 异常从 saveSong 冒出去,页面却仍然显示
//      "已自动保存",用户以为存上了,刷新才发现没有。
//   ② 读取时 JSON 解析失败会静默返回空数组,把用户已有的数据当成"没有"。
// 现在的策略:
//   · 写入逐级降级(全量 → 12 首 → 4 首 → 1 首),并**如实报告**丢了几首、为什么失败;
//   · 解析失败先把原始字符串备份到 gm-songs-corrupt-<时间戳>,再返回空;
//   · 提供 probeLibraryStorage() 供 UI 解释"为什么是空的"(禁用/配额/正常)。
import type { TabNote } from '../transcription/fingering'

export interface SavedSong {
  id: string
  name: string
  bpm: number
  tuningId: string
  notes: TabNote[]
  updatedAt: number
  grid?: 12 | 16 // 步进网格:12 = 每拍 12 细分(新);缺省/16 = 旧版每拍 4 细分,加载时 ×3 迁移
  /** 来源标记:'ref' = 参考谱模式产物(人工谱 + 逐音音频验证,曲库列表标 📖)。
   *  缺省 = 本页扒谱。REF 产物在导入时由 ref-pipeline/ref-guided 写入。 */
  source?: 'ref'
}

/** 一次写入的结果:UI 必须据此显示"存上了/没存上",不能无条件宣称已保存 */
export interface SaveReport {
  ok: boolean
  /** 写入后库里实际有几首 */
  count: number
  /** 因空间不足被丢弃的旧曲目数(>0 时要在 UI 上说明) */
  dropped: number
  error?: string
}

export interface SaveResult {
  songs: SavedSong[]
  report: SaveReport
}

const KEY = 'gm-songs'
const CORRUPT_PREFIX = 'gm-songs-corrupt-'
const MAX_SONGS = 30

/** 存储可用性探测:UI 用它解释"为什么曲库是空的" */
export function probeLibraryStorage(): { available: boolean; usedBytes: number; error?: string } {
  try {
    const probe = 'gm-storage-probe'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    const raw = localStorage.getItem(KEY) ?? ''
    return { available: true, usedBytes: raw.length }
  } catch (e) {
    return { available: false, usedBytes: 0, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

export function loadSongs(): SavedSong[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return [] // 存储不可用(隐私模式/被禁用)
  }
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as SavedSong[]) : []
  } catch {
    // 数据损坏:先留备份再返回空,绝不静默丢掉用户已有的东西
    try {
      localStorage.setItem(CORRUPT_PREFIX + Date.now(), raw)
    } catch {
      /* 备份也写不进去就算了 */
    }
    return []
  }
}

/** 逐级降级写入:全量 → 12 首 → 4 首 → 1 首;全部失败则如实返回 ok:false */
function writeSongs(songs: SavedSong[]): SaveReport {
  const candidates = [songs, songs.slice(0, 12), songs.slice(0, 4), songs.slice(0, 1)]
  let lastErr = ''
  for (const c of candidates) {
    if (c.length === 0 && songs.length > 0) continue
    try {
      localStorage.setItem(KEY, JSON.stringify(c))
      return { ok: true, count: c.length, dropped: songs.length - c.length }
    } catch (e) {
      lastErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  }
  return { ok: false, count: 0, dropped: 0, error: lastErr || '未知错误' }
}

export function saveSong(
  name: string,
  bpm: number,
  tuningId: string,
  notes: TabNote[],
  grid: 12 | 16 = 12,
): SaveResult {
  const cleanName =
    name.trim() || `曲谱 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
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
  const report = writeSongs(songs.slice(0, MAX_SONGS))
  return { songs: loadSongs(), report }
}

export function deleteSong(id: string): SavedSong[] {
  writeSongs(loadSongs().filter((s) => s.id !== id))
  return loadSongs()
}

export function renameSong(id: string, name: string): SavedSong[] {
  writeSongs(loadSongs().map((s) => (s.id === id ? { ...s, name, updatedAt: Date.now() } : s)))
  return loadSongs()
}

/** 导出全部曲库为 JSON(跨浏览器/设备转移,也是"换端口/清缓存"前的唯一保险) */
export function exportLibrary(): string {
  return JSON.stringify({ version: 1, songs: loadSongs() }, null, 0)
}

/** 导入曲库 JSON(合并,同名覆盖);返回写入报告供 UI 提示 */
export function importLibrary(json: string): SaveResult {
  const data = JSON.parse(json) as { songs?: SavedSong[] }
  if (!Array.isArray(data.songs)) throw new Error('文件格式不正确(缺少 songs 字段)')
  const existing = loadSongs()
  for (const s of data.songs) {
    if (!s.name || !Array.isArray(s.notes)) continue // 跳过无效条目
    const idx = existing.findIndex((e) => e.name === s.name)
    if (idx >= 0) existing.splice(idx, 1)
    existing.push(s)
  }
  const report = writeSongs(existing.slice(0, MAX_SONGS))
  return { songs: loadSongs(), report }
}
