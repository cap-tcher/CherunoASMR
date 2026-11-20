// 每段 prompt 的組裝：固定前綴（系統提示詞＋角色卡＋主角＋情境＋秘密格式）＋選用追加＋當下快照＋本段指令。
// 秘密與秘密狀態只放 system；user 訊息只帶本段指令與使用者輸入。
import type { SecretFormat, Snapshot } from './state.ts';
import { fill, type PromptTemplates } from './templates.ts';

export type SegmentTemplates = PromptTemplates['segment'];

/** 角色卡：欄位照 ADV3.0 的 NPC 卡（SCR-02）。 */
export interface CharacterCard {
  id: string; // 英數 id，秘密狀態以它為 key
  name: string; // 例：澪（みお）
  reading: string; // 名字的假名讀み（TTS 用）
  subName: string; // 字幕顯示名
  ageSex: string;
  relation: string; // 與你的關係
  appearance: string;
  bio: string;
  personality: string;
  behavior: string; // 行為模組：說話習慣、動作
  catchphrase: string;
  secret: string; // 只給 LLM
  voiceDesc: string; // 日文聲音描述（音色設計用）
}

export const CARD_TEXT_FIELDS = ['name', 'reading', 'subName', 'ageSex', 'relation', 'appearance', 'bio', 'personality', 'behavior', 'catchphrase', 'secret', 'voiceDesc'] as const;
export type CardTextField = (typeof CARD_TEXT_FIELDS)[number];

export interface Protagonist {
  name: string;
  reading: string;
  callName: string; // 她怎麼叫你
  subName: string; // 字幕名
  gender: string; // ADV3.0 F-23
  appearance: string; // ADV3.0 F-25
  bio: string;
}

export interface GlossaryEntry {
  term: string; // 表記
  reading: string; // 讀み
  subName: string; // 字幕譯名
  synonyms: string[]; // 同義詞：也算命中（ADV3.0 secondaryKeys）
  related: string[]; // 關聯條目（填對方的表記／讀み／譯名／同義詞）：命中時一起帶（ADV3.0 relatedKeys）
  note: string;
  always: boolean; // true＝常駐；false＝關鍵字出現時才帶
}

export type Mode = 'interactive' | 'infinite' | 'sleep';

