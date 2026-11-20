import { describe, expect, it } from 'vitest';
import { advanceClock, buildMessages, mergeKeepFilled, pickGlossary, sliceContext, type CharacterCard, type ContextTurn, type GlossaryEntry, type PromptInput } from './prompt.ts';
import { initialSnapshot, type SecretFormat } from './state.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const T = DEFAULT_TEMPLATES.segment;

const format: SecretFormat = { fields: [{ key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 }] };

export const MIO: CharacterCard = {
  id: 'mio',
  name: '澪（みお）',
  reading: 'みお',
  subName: '澪',
  ageSex: '20 歲 · 女',
  relation: '隔壁的學姊',
  callName: 'テツくん',
  appearance: '及肩黑髮',
  bio: '',
  personality: '溫柔',
  behavior: '',
  catchphrase: '「〜だよ」',
  secret: '其實偷偷幫你查好資料',
  voiceDesc: '落ち着いた若い女性',
};

const GLOSSARY: GlossaryEntry[] = [
  { term: '澪', reading: 'みお', subName: '澪', synonyms: [], related: [], note: '她的名字', always: true },
  { term: 'みかん', reading: 'みかん', subName: '小橘', synonyms: ['ねこ'], related: [], note: '你的貓', always: false },
];

const input = (over: Partial<PromptInput> = {}): PromptInput => ({
  systemPrompt: 'あなたは ASMR の台本作家です。',
  opening: '深夜十二點，雨下得正大。',
  sleepInstruction: '台詞逐漸變短。',
  statDefs: '好感度：被依賴 +3～+8',
  character: MIO,
  protagonist: { name: 'テツ', reading: 'てつ', subName: '阿哲', gender: '男性', appearance: '', bio: '' },
  scene: { name: '雨夜書房', desc: '窗外雨聲' },
  glossary: GLOSSARY,
  world: null,
  memories: null,
  history: null,
  tone: '',
  secretFormat: format,
  state: { mio: initialSnapshot(format) },
  mode: 'interactive',
  userInput: '今日は疲れた',
  intimacy: true,
  intimacySystem: 'あなたは ASMR の台本作家です。',
  intimacyScript: '',
  secretTemplate: '- 不說出口的心事',
  clock: null,
  context: [],
  contextLimit: 70,
  isFirstSegment: false,
  withEn: false, lineRange: { min: 3, max: 8 },
  seIds: ['breath_blow', 'rain'],
  ...over,
});

