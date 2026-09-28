// Tab 导出:文本六线谱 与 MIDI 文件(SMF type 0)
import type { TabNote } from './fingering'

const STRING_LABELS = ['E', 'A', 'D', 'G', 'B', 'e'] // 6弦→1弦

/** 时值(12 细分格数,每拍 12 格)→ 音符名称 */
export function durName(dur: number): string {
  const map: Record<number, string> = {
    2: '3连16分',
    3: '16分',
    4: '3连8分',
    6: '8分',
    9: '附点8分',
    12: '4分',
    18: '附点4分',
    24: '2分',
    36: '附点2分',
    48: '全音符',
  }
  return map[dur] ?? `${(dur / 12).toFixed(2)}拍`
}

export function tabToText(notes: TabNote[], stepsPerBar = 48): string {
  const bars = Math.max(1, Math.ceil((Math.max(0, ...notes.map((n) => n.step + n.dur)) + 1) / stepsPerBar))
  const lines: string[] = []
  for (let bar = 0; bar < bars; bar++) {
    // 每格 1 字符(品数 ≥10 占 2 字符)
    const cells: string[][] = STRING_LABELS.map(() => new Array(stepsPerBar).fill('-'))
    for (const n of notes) {
      const rel = n.step - bar * stepsPerBar
      if (rel < 0 || rel >= stepsPerBar) continue
      const label = n.fret < 0 ? '?' : String(n.fret)
      if (rel + label.length <= stepsPerBar) {
        cells[n.string][rel] = label
        for (let k = 1; k < label.length; k++) cells[n.string][rel + k] = ''
      }
    }
    lines.push(`第 ${bar + 1} 小节`)
    for (let s = STRING_LABELS.length - 1; s >= 0; s--) {
      lines.push(`${STRING_LABELS[s]}|-${cells[s].join('')}-|`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---- MIDI ----

function vlq(value: number): number[] {
  const bytes = [value & 0x7f]
  value >>= 7
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80)
    value >>= 7
  }
  return bytes
}

function str(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0))
}

function u32(v: number): number[] {
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff]
}

export function tabToMidi(notes: TabNote[], bpmRaw: number): Uint8Array {
  const bpm = Math.max(30, Math.min(300, Math.round(bpmRaw) || 90)) // 防护异常 BPM 产生非法 MPQ
  const TPQ = 480
  const tickPerStep = TPQ / 12 // 每拍 12 细分格
  type Ev = { tick: number; data: number[]; order: number }
  const evs: Ev[] = []
  const mpq = Math.round(60000000 / bpm)
  evs.push({
    tick: 0,
    order: 0,
    data: [0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff],
  })
  for (const n of notes) {
    const on = Math.round(n.step * tickPerStep)
    const off = Math.max(on + 10, Math.round((n.step + n.dur) * tickPerStep) - 6)
    const vel = 90
    evs.push({ tick: on, order: 1, data: [0x90, n.midi, vel] })
    evs.push({ tick: off, order: 0, data: [0x80, n.midi, 0x40] })
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const track: number[] = []
  let lastTick = 0
  for (const ev of evs) {
    track.push(...vlq(ev.tick - lastTick), ...ev.data)
    lastTick = ev.tick
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00)
  const bytes = [
    ...str('MThd'),
    ...u32(6),
    ...u16(0), // format 0
    ...u16(1), // 1 track
    ...u16(TPQ),
    ...str('MTrk'),
    ...u32(track.length),
    ...track,
  ]
  return new Uint8Array(bytes)
}

export function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
