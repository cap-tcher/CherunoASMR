import { type StateField, DEFAULT_TEMPLATES, TEMPLATE_UPGRADES, validateManual, type Chapter, type CharacterCard, type GlossaryEntry, type PanelBlock, type PromptTemplates, type Protagonist, type SecretFormat, type Snapshot } from '@cheruno/core';
import { useEffect, useRef, useState } from 'react';

export type Engine = 'irodori' | 'zonos' | 'qwen-comfy';
export type SubLang = 'zh' | 'en' | 'off'; // 日文台詞一律顯示；off＝不顯示翻譯
export type ModeKey = 'infinite' | 'interactive' | 'sleep';
export type OptKey = 'scene' | 'glossary' | 'memory' | 'history' | 'world';

export interface Settings {
  llmBase: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  audioBase: string;
  engine: Engine;
  sleepMinutes: number;
  /** 每段帶最近幾則對話（ADV3.0 F-04／F-05：一般／親密模式各一，5～200，預設 70） */
  contextNormal: number;
  contextIntimacy: number;
  /** 關掉 LLM 的思考（reasoning_effort: none）；Gemma 4 這類會先想很久的模型要開 */
  noThinking: boolean;
  /** 狀態另外問一次：台詞生成完，把這段台本當輸入再送第二次請求只填狀態（預設開；[[TASKS_存檔區與語音庫]] D-05） */
  stateSeparately: boolean;
  /** 每段台詞句數：最少～最多（1～20；兩個一樣＝固定句數） */
  linesMin: number;
  linesMax: number;
  /** Irodori 取樣步數（GTX 1070 實測短句 2～4 秒：16 步約 3.8 秒、24 步約 5 秒、40 步約 7 秒；越少越快、音質越粗） */
  irodoriSteps: number;
  /** RAG 參考範例（[[PLAN_RAG]]）：本機 LM Studio／其他端點各一個開關；collection 空＝不檢索 */
  rag: RagSettings;
}

export interface RagSettings {
  local: boolean; // LLM 是本機 LM Studio 時帶參考範例（預設開）
  cloud: boolean; // 其他端點（Gemini、OpenAI、Claude…）時帶（預設關：多吃 token、各家內容政策不同）
  collection: string;
  k: number; // 檢索幾個片段
  maxChars: number; // 參考範例總字數上限
}

/** 性感帶地圖（ADV3.0 L639–L700 的 Zone Map）：部位不固定、模型可新增；開發度 0～100、每段最多 ±10 */
export const ZONE_MAP_FIELD = { key: 'zones', label: '性感帶地圖', type: 'zones', levelMin: 0, levelMax: 100, maxDelta: 10, nameMaxLength: 20, stateMaxLength: 40, levelLabel: '開發度', initial: [] } as const satisfies StateField;

export const DEFAULT_RAG: RagSettings = { local: true, cloud: false, collection: '', k: 3, maxChars: 1500 };

export interface LockedVoice {
  engine: Engine;
  speaker: string; // 引擎端的聲音 id（Irodori voices/）
  desc: string;
  seed: number;
  lockedAt: string;
  /** 鎖定時的參考音（共用庫 refvoice 的 key）：引擎那邊的聲音遺失時可以重新登錄 */
  ref?: string;
}

export interface Character extends CharacterCard {
  image: string | null; // 縮小後的 data URL
  voice: LockedVoice | null;
  state?: Snapshot; // 最新的秘密狀態（存在角色上，重新整理後接著用）；重新開始會清掉（使用者 2026-11-19 決定）；沒有＝欄位表的初始值
}

export interface Scene {
  id: string;
  name: string;
  desc: string;
}

/** 聆聽紀錄（AI 整理用）：每段完成時記一筆；n 是跨 session 的段落序號。 */
export interface LogEntry {
  segId: string;
  n: number;
  text: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  body: string;
}

