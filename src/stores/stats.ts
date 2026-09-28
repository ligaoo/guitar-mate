// 练耳统计(localStorage 持久化):各题型正确率、自适应等级、每日打卡
import type { EarKind } from '../ear/engine'

export interface KindStat {
  total: number
  correct: number
  level: number // 自适应等级 1-5
  streak: number // 当前连对(负数=连错)
  history: { d: string; ok: boolean }[] // 最近记录
}

export interface EarStats {
  kinds: Partial<Record<EarKind, KindStat>>
  daily: Record<string, { total: number; correct: number }> // YYYY-MM-DD
}

const KEY = 'gm-ear-stats'

export function loadStats(): EarStats {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as EarStats
  } catch {
    /* ignore */
  }
  return { kinds: {}, daily: {} }
}

function save(s: EarStats) {
  localStorage.setItem(KEY, JSON.stringify(s))
}

// 本地时区日期(ISO 的 UTC 日期会让 UTC+8 凌晨答题记到昨天)
const today = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function recordAnswer(kind: EarKind, ok: boolean): EarStats {
  const s = loadStats()
  const k = (s.kinds[kind] ??= { total: 0, correct: 0, level: 1, streak: 0, history: [] })
  k.total++
  if (ok) k.correct++
  k.history.push({ d: today(), ok })
  if (k.history.length > 200) k.history = k.history.slice(-200)
  // 自适应:连对 3 升级,连错 2 降级
  if (ok) k.streak = k.streak >= 0 ? k.streak + 1 : 1
  else k.streak = k.streak <= 0 ? k.streak - 1 : -1
  if (k.streak >= 3 && k.level < 5) {
    k.level++
    k.streak = 0
  } else if (k.streak <= -2 && k.level > 1) {
    k.level--
    k.streak = 0
  }
  const d = (s.daily[today()] ??= { total: 0, correct: 0 })
  d.total++
  if (ok) d.correct++
  save(s)
  return s
}

/** 连续练习天数(从今天往回数,本地时区) */
export function streakDays(s: EarStats): number {
  const days = new Set(Object.keys(s.daily))
  const localDay = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  let n = 0
  const d = new Date()
  // 今天没练也允许从昨天开始数
  if (!days.has(localDay(d))) d.setDate(d.getDate() - 1)
  while (days.has(localDay(d))) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

export function resetStats(): EarStats {
  localStorage.removeItem(KEY)
  return { kinds: {}, daily: {} }
}

// ---- 和弦收藏 ----

const FAV_KEY = 'gm-chord-favs'

export function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function toggleFav(sig: string): string[] {
  const favs = loadFavs()
  const i = favs.indexOf(sig)
  if (i >= 0) favs.splice(i, 1)
  else favs.push(sig)
  localStorage.setItem(FAV_KEY, JSON.stringify(favs))
  return favs
}
