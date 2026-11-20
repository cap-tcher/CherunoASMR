import { describe, expect, it } from 'vitest';
import { ChapterFormatError, applyChapterOps, buildChapterMessages, organizeChapters, pickChapters, unprocessed, type Chapter, type TranscriptEntry } from './chapters.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const T = DEFAULT_TEMPLATES.chapters;

const ch1: Chapter = { id: 1, title: '雨夜的敲門', summary: '澪來陪聽者收工。', keywords: ['報告', '熱可可'], range: { start: 1, end: 3 }, pinned: false };
const ch2: Chapter = { id: 2, title: '約好去夜市', summary: '兩人約好報告寫完去夜市。', keywords: ['夜市'], range: { start: 4, end: 6 }, pinned: false };
const transcript: TranscriptEntry[] = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, text: `第${i + 1}段的台詞` }));

describe('unprocessed', () => {
  it('從最新一章的起點開始（讓 LLM 判斷延續或開新章）', () => {
    expect(unprocessed([ch1, ch2], transcript).map((t) => t.n)).toEqual([4, 5, 6, 7, 8]);
    expect(unprocessed([], transcript)).toHaveLength(8);
  });
});

describe('applyChapterOps', () => {
  it('update 延伸最新一章；create 新增', () => {
    const r = applyChapterOps([ch1, ch2], [
      { type: 'update', targetChapterId: 2, title: '約好去夜市', summary: '新摘要', keywords: ['夜市', '小橘'], range: { start: 4, end: 7 } },
      { type: 'create', targetChapterId: null, title: '打雷的夜晚', summary: '雷聲讓聽者睡不著。', keywords: ['打雷'], range: { start: 8, end: 8 } },
    ]);
    expect(r.map((c) => [c.id, c.range.end])).toEqual([[1, 3], [2, 7], [3, 8]]);
    expect(r[1]!.summary).toBe('新摘要');
  });
  it('update 指到不存在的章節 → 丟錯，不默默改成 create', () => {
    expect(() => applyChapterOps([ch1], [{ type: 'update', targetChapterId: 9, title: 'x', summary: 'x', keywords: ['x'], range: { start: 4, end: 5 } }])).toThrow(ChapterFormatError);
  });
});

describe('pickChapters 規則（ADV3.0 F-61）', () => {
  const mk = (id: number, keywords: string[], start: number, pinned = false): Chapter => ({ id, title: `第${id}章`, summary: '', keywords, range: { start, end: start }, pinned });
  it('最新一章、沒有關鍵字的章、釘選、關鍵字命中都帶；依章節先後排', () => {
    const cs = [mk(3, ['雨'], 5), mk(1, [], 1), mk(2, ['報告'], 3), mk(4, ['貓'], 7), mk(5, ['海'], 9, true)];
    expect(pickChapters(cs, '下雨了').map((c) => c.id)).toEqual([1, 3, 5]);
    expect(pickChapters(cs, '').map((c) => c.id)).toEqual([1, 5]);
  });
});

describe('pickChapters', () => {
  it('最新一章一律帶，其餘靠關鍵字或釘選', () => {
    expect(pickChapters([ch1, ch2], '今天好累').map((c) => c.id)).toEqual([2]);
    expect(pickChapters([ch1, ch2], '報告還沒寫完').map((c) => c.id)).toEqual([1, 2]);
    expect(pickChapters([{ ...ch1, pinned: true }, ch2], '').map((c) => c.id)).toEqual([1, 2]);
  });
});

describe('organizeChapters', () => {
  it('送出最新一章資訊與待整理段落，套用回傳的操作', async () => {
    let sent = '';
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sent = String(init.body);
      const out = { operations: [{ type: 'create', targetChapterId: null, title: '第一晚', summary: '初次見面。', keywords: ['初次'], range: { start: 1, end: 8 } }] };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(out) } }] })}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    const r = await organizeChapters({ endpoint: { baseUrl: 'http://x/v1', apiKey: '' }, model: 'm', chapters: [], transcript, templates: T, fetchFn });
    expect(r).toHaveLength(1);
    expect(JSON.parse(sent).response_format.type).toBe('json_schema');
    expect(buildChapterMessages([ch1], transcript, T)[1]!.content).toContain('範圍：第 1～3 段');
  });
});