export interface AppData {
  v: 2;
  settings: Settings;
  protagonist: Protagonist;
  characters: Character[];
  activeId: string | null;
  scenes: Scene[];
  activeSceneId: string | null;
  glossary: GlossaryEntry[];
  chapters: Chapter[]; // 回憶：AI 整理的章節＋確認過的記憶候選（釘選）
  log: LogEntry[];
  logSeq: number;
  history: HistoryEntry[];
  world: string;
  optOn: Record<OptKey, boolean>;
  prompts: { system: string; opening: string; sleep: string };
  /** 親密模式（ADV3.0 F-09／F-10）：系統提示詞（取代 prompts.system）與親密劇本（每段帶） */
  intimacy: { system: string; script: string };
  /** 故事時鐘（ADV3.0 F-20／F-69）：每段帶現在時刻，模型回報結束時刻 */
  clock: { on: boolean; start: string };
  templates: PromptTemplates; // 系統核心 › 提示詞
  rulesName: string;
  secretFormat: SecretFormat; // 欄位表（上限）：產生 json_schema
  statDefs: string; // 數值與狀態定義（文字，每段帶）
  secretTemplate: string; // 秘密生成格式：建立角色時依此寫角色的秘密
  layout: PanelBlock[]; // 面板版面
  tone: string;
  ui: { panel: boolean; sub: SubLang; ruby: boolean; mode: ModeKey; intimacy: boolean };
}

export const SE_LABEL: Record<string, string> = {
  breath_blow: '耳ふー',
  ear_tap: 'タッピング',
  rain: '雨音',
  blanket: '毛布の音',
  cup_on_table: 'マグカップ',
  page_turn: 'ページをめくる',
};

export const MIO: Character = {
  id: 'mio',
  name: '澪（みお）',
  reading: 'みお',
  subName: '澪',
  ageSex: '20 歲 · 女',
  relation: '隔壁的大學學姊',
  appearance: '及肩黑髮、垂眼、寬鬆米色毛衣，總是捧著一杯熱可可。',
  bio: '住在隔壁的大學學姊，主修圖書館學，晚上在家打工翻譯。',
  personality: '溫柔、慢條斯理、偶爾調皮；照顧人時很固執。',
  behavior: '句子短，常用「ん……」停頓；叫你「テツくん」時會放輕。',
  catchphrase: '「〜だよ」「ね？」「ふふっ」',
  secret: '其實早就注意到你在趕報告，偷偷幫你查好資料，但不好意思說出口。',
  voiceDesc: '落ち着いた、近い距離感の若い女性。息の混じった柔らかい囁き声で、ゆっくり話す。語尾は少し甘く伸ばす。',
  image: null,
  voice: null,
};

export const EMPTY_CHARACTER: Omit<Character, 'id'> = {
  name: '', reading: '', subName: '', ageSex: '', relation: '', appearance: '', bio: '', personality: '', behavior: '', catchphrase: '', secret: '', voiceDesc: '', image: null, voice: null,
};

/** 舊版的系統提示詞預設值：存檔裡還是一字不差的這段（使用者沒改過）就換成新版（migrate） */
const SYSTEM_V1 =
  '你是日文 ASMR 音声作品的劇作家兼演出者，扮演角色卡中的角色對聽者說話。\n- 角色與聽者一律是成年人。\n- 台詞用日文、二人稱；不替聽者說話。\n- 用 whisper（囁き）、breath（吐息）與左右、距離的移動營造貼耳感。\n- 名字照名詞圖鑑的讀み與譯名。\n- 秘密只放在 state，不寫進台詞。';
// 使用者 2026-11-20 回報對話牛頭不對馬嘴（請求紀錄：聽者的要求被忽略、口癖「ゆっくり、深呼吸して」每段都出現、用旁白描述聽者）→ 補三條
const DEFAULT_SYSTEM =
  '你是日文 ASMR 音声作品的劇作家兼演出者，扮演角色卡中的角色對聽者說話。\n- 角色與聽者一律是成年人。\n- 台詞用日文、二人稱，是對聽者說的話；不替聽者說話，也不用旁白描述聽者在做什麼。\n- 先回應聽者剛說的話：要你做的事就照做並演出來，問題就回答。\n- 用 whisper（囁き）、breath（吐息）與左右、距離的移動營造貼耳感。\n- 口癖每段最多一次；不要重複前面段落說過的句子，每段都要有新的動作或內容。\n- 名字照名詞圖鑑的讀み與譯名。\n- 秘密只放在 state，不寫進台詞。';