/** 上下文的一則：聽者那則（當時實際送出的 user 內容）或 AI 一段台詞。照 ADV3.0：帶最近 N 則（F-04／F-05）。 */
export interface ContextTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 取最近 limit 則；切片開頭是 AI 那則就去掉，讓歷史從聽者開始（Messages API 第一則要是 user）。 */
export function sliceContext(turns: ContextTurn[], limit: number): ContextTurn[] {
  const out = limit > 0 ? turns.slice(-limit) : []; // slice(-0) 會回整個陣列
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

/** 圖鑑、回憶的觸發掃描範圍：最近 3 則＋本次輸入（ADV3.0 L1709–L1713） */
export const SCAN_TURNS = 3;
export const scanText = (context: ContextTurn[], userInput: string) => [...context.slice(-SCAN_TURNS).map((x) => x.text), userInput].join('\n');

export interface PromptInput {
  /** 每段台詞句數（min＝max 就是固定句數） */
  lineRange: { min: number; max: number };
  /** 狀態另外問一次（2026-11-19 使用者提議）：第一次只產台詞，台詞完成後第二次請求只填 state */
  stateSeparately?: boolean;
  systemPrompt: string;
  opening: string; // 開場劇本：只在第一段帶
  sleepInstruction: string; // 睡眠模式指令
  statDefs: string; // 數值與狀態定義（文字）
  character: CharacterCard;
  protagonist: Protagonist;
  scene: { name: string; desc: string } | null; // 情境（選用）
  glossary: GlossaryEntry[] | null; // 圖鑑（選用）
  world: string | null; // 世界觀（選用）
  memories: string[] | null; // 回憶（選用）：釘選與已確認的記憶
  history: string[] | null; // 歷史（選用）：過去幾次聆聽的摘要
  tone: string; // 語氣 FAB：只影響之後的段落
  secretFormat: SecretFormat;
  state: Record<string, Snapshot>; // 當下快照（上一段結束時）
  mode: Mode;
  userInput: string; // 互動模式的輸入
  intimacy: boolean; // 親密模式（ADV3.0 F-18）：用親密模式系統提示詞＋親密劇本，帶秘密與狀態；一般模式都不帶、不輸出 state
  intimacySystem: string;
  intimacyScript: string;
  clock: string | null; // 故事時鐘（ADV3.0 F-69）：現在時刻 HH:MM；null＝關閉
  secretTemplate: string; // 秘密生成格式：親密模式下角色沒有秘密時，這段照它寫（ADV3.0 F-64）
  context: ContextTurn[]; // 到上一段為止的全部對話（舊到新）
  contextLimit: number; // 帶最近幾則
  isFirstSegment: boolean;
  withEn: boolean;
  seIds: readonly string[];
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

function describeField(f: SecretFormat['fields'][number], t: SegmentTemplates): string {
  const base = { key: f.key, label: f.label };
  if (f.type === 'number') return fill(t.fieldNumber, { ...base, min: String(f.min), max: String(f.max), maxDelta: String(f.maxDelta) });
  if (f.type === 'text') return fill(t.fieldText, { ...base, maxLength: String(f.maxLength) });
  if (f.type === 'enum') return fill(t.fieldEnum, { ...base, options: f.options.join('／') });
  const nameRule = (names?: string[]) => (names?.length ? fill(t.namesFixed, { names: names.join('、') }) : t.namesFree);
  if (f.type === 'zones') return fill(t.fieldZones, { ...base, nameRule: nameRule(f.names), levelMin: String(f.levelMin), levelMax: String(f.levelMax), maxDelta: String(f.maxDelta) });
  if (f.type === 'kv') return fill(t.fieldKv, { ...base, nameRule: nameRule(f.names) });
  return fill(t.fieldTags, { ...base, maxItems: String(f.maxItems), maxLength: String(f.maxLength) });
}

const keysOf = (e: GlossaryEntry) => [e.term, e.reading, e.subName, ...e.synonyms].map((w) => w.trim()).filter(Boolean);

/**
 * 圖鑑（ADV3.0 L1708–L1752）：常駐條目一律帶；其餘在掃描文字裡出現表記、讀み、譯名或同義詞時帶。
 * 命中的條目再往外帶一層關聯（雙向：它列的關聯條目、以及把它列為關聯的條目），不再往下展開。順序＝圖鑑裡的順序。
 */
export function pickGlossary(entries: GlossaryEntry[], haystack: string): GlossaryEntry[] {
  const direct = entries.filter((e) => e.always || keysOf(e).some((k) => haystack.includes(k)));
  const hit = new Set(direct);
  for (const e of direct) {
    const rel = e.related.map((r) => r.trim()).filter(Boolean);
    const mine = keysOf(e);
    for (const c of entries) {
      if (hit.has(c)) continue;
      if (keysOf(c).some((k) => rel.includes(k)) || c.related.some((r) => mine.includes(r.trim()))) hit.add(c);
    }
  }
  return entries.filter((e) => hit.has(e));
}

const trimAll = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.trim()]));

