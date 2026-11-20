import { describe, expect, it } from 'vitest';
import { CharacterFormatError, buildCharacterMessages, characterSchema, generateCharacter } from './character.ts';
import { CARD_TEXT_FIELDS } from './prompt.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const T = DEFAULT_TEMPLATES.character;

/** 假 LLM：把 body 存起來，串流回傳給定的 JSON 文字。 */
function fakeFetch(content: string, seen: { body?: unknown }): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.body = JSON.parse(String(init.body));
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

const full = Object.fromEntries(CARD_TEXT_FIELDS.map((k) => [k, `gen-${k}`]));
const ep = { baseUrl: 'http://x/v1', apiKey: '' };

describe('characterSchema', () => {
  it('所有欄位 required、不接受額外欄位', () => {
    const s = characterSchema(T) as { required: string[]; additionalProperties: boolean };
    expect(s.required).toEqual([...CARD_TEXT_FIELDS]);
    expect(s.additionalProperties).toBe(false);
  });
});

describe('buildCharacterMessages', () => {
  it('有角色圖時用 image_url content part；沒有就是純文字', () => {
    const withImg = buildCharacterMessages({ direction: '學姊', tags: ['耳かき'], imageDataUrl: 'data:image/png;base64,AAAA', current: {}, secretTemplate: '' }, T);
    const parts = withImg[1]!.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
    const noImg = buildCharacterMessages({ direction: '學姊', tags: [], imageDataUrl: null, current: {}, secretTemplate: '' }, T);
    expect(typeof noImg[1]!.content).toBe('string');
    expect(noImg[1]!.content).toContain('方向提示：學姊');
  });
  it('有秘密生成格式時，要求 secret 照模板寫', () => {
    const m = buildCharacterMessages({ direction: 'x', tags: [], imageDataUrl: null, current: {}, secretTemplate: '- 不說出口的心事\n- 害怕的事' }, T);
    expect(m[1]!.content).toContain('秘密生成格式');
    expect(m[1]!.content).toContain('- 害怕的事');
  });
  it('已填欄位寫進 prompt 讓其他欄位一致', () => {
    const m = buildCharacterMessages({ direction: '', tags: [], imageDataUrl: null, current: { name: '凜（りん）' }, secretTemplate: '' }, T);
    expect(m[1]!.content).toContain('name：凜（りん）');
  });
});

describe('generateCharacter', () => {
  it('保留已填欄位，其餘用生成的；送出時帶 json_schema', async () => {
    const seen: { body?: unknown } = {};
    const r = await generateCharacter({ endpoint: ep, model: 'm', request: { direction: '學姊', tags: [], imageDataUrl: null, current: { name: '凜（りん）' }, secretTemplate: '' }, templates: T, fetchFn: fakeFetch(JSON.stringify(full), seen) });
    expect(r.merged.name).toBe('凜（りん）');
    expect(r.merged.bio).toBe('gen-bio');
    expect(r.kept).toBe(1);
    expect((seen.body as { response_format: { type: string } }).response_format.type).toBe('json_schema');
  });
  it('缺欄位時丟 CharacterFormatError，不補值', async () => {
    const { secret: _s, ...partial } = full;
    await expect(generateCharacter({ endpoint: ep, model: 'm', request: { direction: 'x', tags: [], imageDataUrl: null, current: {}, secretTemplate: '' }, templates: T, fetchFn: fakeFetch(JSON.stringify(partial), {}) })).rejects.toThrow(CharacterFormatError);
  });
});