export const DEFAULT_DATA: AppData = {
  v: 2,
  settings: { llmBase: 'http://localhost:1234/v1', apiKey: '', model: '', temperature: 0.8, maxTokens: 1800, audioBase: 'http://127.0.0.1:8790', engine: 'zonos', sleepMinutes: 45, contextNormal: 70, contextIntimacy: 70, irodoriSteps: 16, rag: DEFAULT_RAG, noThinking: true, stateSeparately: true, linesMin: 3, linesMax: 8 },
  protagonist: { name: 'テツ', reading: 'てつ', callName: 'テツくん', subName: '阿哲', gender: '男性', appearance: '', bio: '大學生，最近在趕期末報告；怕打雷；養了一隻橘貓みかん。' },
  characters: [],
  activeId: null,
  scenes: [
    { id: 'rain-study', name: '雨夜書房', desc: '音床：窗外雨聲＋室內底噪 · 空間：小書房 · 常用：翻書、毛布、マグカップ' },
    { id: 'mimikaki', name: '耳かき', desc: '音床：房間底噪 · 空間：貼耳無殘響 · 常用：耳かき、耳ふー' },
  ],
  activeSceneId: 'rain-study',
  glossary: [
    { term: '澪', reading: 'みお', subName: '澪', synonyms: [], related: [], note: '她的名字（不念「れい」）', always: true },
    { term: 'みかん', reading: 'みかん', subName: '小橘', synonyms: ['貓', 'ねこ'], related: [], note: '你的貓，橘色，三歲', always: false },
    { term: '林先生', reading: 'りんせんせい', subName: '林老師', synonyms: ['教授'], related: [], note: '指導教授，台灣人姓林（不念「はやし」）', always: false },
  ],
  chapters: [{ id: 1, title: '阿哲怕打雷', summary: '不放雷聲音效。', keywords: ['打雷', '雷'], range: { start: 1, end: 1 }, pinned: true }],
  log: [],
  logSeq: 0,
  history: [],
  world: '',
  optOn: { scene: true, glossary: true, memory: true, history: false, world: false },
  prompts: {
    system: DEFAULT_SYSTEM,
    opening: '深夜十二點，雨下得正大。你還在趕報告，隔壁的澪敲了敲門。',
    sleep: '台詞逐漸變短、間隔變長；多用 whisper 與 breath；接近結束時只剩輕聲的晚安。',
  },
  templates: DEFAULT_TEMPLATES,
  rulesName: '睡前陪伴（預設）',
  secretTemplate: '- 不說出口的心事\n- 在意聽者的哪一點\n- 一個小習慣或小秘密',
  layout: [],
  secretFormat: {
    fields: [
      { key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 8, initial: 60 },
      { key: 'mood', label: '心情', type: 'text', maxLength: 8, initial: '平靜' },
      { key: 'heart', label: '心跳', type: 'enum', options: ['平穏', '少し速い', '速い'], initial: '平穏' },
      { key: 'secretProgress', label: '秘密進度', type: 'enum', options: ['未透露', '暗示中', '已透露'], initial: '未透露' },
      { key: 'inner', label: '心裡話', type: 'text', maxLength: 40, initial: '', hidden: true },
      { key: 'tags', label: '標籤', type: 'tags', maxItems: 3, maxLength: 8, initial: [] },
      ZONE_MAP_FIELD,
    ],
  },
  statDefs: '好感度：被依賴、被稱讚 +3～+8；被冷落 −5。\n心跳：距離 ≤15cm 時至少「少し速い」。\n秘密進度：好感度 ≥80 才可能進到「暗示中」；「已透露」需要聽者主動問起。',
  tone: '',
  ui: { panel: true, sub: 'zh', ruby: true, mode: 'interactive', intimacy: true },
  intimacy: { system: DEFAULT_SYSTEM, script: '' },
  clock: { on: true, start: '00:00' },
};

/** 舊版瀏覽器存放的 key：存檔區之前 app 存在 localStorage，只用來搬進存檔（[[PLAN_存檔區與語音庫]]） */
export const LEGACY_DATA_KEY = 'cheruno.data.v2';
export const LEGACY_SESSION_KEY = 'cheruno.session.v1';

/** 新存檔：沒有角色、主角、場景、圖鑑、回憶、世界觀、台本；只帶程式的預設規則與提示詞（系統核心可改、可匯入） */
export function newSaveData(settings: Settings): AppData {
  return {
    ...DEFAULT_DATA,
    settings,
    protagonist: { name: '', reading: '', callName: '', subName: '', gender: '', appearance: '', bio: '' },
    characters: [],
    activeId: null,
    scenes: [],
    activeSceneId: null,
    glossary: [],
    chapters: [],
    log: [],
    logSeq: 0,
    history: [],
    world: '',
    prompts: { ...DEFAULT_DATA.prompts, opening: '' },
  };
}