/** t：提示詞模板（系統核心 › 提示詞；預設值見 templates.ts 的 DEFAULT_TEMPLATES.segment）。 */
export function buildMessages(p: PromptInput, t: SegmentTemplates): ChatMessage[] {
  const c = p.character;
  const u = p.protagonist;
  const section = (title: string, body: string) => (body.trim() ? `${title}\n${body.trim()}` : '');
  const card = fill(t.card, trimAll({ name: c.name, reading: c.reading, ageSex: c.ageSex, relation: c.relation, appearance: c.appearance, bio: c.bio, personality: c.personality, behavior: c.behavior, catchphrase: c.catchphrase }));
  const listener = fill(t.listener, trimAll({ nameWithReading: u.reading ? `${u.name}（${u.reading}）` : u.name, callName: u.callName, subName: u.subName, gender: u.gender, appearance: u.appearance, bio: u.bio }));
  const haystack = scanText(p.context, p.userInput);
  const glossary = p.glossary
    ? pickGlossary(p.glossary, haystack)
        .map((e) => fill(t.glossaryItem, { term: e.term, reading: e.reading, subNamePart: e.subName ? `／字幕：${e.subName}` : '', notePart: e.note ? `：${e.note}` : '' }))
        .join('\n')
    : '';
  const list = (xs: string[] | null) => (xs ?? []).map((x) => fill(t.listItem, { text: x })).join('\n');
  const im = p.intimacy;
  // 狀態另外問一次時，第一次的輸出格式不提 state（第二次請求才問，見 generate.ts）
  const lineRange = p.lineRange.min === p.lineRange.max ? String(p.lineRange.min) : `${p.lineRange.min}～${p.lineRange.max}`;
  const output = fill(t.output, { lineRange, charName: c.name, translation: p.withEn ? t.translationZhEn : t.translationZh, seIds: p.seIds.join('、'), charId: c.id, stateRule: im && !p.stateSeparately ? fill(t.outputState, { charId: c.id }) : '' });

  // 親密模式：親密提示詞整段取代系統提示詞（ADV3.0 L1961–L1962）；秘密、狀態、定義、親密劇本只在親密模式帶（F-37、F-63）
  const system = [
    (im ? p.intimacySystem : p.systemPrompt).trim(),
    section(t.secCharacter, card),
    section(t.secListener, listener),
    section(t.secScene, p.scene ? fill(t.scene, trimAll({ name: p.scene.name, desc: p.scene.desc })) : ''),
    section(t.secWorld, p.world ?? ''),
    section(t.secGlossary, glossary),
    section(t.secMemories, list(p.memories)),
    section(t.secHistory, list(p.history)),
    im ? section(t.secSecret, c.secret) : '',
    im && !c.secret.trim() ? section(t.secSecretGen, fill(t.secretGenBody, { secretTemplate: p.secretTemplate.trim() })) : '',
    im ? section(t.secStateFormat, p.secretFormat.fields.map((f) => describeField(f, t)).join('\n')) : '',
    im ? section(t.secStatDefs, p.statDefs) : '',
    im ? section(t.secStateNow, JSON.stringify(p.state)) : '',
    im ? section(t.secIntimacyScript, p.intimacyScript) : '',
    p.clock ? section(t.secClock, fill(t.clockBody, { time: p.clock })) : '',
    section(t.secTone, p.tone),
    section(t.secOutput, output),
  ]
    .filter(Boolean)
    .join('\n\n');

  const opening = p.isFirstSegment && !im ? section(t.secOpening, p.opening) : ''; // 親密模式的開場就是每段都帶的親密劇本
  const instruction =
    p.mode === 'interactive' && p.userInput.trim()
      ? fill(t.modeInteractive, { userInput: p.userInput.trim() })
      : p.mode === 'sleep'
        ? fill(t.modeSleep, { sleepInstruction: p.sleepInstruction.trim() || t.sleepDefault })
        : t.modeInfinite;
  const user = [opening, instruction].filter(Boolean).join('\n\n');

  return [{ role: 'system', content: system }, ...sliceContext(p.context, p.contextLimit).map((x): ChatMessage => ({ role: x.role, content: x.text })), { role: 'user', content: user }];
}

/** 合併生成的角色卡：只填使用者還沒填的欄位（SCR-02：重新生成保留已填欄位）。 */
export function mergeKeepFilled(current: Partial<Record<CardTextField, string>>, generated: Record<CardTextField, string>) {
  const merged = {} as Record<CardTextField, string>;
  let kept = 0;
  for (const k of CARD_TEXT_FIELDS) {
    const cur = current[k]?.trim() ?? '';
    if (cur) kept += 1;
    merged[k] = cur ? (current[k] as string) : generated[k];
  }
  return { merged, kept };
}

const toMin = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
};
const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 故事時鐘往前走（修 ADV3.0 L2851–L2861 下一回合被拉回舊時間的問題）：
 * 新時刻比現在晚 → 採用；比現在早超過 12 小時 → 當作過了午夜；其餘倒退或格式錯 → 維持現在並回報原因。
 */
export function advanceClock(cur: string, next: unknown): { time: string; note: string | null } {
  const c = toMin(cur);
  if (c === null) throw new Error(`現在時刻格式錯誤：${cur}`);
  const n = typeof next === 'string' ? toMin(next) : null;
  if (n === null) return { time: fmt(c), note: `模型回的時刻「${String(next)}」不是 HH:MM，時間維持 ${fmt(c)}` };
  if (n >= c || c - n > 12 * 60) return { time: fmt(n), note: null };
  return { time: fmt(c), note: `模型把時間從 ${fmt(c)} 往回改成 ${fmt(n)}，時間只會往前，維持 ${fmt(c)}` };
}
