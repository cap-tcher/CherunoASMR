// 台本兩軌的時間軸換算（[[SCR-04_台本兩軌]]）：非線性時間軸——每張台詞卡的頂到底對應這句語音的開始到結束，
// 音效塊用同一條換算：頂端對齊所屬那句的開始，高度＝最長那個音效的秒數換成的 px，可以往下跨到後面的卡片。
// 句與句之間不留停頓（使用者 2026-11-20 同意）。
import type { Side } from './segment.ts';

export interface TrackSe {
  id: string;
  side: Side;
  durMs: number;
}
export interface TrackLine {
  /** 這句語音的長度；還沒合成時給估計值並標 estimated */
  durMs: number;
  estimated: boolean;
  /** 卡片在主軌裡的位置（px，相對主軌頂端） */
  top: number;
  height: number;
  /** 和這句同時開始的音效 */
  se: TrackSe[];
}
export interface SeBlock {
  line: number;
  items: TrackSe[];
  top: number;
  height: number;
  /** next＝被下一塊音效截斷；end＝超過這段最後一句結尾 */
  clipped: 'next' | 'end' | null;
  /** 最長音效的毫秒數（title 用） */
  durMs: number;
  /** 超過這段結尾多少毫秒（clipped＝end 時） */
  overMs: number;
  /** 用到估計長度的句子：位置可能在合成後移動 */
  estimated: boolean;
}

/** 還沒合成的句子用字數估長度：每字 0.15 秒＋0.4 秒；{漢字|よみ} 以讀音字數算 */
export function estimateLineMs(ja: string): number {
  const spoken = ja.replace(/\{([^|}]*)\|([^}]*)\}/g, '$2').replace(/\s/g, '');
  return 400 + 150 * [...spoken].length;
}

export function layoutSeBlocks(lines: TrackLine[]): SeBlock[] {
  const starts: number[] = [];
  let t = 0;
  for (const l of lines) {
    starts.push(t);
    t += Math.max(1, l.durMs);
  }
  const total = t;
  const last = lines.at(-1);
  const endPx = last ? last.top + last.height : 0;
  /** 時間 → px：落在哪句就在那張卡內線性換算；超過結尾就停在最後一張卡底部 */
  const px = (ms: number) => {
    for (let j = 0; j < lines.length; j++) {
      const l = lines[j]!;
      const d = Math.max(1, l.durMs);
      if (ms <= starts[j]! + d) return l.top + ((ms - starts[j]!) / d) * l.height;
    }
    return endPx;
  };

  const blocks: SeBlock[] = [];
  lines.forEach((l, i) => {
    if (!l.se.length) return;
    const durMs = Math.max(...l.se.map((x) => x.durMs));
    const endMs = starts[i]! + durMs;
    // 估計值影響位置：這句本身、以及音效跨過的每一句
    const estimated = lines.some((x, j) => x.estimated && j <= i) || lines.some((x, j) => x.estimated && j > i && starts[j]! < endMs);
    blocks.push({ line: i, items: l.se, top: l.top, height: px(endMs) - l.top, clipped: endMs > total ? 'end' : null, durMs, overMs: Math.max(0, endMs - total), estimated });
  });
  // 後一塊開始時前一塊還沒結束：前一塊截在後一塊頂端
  for (let k = 0; k < blocks.length - 1; k++) {
    const a = blocks[k]!;
    const b = blocks[k + 1]!;
    if (a.top + a.height > b.top) {
      a.height = b.top - a.top;
      a.clipped = 'next';
    }
  }
  return blocks;
}