/** 讀進來的資料補上新版本的欄位、升級沒改過的舊預設提示詞（存檔與舊瀏覽器資料共用） */
export function migrate(d: AppData): AppData {
  // 遷移：舊選項「只看日文」和「關」效果相同，併成 off（2026-11-19 使用者指示）
  if ((d.ui.sub as string) === 'ja') d.ui.sub = 'off';
  // 遷移：上下文則數是 2026-11-19 新增的設定，舊存檔補 ADV3.0 的預設 70
  d.settings.contextNormal ??= 70;
  d.settings.contextIntimacy ??= 70;
  d.settings.irodoriSteps ??= 16;
  d.settings.rag = { ...DEFAULT_RAG, ...(d.settings.rag ?? {}) };
  d.settings.noThinking ??= true;
  // 使用者指示（2026-11-19）：狀態要等台本生成完、以台本為輸入再生成，才不會跟台本脫鉤 → 預設開
  d.settings.stateSeparately ??= true;
  // 每段台詞句數是 2026-11-19 新增的設定；之前寫死 3～8
  d.settings.linesMin ??= 3;
  d.settings.linesMax ??= 8;
  // 遷移：親密模式是 2026-11-19 拆出來的；舊存檔原本就等於親密模式，提示詞沿用原本的系統提示詞
  d.ui.intimacy ??= true;
  d.intimacy ??= { system: d.prompts.system, script: '' };
  // 遷移：系統提示詞 2026-11-20 補「先回應聽者」「口癖每段最多一次、不重複」「不用旁白」；沒改過的（等於舊預設）才換
  if (d.prompts.system === SYSTEM_V1) d.prompts.system = DEFAULT_SYSTEM;
  if (d.intimacy.system === SYSTEM_V1) d.intimacy.system = DEFAULT_SYSTEM;
  // 遷移：圖鑑的同義詞、關聯是 2026-11-19 新增的欄位
  for (const g of d.glossary) {
    g.synonyms ??= [];
    g.related ??= [];
  }
  // 遷移：新版本加的提示詞欄位（例：2026-11-19 的 fieldZones／fieldKv）補預設值；使用者改過的欄位不動
  for (const g of Object.keys(DEFAULT_TEMPLATES) as (keyof PromptTemplates)[]) {
    const cur = (d.templates[g] ??= { ...DEFAULT_TEMPLATES[g] } as never) as Record<string, string>;
    for (const [k, v] of Object.entries(DEFAULT_TEMPLATES[g])) if (cur[k] === undefined) cur[k] = v;
  }
  // 遷移：存著的提示詞還是某個舊版本的預設值（沒改過）→ 升級成新預設；改過的不動
  for (const u of TEMPLATE_UPGRADES) {
    const cur = (d.templates as unknown as Record<string, Record<string, string>>)[u.group];
    const next = (DEFAULT_TEMPLATES as unknown as Record<string, Record<string, string>>)[u.group]?.[u.key];
    if (cur && next !== undefined && cur[u.key] === u.from) cur[u.key] = next;
  }
  d.protagonist.gender ??= '';
  d.clock ??= { on: true, start: '00:00' }; // 故事時鐘是 2026-11-19 新增的設定
  d.protagonist.appearance ??= '';
  return d;
}

/** 一個存檔的資料：記憶體裡一份，變動交給 onChange（存檔區防抖寫回） */
export function useAppData(initial: AppData, onChange: (d: AppData) => void): [AppData, (f: (d: AppData) => AppData) => void] {
  const [data, setData] = useState<AppData>(initial);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onChange(data);
  }, [data]);
  return [data, (f) => setData((d) => f(d))];
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** 角色 id：秘密狀態與參考音以它為 key，只能英數與底線。 */
export function makeCharId(taken: string[]): string {
  const id = 'c_' + uid();
  return taken.includes(id) ? makeCharId(taken) : id;
}

/** 角色圖縮到長邊 768 px 的 JPEG（localStorage 容量有限，送 LLM 也夠用）。 */
export async function shrinkImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('只收 PNG／JPG／WebP');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('圖片讀不出來'));
      i.src = url;
    });
    const scale = Math.min(1, 768 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Character Card V3 匯出（不含回憶）；CherunoASMR 欄位放 extensions.cheruno。 */
export function toCCv3(c: Character) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: c.name,
      description: [c.appearance, c.bio].filter(Boolean).join('\n'),
      personality: c.personality,
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {
        cheruno: { reading: c.reading, subName: c.subName, ageSex: c.ageSex, relation: c.relation, behavior: c.behavior, catchphrase: c.catchphrase, secret: c.secret, voiceDesc: c.voiceDesc, voice: c.voice },
      },
    },
  };
}

