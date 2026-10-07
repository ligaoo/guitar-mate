// 曲库持久化回归:写入必须"要么真存上、要么如实报错",绝不静默丢数据
//
// 背景(用户实测):"扒完一刷新曲库就空了"。排查出两个真问题 ——
//   ① saveSong 的 setItem 没有 try/catch:配额满/隐私模式会抛异常,页面却照样显示
//      "已自动保存";
//   ② loadSongs 解析失败静默返回空数组,把已有数据当成"没有"。
// 这里用一个可注入失败的 localStorage 假实现来守住行为。
import { loadSongs, saveSong, importLibrary, probeLibraryStorage, exportLibrary } from './src/stores/songs'
import type { TabNote } from './src/transcription/fingering'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '❌'} ${msg}`)
  if (!cond) failed++
}

/** 可控的 localStorage 假实现:可设总容量上限,或直接禁用 */
function makeStorage(opts: { limit?: number; disabled?: boolean } = {}) {
  const map = new Map<string, string>()
  return {
    map,
    api: {
      getItem: (k: string) => {
        if (opts.disabled) throw new Error('SecurityError: storage disabled')
        return map.has(k) ? (map.get(k) as string) : null
      },
      setItem: (k: string, v: string) => {
        if (opts.disabled) throw new Error('SecurityError: storage disabled')
        if (opts.limit !== undefined && v.length > opts.limit) {
          const e = new Error('QuotaExceededError: exceeded the quota')
          e.name = 'QuotaExceededError'
          throw e
        }
        map.set(k, v)
      },
      removeItem: (k: string) => void map.delete(k),
    },
  }
}

const note = (midi: number, step: number): TabNote => ({ id: step, step, dur: 6, midi, string: 1, fret: midi - 45, conf: 0.7 })
const notes = (n: number): TabNote[] => Array.from({ length: n }, (_, i) => note(60 + (i % 12), i))

const use = (opts: { limit?: number; disabled?: boolean } = {}) => {
  const s = makeStorage(opts)
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = s.api
  return s
}

// 1. 正常写入 / 同名覆盖 / 读回一致
{
  use()
  const r1 = saveSong('测试曲 A', 100, 'standard', notes(200))
  ok(r1.report.ok && r1.report.count === 1 && r1.songs.length === 1, `正常写入:ok=${r1.report.ok} 曲库 ${r1.report.count} 首`)
  const r2 = saveSong('测试曲 A', 120, 'standard', notes(300))
  ok(r2.report.count === 1 && r2.songs[0].notes.length === 300, '同名覆盖不堆条目,且内容是新的')
  const r3 = saveSong('测试曲 B', 90, 'standard', notes(50))
  ok(r3.report.count === 2 && loadSongs().length === 2, '不同名各自入库')
  ok(JSON.parse(exportLibrary()).songs.length === 2, '导出包含全部曲目')
}

// 2. 配额不足:逐级降级,丢旧曲但**保住刚存的那首**,并如实报告 dropped
{
  // 每首约 60*200 字节,给一个只装得下 2~3 首的上限
  const one = JSON.stringify([{ id: 'x', name: 'y', bpm: 1, tuningId: 'standard', notes: notes(200), updatedAt: 1 }]).length
  use({ limit: Math.floor(one * 3.4) })
  saveSong('曲 1', 100, 'standard', notes(200))
  saveSong('曲 2', 100, 'standard', notes(200))
  saveSong('曲 3', 100, 'standard', notes(200))
  const r = saveSong('曲 4', 100, 'standard', notes(200))
  ok(r.report.ok, `配额紧张时仍然写入成功(ok=${r.report.ok})`)
  ok(r.songs.some((s) => s.name === '曲 4'), '刚保存的那首一定在库里(丢的是更旧的)')
  ok(r.report.dropped > 0, `如实报告丢弃了 ${r.report.dropped} 首旧曲目`)
  ok(r.report.count < 4, `库里条目数被压到配额允许的范围(${r.report.count})`)
}

// 3. 完全写不进去:必须 ok=false + 给出原因,且**不能破坏已有数据**
{
  const s = use()
  saveSong('已有的歌', 100, 'standard', notes(30))
  const before = s.map.get('gm-songs')
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = makeStorage({ limit: 0 }).api
  const r = saveSong('存不下的歌', 100, 'standard', notes(30))
  ok(!r.report.ok && !!r.report.error, `写不进去时 ok=false 且带原因(${r.report.error?.slice(0, 32)}…)`)
  ok(s.map.get('gm-songs') === before, '失败时旧数据保持原样(没有被清空)')
  // 存储可用性探测也要如实报告不可用
  ok(probeLibraryStorage().available === false, 'probeLibraryStorage 报告不可用')
}

// 4. 存储被禁用(无痕/隐私设置):读取返回空、探测报不可用、不抛异常
{
  use({ disabled: true })
  let threw = false
  try {
    ok(loadSongs().length === 0, '存储禁用时读取返回空而不抛异常')
    ok(probeLibraryStorage().available === false, '探测报告不可用')
    const r = saveSong('任意', 100, 'standard', notes(10))
    ok(!r.report.ok, '禁用时保存如实失败')
  } catch {
    threw = true
  }
  ok(!threw, '整个流程没有任何未捕获异常')
}

// 5. 数据损坏:不能静默当"没有",要留备份
{
  const s = use()
  s.map.set('gm-songs', '{这不是合法 JSON')
  const out = loadSongs()
  ok(out.length === 0, '损坏数据下返回空数组')
  const backupKeys = [...s.map.keys()].filter((k) => k.startsWith('gm-songs-corrupt-'))
  ok(backupKeys.length === 1 && s.map.get(backupKeys[0]) === '{这不是合法 JSON', '原始损坏数据已备份(可人工抢救)')
}

// 6. 导入:同名覆盖 + 报告
{
  use()
  saveSong('旧曲', 100, 'standard', notes(20))
  const payload = JSON.stringify({
    version: 1,
    songs: [
      { id: 'i1', name: '导入曲', bpm: 88, tuningId: 'standard', notes: notes(40), updatedAt: Date.now() },
      { id: 'i2', name: '旧曲', bpm: 99, tuningId: 'standard', notes: notes(25), updatedAt: Date.now() },
    ],
  })
  const r = importLibrary(payload)
  ok(r.report.ok && r.songs.length === 2, `导入写入成功(共 ${r.report.count} 首)`)
  ok(r.songs.find((s) => s.name === '旧曲')?.bpm === 99, '同名条目被导入内容覆盖')
}

console.log(failed === 0 ? '全部通过 ✓' : `失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
