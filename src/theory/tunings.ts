// 调弦定义。midi 数组从 6 弦(最低音)到 1 弦(最高音)。
export interface Tuning {
  id: string
  name: string
  midi: number[]
}

export const TUNINGS: Tuning[] = [
  { id: 'standard', name: '标准 EADGBE', midi: [40, 45, 50, 55, 59, 64] },
  { id: 'dropD', name: 'Drop D', midi: [38, 45, 50, 55, 59, 64] },
  { id: 'dadgad', name: 'DADGAD', midi: [38, 45, 50, 55, 57, 62] },
  { id: 'openG', name: 'Open G (DGDGBD)', midi: [38, 43, 50, 55, 59, 62] },
  { id: 'openD', name: 'Open D (DADF#AD)', midi: [38, 45, 50, 53, 57, 62] },
  { id: 'halfDown', name: '降半音 (EbAbDbGbBbEb)', midi: [39, 44, 49, 54, 58, 63] },
]

export const STANDARD_TUNING = TUNINGS[0].midi

export function tuningName(midi: number[]): string {
  const t = TUNINGS.find((t) => t.midi.join(',') === midi.join(','))
  return t ? t.name : '自定义'
}
