import { describe, expect, it } from 'vitest';
import type { Chapter } from './chapters.ts';
import { buildCharacterMessages, characterHaystack } from './character.ts';
import { characterContext, mentionedCharacters, type CharacterContextInput } from './characterContext.ts';
import { splitName, type CharacterCard, type GlossaryEntry } from './prompt.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const card = (id: string, name: string, extra: Partial<CharacterCard> = {}): CharacterCard => ({
  id,
  name,
  reading: '',
  subName: '',
  ageSex: '',
  relation: '',
  callName: '',
  appearance: '',
  bio: '',
  personality: '',
  behavior: '',
  catchphrase: '',
  secret: '',
  voiceDesc: '',
  ...extra,
});
const MIO = card('mio', '澪（みお）', { reading: 'みお', subName: '小澪', ageSex: '20 歲 · 女', relation: '隔壁的學姊', personality: '溫柔', secret: '其實喜歡你' });
const HARU = card('haru', '春（はる）', { reading: 'はる', personality: '活潑' });
const G = (term: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({ term, reading: '', subName: '', synonyms: [], related: [], note: '', always: false, ...extra });
const CH = (id: number, title: string, keywords: string[], extra: Partial<Chapter> = {}): Chapter => ({ id, title, summary: `${title}的摘要`, keywords, range: { start: id, end: id }, pinned: false, ...extra });

const base = (o: Partial<CharacterContextInput> = {}): CharacterContextInput => ({
  haystack: '',
  selfId: null,
  characters: [MIO, HARU],
  protagonist: { name: 'テツ', reading: 'てつ', subName: '阿哲', gender: '男性', appearance: '戴眼鏡', bio: '大學生' },
  scene: { name: '雨夜書房', desc: '窗外雨聲' },
  world: '現代日本的小鎮',
  glossary: [G('みかん', { note: '你的貓', always: true }), G('林先生', { synonyms: ['教授'] }), G('圖書館')],
  chapters: [CH(1, '第一次見面', ['見面']), CH(2, '雨夜', ['雨']), CH(3, '期末報告', ['報告'])],
  opening: '深夜十二點，雨下得正大。',
  intimacyScript: '慢慢靠近，耳邊說話。',
  ...o,
});
const T = DEFAULT_TEMPLATES.segment;

describe('方向提示提到的其他角色', () => {
  it('名字、括號讀み、讀み欄、字幕名都算提到；自己不算', () => {
    expect(mentionedCharacters([MIO, HARU], '澪的妹妹', null).map((c) => c.id)).toEqual(['mio']);
    expect(mentionedCharacters([MIO, HARU], 'みおちゃんの友達', null).map((c) => c.id)).toEqual(['mio']);
    expect(mentionedCharacters([MIO, HARU], '小澪的同學、春的姊姊', null).map((c) => c.id)).toEqual(['mio', 'haru']);
    expect(mentionedCharacters([MIO, HARU], '澪的妹妹', 'mio')).toEqual([]);
    expect(mentionedCharacters([MIO, HARU], '新來的老師', null)).toEqual([]);
  });
  it('帶角色卡模板的內容，不帶秘密；名稱已含讀み不重複', () => {
    const c = characterContext(base({ haystack: '澪的妹妹' }), T);
    expect(c.others).toContain('名前：澪（みお）');
    expect(c.others).not.toContain('（みお）（みお）');
    expect(splitName('澪（みお）', '')).toEqual({ name: '澪', reading: 'みお' });
    expect(splitName('澪', 'みお')).toEqual({ name: '澪', reading: 'みお' });
    expect(c.others).toContain('性格：溫柔');
    expect(c.others).not.toContain('其實喜歡你');
    expect(c.others).not.toContain('春');
  });
});

describe('圖鑑與回憶照聆聽時的規則', () => {
  it('圖鑑：常駐的一律帶，其他要提到；回憶：最新與提到關鍵字的帶', () => {
    const c = characterContext(base({ haystack: '教授的女兒，雨天在書店打工' }), T);
    expect(c.glossary).toContain('みかん');
    expect(c.glossary).toContain('林先生');
    expect(c.glossary).not.toContain('圖書館');
    expect(c.memories).toContain('雨夜');
    expect(c.memories).toContain('期末報告'); // 最新一章一律帶
    expect(c.memories).not.toContain('第一次見面');
  });
  it('圖鑑、回憶、情境、世界觀停用（null）就是空字串', () => {
    const c = characterContext(base({ glossary: null, chapters: null, scene: null, world: null }), T);
    expect([c.glossary, c.memories, c.scene, c.world]).toEqual(['', '', '', '']);
  });
});

describe('一律帶的：主角、情境、世界觀、開場劇本、親密劇本', () => {
  it('不看方向提示，有內容就帶', () => {
    const c = characterContext(base({ haystack: '' }), T);
    expect(c.listener).toContain('名前：テツ（てつ）');
    expect(c.listener).toContain('外見：戴眼鏡');
    expect(c.scene).toContain('雨夜書房');
    expect(c.world).toBe('現代日本的小鎮');
    expect(c.opening).toBe('深夜十二點，雨下得正大。');
    expect(c.intimacyScript).toBe('慢慢靠近，耳邊說話。');
  });
});

describe('送出的建立角色訊息', () => {
  const T2 = DEFAULT_TEMPLATES.character;
  it('每一類成段、順序固定；空的類別整段省略', () => {
    const r = { direction: '澪的妹妹，雨天在書店打工', tags: [], imageDataUrl: null, current: {}, secretTemplate: '' };
    const ctx = characterContext(base({ haystack: characterHaystack(r) }), T);
    const text = buildCharacterMessages({ ...r, listener: ctx.listener, context: ctx }, T2)[1]!.content as string;
    const order = ['聽者（角色說話的對象）', '情境（角色登場的場面）', '世界觀：', '方向提示提到的其他角色', '名詞圖鑑', '回憶（目前為止', '開場劇本', '親密劇本', '方向提示：'].map((h) => text.indexOf(h));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const empty = buildCharacterMessages({ ...r, listener: '', context: { ...ctx, world: '', others: '', intimacyScript: '' } }, T2)[1]!.content as string;
    expect(empty).not.toContain('世界觀：');
    expect(empty).not.toContain('方向提示提到的其他角色');
    expect(empty).not.toContain('親密劇本');
    expect(empty).not.toContain('聽者（角色說話的對象）');
  });
  it('已填欄位也拿來比對（例：關係欄寫了「澪的妹妹」）', () => {
    expect(characterHaystack({ direction: '', tags: ['耳かき'], current: { relation: '澪的妹妹' } })).toContain('澪的妹妹');
  });
});
