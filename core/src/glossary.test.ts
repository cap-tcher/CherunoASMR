// 範例資料只用成年角色、非性內容
import { describe, expect, it } from 'vitest';
import { GlossaryFormatError, applyGlossaryOps, buildGlossaryMessages, organizeGlossary, relatedEntries } from './glossary.ts';
import type { GlossaryEntry } from './prompt.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const E: GlossaryEntry[] = [{ term: 'みかん', reading: 'みかん', subName: '小橘', synonyms: ['貓'], related: [], note: '你的貓', always: false }];

describe('整理進名詞圖鑑（ADV3.0 F-73）', () => {
  it('create 插在最前面；update 只蓋給了值的欄位', () => {
    const r = applyGlossaryOps(E, [
      { type: 'create', term: '書庫', reading: 'しょこ', subName: '書庫', synonyms: [], related: ['みかん'], note: '圖書館地下', },
      { type: 'update', target: 'みかん', reading: '', subName: '', synonyms: [], related: [], note: '你的貓，最近變胖' },
    ]);
    expect(r.entries.map((e) => e.term)).toEqual(['書庫', 'みかん']);
    expect(r.entries[1]).toMatchObject({ reading: 'みかん', subName: '小橘', synonyms: ['貓'], note: '你的貓，最近變胖' });
    expect([r.created, r.updated]).toEqual([1, 1]);
  });
  it('create 已存在的、update 不存在的 → 丟錯', () => {
    expect(() => applyGlossaryOps(E, [{ type: 'create', term: 'みかん', reading: '', subName: '', synonyms: [], related: [], note: '' }])).toThrow(GlossaryFormatError);
    expect(() => applyGlossaryOps(E, [{ type: 'update', target: '不存在', reading: '', subName: '', synonyms: [], related: [], note: 'x' }])).toThrow(GlossaryFormatError);
  });
  it('相關條目＝表記、讀み、譯名或同義詞出現在台詞裡，並放進 user 訊息', () => {
    expect(relatedEntries(E, '你的貓在睡')).toHaveLength(1);
    expect(relatedEntries(E, '今天下雨')).toHaveLength(0);
    const m = buildGlossaryMessages('你的貓在睡', relatedEntries(E, '你的貓在睡'), DEFAULT_TEMPLATES.glossary);
    expect(m[1]!.content).toContain('"term":"みかん"');
  });
  it('走 json_schema，回傳後套用', async () => {
    let body = '';
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      const out = { glossary_ops: [{ type: 'create', term: '林先生', reading: 'りんせんせい', subName: '林老師', synonyms: [], related: [], note: '指導教授' }] };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(out) } }] })}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    const r = await organizeGlossary({ endpoint: { baseUrl: 'http://x/v1', apiKey: '' }, model: 'm', entries: E, text: '林先生說報告延期', templates: DEFAULT_TEMPLATES.glossary, fetchFn });
    expect(r.entries[0]!.term).toBe('林先生');
    expect(JSON.parse(body).response_format.json_schema.schema.required).toEqual(['glossary_ops']);
  });
});