describe('buildMessages', () => {
  it('秘密只出現在 system', () => {
    const [sys, user] = buildMessages(input(), T);
    expect(sys!.content).toContain('偷偷幫你查好資料');
    expect(user!.content).not.toContain('查好資料');
  });

  it('目前狀態以可讀格式帶入 system（分段標題、值(±變化)）', () => {
    const [sys] = buildMessages(input({ state: { mio: { affection: 42 } }, statePrev: { mio: { affection: 37 } } }), T);
    expect(sys!.content).toContain('好感度: 42(+5)');
    expect(sys!.content).toMatch(/## 目前的秘密狀態\n# /);
  });

  it('沒填的選用欄位不產生空標題或空行', () => {
    const [sys, user] = buildMessages(input({ scene: null, glossary: null, character: { ...MIO, secret: '', bio: '' }, statDefs: '' }), T);
    const text = sys!.content as string;
    for (const h of ['## 情境', '## 名詞圖鑑', '## 秘密（', '## 數值與狀態定義', '## 世界觀', '## 語氣']) expect(text).not.toContain(h);
    expect(text).not.toContain('背景：');
    expect(user!.content).not.toContain('## 最近的台詞');
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('情境、主角、狀態定義、語氣帶進 system', () => {
    const [sys] = buildMessages(input({ tone: '再撒嬌一點' }), T);
    const text = sys!.content as string;
    expect(text).toContain('雨夜書房');
    // 稱呼在角色卡裡、緊接在關係後；聽者段落在角色段落前（2026-11-20）
    expect(text).toMatch(/聴き手との関係：[^\n]*\n聴き手の呼び方：テツくん/);
    expect(text.indexOf(T.secListener)).toBeLessThan(text.indexOf(T.secCharacter));
    expect(text).toContain('名前：澪（みお）'); // 名稱已含讀み不再重複
    expect(text).not.toContain('（みお）（みお）');
    expect(buildMessages(input({ character: { ...MIO, callName: 'お兄さん' } }), T)[0]!.content as string).toContain('聴き手の呼び方：お兄さん');
    expect(text).toContain('被依賴 +3～+8');
    expect(text).toContain('再撒嬌一點');
  });

  it('開場劇本只在一般模式的第一段', () => {
    expect(buildMessages(input({ intimacy: false, isFirstSegment: true }), T)[1]!.content).toContain('雨下得正大');
    expect(buildMessages(input({ intimacy: false, isFirstSegment: false }), T)[1]!.content).not.toContain('雨下得正大');
  });

  it('一般模式（ADV3.0 F-18）：用系統提示詞，不帶秘密、狀態格式、狀態、定義、親密劇本；輸出格式沒有 state', () => {
    const sys = buildMessages(input({ intimacy: false, systemPrompt: '一般規則', intimacySystem: '親密規則', intimacyScript: '親密劇本內容' }), T)[0]!.content as string;
    expect(sys.startsWith('一般規則')).toBe(true);
    for (const x of ['親密規則', '親密劇本內容', '偷偷幫你查好資料', '## 目前的秘密狀態', '好感度：被依賴']) expect(sys).not.toContain(x);
    expect(sys).not.toContain('- state：');
  });

  it('親密模式：親密提示詞取代系統提示詞，每段都帶親密劇本與秘密、狀態', () => {
    const sys = buildMessages(input({ intimacy: true, systemPrompt: '一般規則', intimacySystem: '親密規則', intimacyScript: '親密劇本內容', isFirstSegment: false }), T)[0]!.content as string;
    expect(sys.startsWith('親密規則')).toBe(true);
    expect(sys).not.toContain('一般規則');
    for (const x of ['親密劇本內容', '偷偷幫你查好資料', '- state：']) expect(sys).toContain(x);
  });

  it('無限模式不帶使用者輸入；睡眠模式帶睡眠指令', () => {
    expect(buildMessages(input({ mode: 'infinite', userInput: '這句不該出現' }), T)[1]!.content).not.toContain('這句不該出現');
    expect(buildMessages(input({ mode: 'sleep' }), T)[1]!.content).toContain('台詞逐漸變短');
  });

  it('選 EN 時輸出格式要求 en', () => {
    expect(buildMessages(input({ withEn: true }), T)[0]!.content).toContain('en 是英文翻譯');
    expect(buildMessages(input({ withEn: false }), T)[0]!.content).not.toContain('en 是英文翻譯');
  });
});

describe('故事時鐘（ADV3.0 F-69）', () => {
  it('開著才帶現在時刻', () => {
    expect(buildMessages(input({ clock: '00:40' }), T)[0]!.content).toContain('現在是 00:40');
    expect(buildMessages(input({ clock: null }), T)[0]!.content).not.toContain('## 現在時刻');
  });
  it('只往前；過午夜接受；倒退或格式錯維持原時刻並說明', () => {
    expect(advanceClock('23:50', '23:58')).toEqual({ time: '23:58', note: null });
    expect(advanceClock('23:50', '00:10')).toEqual({ time: '00:10', note: null });
    expect(advanceClock('02:00', '01:30').time).toBe('02:00');
    expect(advanceClock('02:00', '01:30').note).toMatch('只會往前');
    expect(advanceClock('02:00', '兩點').note).toMatch('不是 HH:MM');
  });
});

describe('聽者欄位（ADV3.0 F-23／F-25）', () => {
  it('性別、外觀有填才帶，空白整行省略', () => {
    const sys = (o: Partial<PromptInput>) => buildMessages(input(o), T)[0]!.content as string;
    const u = { name: 'テツ', reading: 'てつ', subName: '阿哲', gender: '男性', appearance: '戴眼鏡', bio: '' };
    expect(sys({ protagonist: u })).toContain('性別：男性');
    expect(sys({ protagonist: u })).toContain('外見：戴眼鏡');
    const listener = (x: string) => x.slice(x.indexOf(T.secListener), x.indexOf('\n\n', x.indexOf(T.secListener)));
    expect(listener(sys({ protagonist: { ...u, appearance: '' } }))).not.toContain('外見：');
    expect(listener(sys({ protagonist: u }))).toContain('外見：戴眼鏡');
  });
});

describe('秘密自動生成（ADV3.0 F-64）', () => {
  it('親密模式且角色沒有秘密時，帶秘密生成格式；有秘密或一般模式時不帶', () => {
    const noSecret = { ...MIO, secret: '' };
    const sys = (o: Partial<PromptInput>) => buildMessages(input(o), T)[0]!.content as string;
    expect(sys({ character: noSecret })).toContain('不說出口的心事');
    expect(sys({ character: noSecret })).toContain('## 角色的秘密（還沒有）');
    expect(sys({})).not.toContain('## 角色的秘密（還沒有）');
    expect(sys({ character: noSecret, intimacy: false })).not.toContain('## 角色的秘密（還沒有）');
  });
});

describe('回憶與歷史', () => {
  it('啟用時帶進 system，停用（null）時不出現', () => {
    const on = buildMessages(input({ memories: ['阿哲怕打雷'], history: ['11/17 雨夜書房 · 52 分鐘'] }), T)[0]!.content as string;
    expect(on).toContain('- 阿哲怕打雷');
    expect(on).toContain('11/17 雨夜書房');
    const off = buildMessages(input(), T)[0]!.content as string;
    expect(off).not.toContain('## 回憶');
    expect(off).not.toContain('## 過去的聆聽');
  });
});

describe('pickGlossary', () => {
  it('常駐一律帶；關鍵字條目在台詞或輸入出現時才帶', () => {
    expect(pickGlossary(GLOSSARY, '今日は疲れた').map((e) => e.term)).toEqual(['澪']);
    expect(pickGlossary(GLOSSARY, 'みかんも寝ちゃった').map((e) => e.term)).toEqual(['澪', 'みかん']);
    expect(pickGlossary(GLOSSARY, '小橘呢').map((e) => e.term)).toEqual(['澪', 'みかん']);
  });
});

const turns = (n: number): ContextTurn[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第${i + 1}則` }));

describe('上下文則數（ADV3.0 F-04／F-05）', () => {
  it('帶最近 N 則，夾在 system 與本段指令之間', () => {
    const m = buildMessages(input({ context: turns(10), contextLimit: 4 }), T);
    expect(m).toHaveLength(1 + 4 + 1);
    expect(m.slice(1, 5).map((x) => x.content)).toEqual(['第7則', '第8則', '第9則', '第10則']);
    expect(m.slice(1, 5).map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(m[5]!.role).toBe('user');
  });
  it('則數夠大就全帶', () => {
    expect(buildMessages(input({ context: turns(10), contextLimit: 70 }), T)).toHaveLength(12);
  });
  it('切片開頭是 AI 那則就去掉', () => {
    expect(sliceContext(turns(10), 3).map((x) => x.text)).toEqual(['第9則', '第10則']);
    expect(sliceContext(turns(10), 0)).toEqual([]);
  });
  it('圖鑑只掃最近 3 則＋本次輸入', () => {
    const ctx: ContextTurn[] = [{ role: 'user', text: 'みかん' }, ...turns(3)];
    const sys = (c: ContextTurn[]) => buildMessages(input({ context: c, userInput: '' }), T)[0]!.content as string;
    expect(sys(ctx)).not.toContain('みかん');
    expect(sys([...turns(2), { role: 'user', text: 'みかん' }])).toContain('みかん');
  });
});

describe('圖鑑同義詞與關聯（ADV3.0 F-41／F-60）', () => {
  const G: GlossaryEntry[] = [
    { term: '圖書館', reading: 'としょかん', subName: '', synonyms: ['書庫'], related: ['林先生'], note: '大學圖書館', always: false },
    { term: '林先生', reading: 'りんせんせい', subName: '林老師', synonyms: [], related: ['研究室'], note: '指導教授', always: false },
    { term: '研究室', reading: 'けんきゅうしつ', subName: '', synonyms: [], related: [], note: '四樓', always: false },
    { term: '咖啡', reading: 'コーヒー', subName: '', synonyms: [], related: ['圖書館'], note: '她常喝', always: false },
  ];
  it('同義詞命中也帶', () => {
    expect(pickGlossary(G, '去書庫找資料').map((e) => e.term)).toContain('圖書館');
    expect(pickGlossary(GLOSSARY, 'ねこが寝てる').map((e) => e.term)).toContain('みかん');
  });
  it('命中後帶一層關聯（雙向），不再往下展開；順序照圖鑑', () => {
    // 圖書館命中 → 帶它列的「林先生」、以及把它列為關聯的「咖啡」；林先生的關聯「研究室」不帶
    expect(pickGlossary(G, '圖書館好安靜').map((e) => e.term)).toEqual(['圖書館', '林先生', '咖啡']);
  });
});

describe('mergeKeepFilled', () => {
  it('只填空白欄位，回報保留幾欄', () => {
    const gen = Object.fromEntries(Object.keys(MIO).filter((k) => k !== 'id').map((k) => [k, `生成的${k}`])) as Record<string, string>;
    const { merged, kept } = mergeKeepFilled({ name: '我取的名字', secret: '  ', bio: '我寫的背景' }, gen as never);
    expect(merged.name).toBe('我取的名字');
    expect(merged.bio).toBe('我寫的背景');
    expect(merged.secret).toBe('生成的secret');
    expect(kept).toBe(2);
  });
});

describe('部位／數值表的名稱規則', () => {
  const zonesFormat = (names?: string[]): SecretFormat => ({ fields: [{ key: 'zones', label: '部位', type: 'zones', levelMin: 0, levelMax: 10, maxDelta: 2, nameMaxLength: 10, stateMaxLength: 12, ...(names ? { names } : {}), initial: [] }] });
  it('有清單：列出允許的名稱；沒清單：要求具體名稱、不要編號與位置詞；都要求不重複其他欄位', () => {
    const [fixed] = buildMessages(input({ secretFormat: zonesFormat(['耳朵', '首筋']), state: { mio: { zones: [] } } }), T);
    expect(fixed!.content).toContain('name 只能從這些選：耳朵、首筋');
    expect(fixed!.content).toContain('其他欄位已經有的');
    const [free] = buildMessages(input({ secretFormat: zonesFormat(), state: { mio: { zones: [] } } }), T);
    expect(free!.content).toContain('不要用編號（部位1）或位置詞（left／right）');
    expect(free!.content).not.toContain('70bpm');
  });
});

describe('輸出格式的句數', () => {
  it('範圍寫成「N～M 句」、固定寫成「N 句」', () => {
    const user = (r: { min: number; max: number }) => buildMessages(input({ lineRange: r }), T).map((m) => m.content as string).join(' ');
    expect(user({ min: 4, max: 10 })).toContain('lines：4～10 句台詞');
    expect(user({ min: 6, max: 6 })).toContain('lines：6 句台詞');
    expect(user({ min: 6, max: 6 })).not.toContain('3～8');
  });
});

describe('RAG 參考範例', () => {
  const T = DEFAULT_TEMPLATES.segment;
  it('沒有 references 或空陣列：提示詞和沒有 RAG 時一字不差', () => {
    const base = buildMessages(input(), T);
    expect(buildMessages(input({ references: [] }), T)).toEqual(base);
    expect(JSON.stringify(base)).not.toContain('參考範例');
  });
  it('有 references：系統提示多一節參考範例，片段依序帶表頭與內容', () => {
    const m = buildMessages(input({ references: [{ id: 'a#0', header: '場面：睡前', text: 'A：おやすみ' }, { id: 'b#0', header: '', text: 'B：雨だね' }] }), T);
    const sys = String(m[0]!.content);
    expect(sys).toContain(T.secReferences);
    expect(sys.indexOf(['場面：睡前', 'A：おやすみ'].join(String.fromCharCode(10)))).toBeGreaterThan(sys.indexOf(T.secReferences));
    expect(sys).toContain('B：雨だね');
    expect(sys.indexOf(T.secReferences)).toBeLessThan(sys.indexOf(T.secOutput)); // 在輸出格式之前
  });
});
