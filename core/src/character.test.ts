import { describe, expect, it } from 'vitest';
import { CharacterFormatError, buildCharacterMessages, buildVoiceInstruct, characterSchema, generateCharacter } from './character.ts';
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
    const withImg = buildCharacterMessages({ direction: '學姊', tags: ['耳かき'], imageDataUrl: 'data:image/png;base64,AAAA', current: {}, listener: '', secretTemplate: '' }, T);
    const parts = withImg[1]!.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
    const noImg = buildCharacterMessages({ direction: '學姊', tags: [], imageDataUrl: null, current: {}, listener: '', secretTemplate: '' }, T);
    expect(typeof noImg[1]!.content).toBe('string');
    expect(noImg[1]!.content).toContain('方向提示：學姊');
  });
  it('她怎麼叫你（callName）是角色卡欄位；請求帶聽者名字，模型才寫得出「テツくん」這類稱呼', () => {
    const m = buildCharacterMessages({ direction: '學姊', tags: [], imageDataUrl: null, current: {}, listener: 'テツ（てつ）', secretTemplate: '' }, T);
    expect(m[1]!.content).toContain('聽者（角色說話的對象）：\nテツ（てつ）');
    expect(m[1]!.content).toContain('- callName：');
    expect(buildCharacterMessages({ direction: '學姊', tags: [], imageDataUrl: null, current: {}, listener: '', secretTemplate: '' }, T)[1]!.content).not.toContain('聽者（角色說話的對象）');
  });
  it('有秘密生成格式時，要求 secret 照模板寫', () => {
    const m = buildCharacterMessages({ direction: 'x', tags: [], imageDataUrl: null, current: {}, listener: '', secretTemplate: '- 不說出口的心事\n- 害怕的事' }, T);
    expect(m[1]!.content).toContain('秘密生成格式');
    expect(m[1]!.content).toContain('- 害怕的事');
  });
  it('已填欄位寫進 prompt 讓其他欄位一致', () => {
    const m = buildCharacterMessages({ direction: '', tags: [], imageDataUrl: null, current: { name: '凜（りん）' }, listener: '', secretTemplate: '' }, T);
    expect(m[1]!.content).toContain('name：凜（りん）');
  });
});

describe('generateCharacter', () => {
  it('保留已填欄位，其餘用生成的；送出時帶 json_schema', async () => {
    const seen: { body?: unknown } = {};
    const r = await generateCharacter({ endpoint: ep, model: 'm', request: { direction: '學姊', tags: [], imageDataUrl: null, current: { name: '凜（りん）' }, listener: '', secretTemplate: '' }, templates: T, fetchFn: fakeFetch(JSON.stringify(full), seen) });
    expect(r.merged.name).toBe('凜（りん）');
    expect(r.merged.bio).toBe('gen-bio');
    expect(r.kept).toBe(1);
    expect((seen.body as { response_format: { type: string } }).response_format.type).toBe('json_schema');
  });
  it('缺欄位時丟 CharacterFormatError，不補值', async () => {
    const { secret: _s, ...partial } = full;
    await expect(generateCharacter({ endpoint: ep, model: 'm', request: { direction: 'x', tags: [], imageDataUrl: null, current: {}, listener: '', secretTemplate: '' }, templates: T, fetchFn: fakeFetch(JSON.stringify(partial), {}) })).rejects.toThrow(CharacterFormatError);
  });
});

describe('buildVoiceInstruct', () => {
  it('聲音描述＋名字、年齡與性別、性格、說話方式；空的略過', () => {
    const r = buildVoiceInstruct('柔らかい声', { name: '澪', ageSex: '24 歲女性', personality: '溫柔', behavior: '說話慢、尾音上揚', catchphrase: 'ね' });
    expect(r.split(String.fromCharCode(10))).toEqual(['柔らかい声', '角色：澪', '年齡與性別：24 歲女性', '性格：溫柔', '說話方式：說話慢、尾音上揚；口頭禪「ね」']);
    expect(buildVoiceInstruct('柔らかい声', { name: '', ageSex: '', personality: '', behavior: '', catchphrase: '' })).toBe('柔らかい声');
  });
  it('每項截長度', () => {
    const r = buildVoiceInstruct('v', { name: 'n', ageSex: '', personality: 'あ'.repeat(500), behavior: '', catchphrase: '' }, 50);
    expect(r).toContain('性格：' + 'あ'.repeat(50));
    expect(r).not.toContain('あ'.repeat(51));
  });
});

describe('欄位填 JSON 也不會弄壞請求', () => {
  // 引號、反斜線、\u、換行、大括號、{{變數}} 這些最容易出事的字元：送出的 body 要是合法 JSON，模型收到的文字跟使用者填的一字不差
  const nasty = '{"name": "澪", "note": "C:\\path\\to \\u12 \\n 結尾\\"}\n第二行 {{name}} $& $1 </script>';
  it('方向提示與已填欄位原樣送出（JSON.stringify 已跳脫，不需要也不應該再跳一次）', async () => {
    let body = '';
    const card = Object.fromEntries(CARD_TEXT_FIELDS.map((k) => [k, k === 'name' ? '澪' : 'x']));
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(card) } }] })}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    await generateCharacter({ endpoint: { baseUrl: 'http://x/v1', apiKey: '' }, model: 'm', templates: T, fetchFn, request: { direction: nasty, tags: [nasty], imageDataUrl: null, current: { bio: nasty }, listener: nasty, secretTemplate: nasty } });
    const sent = JSON.parse(body) as { messages: { content: string }[] };
    const user = sent.messages[1]!.content;
    expect(user.split(nasty).length - 1).toBe(5); // 方向、標籤、已填欄位、聽者、秘密格式各一次，內容沒被改
    expect(user).toContain('{{name}}'); // 使用者寫的 {{…}} 不會被當成變數代入
  });
});

