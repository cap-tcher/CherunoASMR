import { describe, expect, it } from 'vitest';
import { buildRagQuery, fitReferences } from './rag.ts';

describe('buildRagQuery', () => {
  it('使用者的話＋情境＋語氣＋角色說話方式，空的略過、截長度', () => {
    const q = buildRagQuery({ userInput: '今天好累', scene: { name: '睡前', desc: '房間' }, character: { personality: '溫柔', behavior: '', catchphrase: 'ね' }, tone: '' });
    expect(q).toBe('今天好累\n睡前 房間\nね\n溫柔');
    expect(buildRagQuery({ userInput: 'あ'.repeat(1000), scene: null, character: { personality: '', behavior: '', catchphrase: '' }, tone: '' }, 50)).toHaveLength(50);
  });
});

describe('fitReferences', () => {
  const h = (id: string, n: number) => ({ id, header: 'H', text: 'x'.repeat(n) });
  it('依序放到字數上限為止', () => {
    expect(fitReferences([h('a', 40), h('b', 40), h('c', 40)], 90).map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('第一個就超過：截斷內容，至少帶一個', () => {
    const r = fitReferences([h('a', 500), h('b', 10)], 100);
    expect(r).toHaveLength(1);
    expect(r[0]!.header.length + r[0]!.text.length).toBe(100);
  });
});
