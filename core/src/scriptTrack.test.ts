import { describe, expect, it } from 'vitest';
import { estimateLineMs, layoutSeBlocks, type TrackLine } from './scriptTrack.ts';

const line = (durMs: number, top: number, height: number, se: TrackLine['se'] = [], estimated = false): TrackLine => ({ durMs, estimated, top, height, se });
const blow = (durMs: number) => ({ id: 'breath_blow', side: 'left' as const, durMs });

describe('layoutSeBlocks', () => {
  it('音效從所屬那句的頂端開始，長度跨到後面的卡片（卡片之間 8px 間隔）', () => {
    // 3 句：2 秒、5 秒、1 秒；卡高 80／140／60，間隔 8 → top 0／88／236
    const [b] = layoutSeBlocks([line(2000, 0, 80, [blow(6000)]), line(5000, 88, 140), line(1000, 236, 60)]);
    // 6 秒落在第 2 句（2～7 秒）的 4/5 → 88 + 0.8×140 = 200
    expect(b).toMatchObject({ line: 0, top: 0, height: 200, clipped: null, durMs: 6000, estimated: false });
  });

  it('超過這段結尾：截在最後一張卡底部，記下超過多少', () => {
    const [b] = layoutSeBlocks([line(1000, 0, 60), line(1000, 68, 60, [blow(3000)])]);
    expect(b).toMatchObject({ top: 68, height: 60, clipped: 'end', overMs: 2000 });
  });

  it('同一句的多個音效疊成一塊，長度取最長的', () => {
    const bs = layoutSeBlocks([line(2000, 0, 100, [blow(500), { id: 'blanket', side: 'right', durMs: 1400 }])]);
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ items: [{ id: 'breath_blow' }, { id: 'blanket' }], height: 70, durMs: 1400 });
  });

  it('後一塊開始時前一塊還沒結束：前一塊截在後一塊頂端', () => {
    const bs = layoutSeBlocks([line(1000, 0, 50, [blow(5000)]), line(1000, 58, 50, [blow(500)]), line(4000, 116, 100)]);
    expect(bs[0]).toMatchObject({ top: 0, height: 58, clipped: 'next' });
    expect(bs[1]).toMatchObject({ top: 58, height: 25, clipped: null });
  });

  it('音效跨過還沒合成的句子：標成估計值；沒有音效就沒有塊', () => {
    expect(layoutSeBlocks([line(1000, 0, 50, [blow(3000)]), line(1000, 58, 50, [], true), line(1000, 116, 50)])[0]!.estimated).toBe(true);
    expect(layoutSeBlocks([line(3000, 0, 50, [blow(500)]), line(1000, 58, 50, [], true)])[0]!.estimated).toBe(false);
    expect(layoutSeBlocks([line(1000, 0, 50)])).toEqual([]);
  });
});

describe('estimateLineMs', () => {
  it('每字 0.15 秒＋0.4 秒，振假名用讀音字數', () => {
    expect(estimateLineMs('おかえり')).toBe(1000);
    expect(estimateLineMs('{澪|みお}だよ')).toBe(400 + 150 * 4);
  });
});