export function download(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 匯入角色（ADV3.0 F-29）：CCv3（本 App 匯出的會還原全部欄位與鎖定的聲音；一般 SillyTavern 卡只取名字、描述、個性）
 * 或 ADV3.0 單一 NPC JSON（name、gender、appearance、bio、personality、behavior、secret；intimacyState 和目前欄位表對得上才帶）。
 */
export function importCharacter(json: unknown, taken: string[], format: SecretFormat): { character: Character; note: string } {
  if (typeof json !== 'object' || json === null) throw new Error('不是 JSON 物件');
  const j = json as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const id = makeCharId(taken);
  const base = { id, name: '', reading: '', subName: '', ageSex: '', relation: '', appearance: '', bio: '', personality: '', behavior: '', catchphrase: '', secret: '', voiceDesc: '', image: null, voice: null } as Character;
  if (j.spec === 'chara_card_v3' || j.spec === 'chara_card_v2') {
    const d = (j.data ?? {}) as Record<string, unknown>;
    const ext = ((d.extensions as Record<string, unknown> | undefined)?.cheruno ?? null) as Record<string, unknown> | null;
    const c: Character = { ...base, name: str(d.name), subName: str(d.name), bio: str(d.description), personality: str(d.personality), relation: str(d.scenario) };
    if (ext) {
      for (const k of ['reading', 'subName', 'ageSex', 'relation', 'behavior', 'catchphrase', 'secret', 'voiceDesc'] as const) if (typeof ext[k] === 'string') c[k] = ext[k] as string;
      if (ext.voice && typeof ext.voice === 'object') c.voice = ext.voice as Character['voice'];
    }
    if (!c.name.trim()) throw new Error('角色卡沒有名字');
    return { character: c, note: ext ? '' : '這是一般的角色卡：只帶了名字、描述、個性；聲音要另外設計' };
  }
  if (typeof j.name === 'string' && ('personality' in j || 'bio' in j || 'intimacyState' in j)) {
    const c: Character = { ...base, name: str(j.name), subName: str(j.name), ageSex: str(j.gender), appearance: str(j.appearance), bio: str(j.bio), personality: str(j.personality), behavior: str(j.behavior), secret: str(j.secret) };
    if (!c.name.trim()) throw new Error('NPC 沒有名字');
    let note = '聲音要另外設計';
    const st = j.intimacyState as Record<string, unknown> | undefined;
    if (st && typeof st === 'object') {
      const keys = new Set(format.fields.map((f) => f.key));
      const snap: Record<string, unknown> = {};
      for (const f of format.fields) snap[f.key] = structuredClone(f.initial);
      if (keys.has('zones') && Array.isArray(st.zones)) snap.zones = (st.zones as { name?: unknown; level?: unknown; state?: unknown }[]).map((z) => ({ name: str(z.name), level: Number(z.level) || 0, state: str(z.state) }));
      if (keys.has('stats') && st.stats && typeof st.stats === 'object') snap.stats = Object.entries(st.stats as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
      if (keys.has('tags') && Array.isArray(st.tags)) snap.tags = (st.tags as unknown[]).map((t) => (typeof t === 'string' ? t : `${str((t as { label?: unknown }).label)}${(t as { desc?: unknown }).desc ? `：${str((t as { desc?: unknown }).desc)}` : ''}`));
      if (keys.has('mood') && typeof st.mood === 'string') snap.mood = st.mood;
      if (keys.has('intimacy') && typeof st.intimacy === 'number') snap.intimacy = st.intimacy;
      try {
        c.state = validateManual(format, id, snap as never);
        note += '；狀態已照目前的欄位表帶入';
      } catch (e) {
        note += `；狀態和目前的欄位表對不上，沒有帶入（${e instanceof Error ? e.message : String(e)}）`;
      }
    }
    return { character: c, note };
  }
  throw new Error('認不出這個檔：不是 CCv3 角色卡，也不是 ADV3.0 的 NPC JSON');
}

/** LLM 端點（全部 LLM 請求共用） */
export const endpointOf = (s: Settings) => ({ baseUrl: s.llmBase, apiKey: s.apiKey, noThinking: s.noThinking });
