// 秘密規則設定檔：使用者可自訂、可匯入匯出，不寫死在程式碼（對照 ADV3.0 handleImportConfig／handleExportConfig）。
// 一份設定檔＝系統核心規則＋狀態定義（文字，每段帶）＋秘密生成格式（建立角色時寫秘密的模板）＋面板版面＋欄位表（schema 與上限）。
import { parseModelJson, streamChatRetry, type LlmEndpoint } from './llm.ts';
import { SecretFormatError, validateFormat, type SecretFormat, type StateField } from './state.ts';

/**
 * 面板區塊（對應 ADV3.0 intimacyUIConfig.layout）：
 * bars 數值條｜rows 欄位列｜tags 標籤｜zones 可疊加清單（ADV3.0 zones）｜kv 數值表（ADV3.0 kv_group）｜text 文字（ADV3.0 text，直接顯示）｜secret 遮住的文字（按「偷看」才顯示）。
 * fields 留空＝依類型自動分配；include 只給 kv：只顯示名稱符合的項目（以 ^ 開頭或 $ 結尾當 regex，其餘精確比對；編輯時全部顯示）。
 */
export interface PanelBlock {
  /** section＝分段：任何類型的欄位都能放（狀態定義裡的「# 生理數值」這種標題），面板與提示詞照欄位類型各自顯示 */
  type: 'bars' | 'rows' | 'tags' | 'zones' | 'kv' | 'text' | 'secret' | 'section';
  title: string;
  fields: string[];
  include?: string[];
}

/** ADV3.0 KvBlock 的 include 規則（L702–L718） */
export function includeMatch(include: string[] | undefined, name: string): boolean {
  if (!include || !include.length) return true;
  return include.some((p) => {
    if (p.startsWith('^') || p.endsWith('$')) return new RegExp(p).test(name); // 寫壞的 regex 在版面編輯時就擋掉（checkInclude）
    return name === p;
  });
}

/** 版面編輯存檔前檢查 include：regex 寫壞就回錯誤訊息 */
export function checkInclude(include: string[]): string | null {
  for (const p of include) {
    if (!(p.startsWith('^') || p.endsWith('$'))) continue;
    try {
      new RegExp(p);
    } catch (e) {
      return `「${p}」不是合法的 regex：${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

export interface RulesConfig {
  name: string;
  rules: string; // 系統核心規則（每段 system 開頭）
  definitions: string; // 數值與狀態定義（文字，每段帶）
  secretFormat: string; // 秘密生成格式：建立角色時依此寫角色的秘密
  layout: PanelBlock[];
  fields: StateField[]; // 欄位表：產生 json_schema 與上限
  intimacySystem?: string; // 親密模式系統提示詞（取代系統核心規則）
  intimacyScript?: string; // 親密劇本（親密模式每段帶）
}

export const RULES_FORMAT = 'cheruno-rules';

export function exportRules(c: RulesConfig): string {
  return JSON.stringify({ format: RULES_FORMAT, v: 1, ...c }, null, 2);
}

export class RulesImportError extends Error {}

export interface ImportResult {
  source: 'cheruno' | 'adv-config' | 'adv-save';
  config: Partial<RulesConfig>;
  /** 匯入的檔沒有結構化欄位表（ADV3.0 只有文字定義）：要用「由狀態定義產生欄位」補上 */
  needsFields: boolean;
}

const ADV_BLOCK: Record<string, PanelBlock['type']> = { zones: 'zones', kv_group: 'kv', tags: 'tags', text: 'text' };

/**
 * ADV3.0 的親密狀態是固定幾格（zones、stats、tags、mood、intimacy XP；L607–L615），版面區塊用 source 指向它們。
 * 匯入時照版面建出對應欄位，面板就能直接用；數值上下限 ADV3.0 沒有，這裡給可改的預設值。
 */
function fromAdvLayout(layout: unknown): { layout: PanelBlock[]; fields: StateField[] } {
  if (!Array.isArray(layout)) return { layout: [], fields: [] };
  const fields: StateField[] = [];
  const add = (f: StateField) => {
    if (!fields.some((x) => x.key === f.key)) fields.push(f);
  };
  const blocks = layout.map((b: { type?: unknown; title?: unknown; source?: unknown; include?: unknown; text?: unknown }) => {
    const type = ADV_BLOCK[String(b.type)];
    if (!type) throw new RulesImportError(`不認得的面板區塊類型：${String(b.type)}`);
    const title = typeof b.title === 'string' ? b.title : '';
    const src = typeof b.source === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(b.source) ? b.source : undefined;
    let key: string;
    if (type === 'zones') add({ key: (key = 'zones'), label: title || '部位', type: 'zones', levelMin: 0, levelMax: 100, maxDelta: 10, nameMaxLength: 20, stateMaxLength: 40, initial: [] });
    else if (type === 'kv') add({ key: (key = src ?? 'stats'), label: title || '身體數值', type: 'kv', nameMaxLength: 20, valueMaxLength: 30, initial: [] });
    else if (type === 'tags') add({ key: (key = 'tags'), label: title || '狀態標籤', type: 'tags', maxItems: 12, maxLength: 30, initial: [] });
    else add({ key: (key = src ?? 'mood'), label: title || '心情', type: 'text', maxLength: 200, initial: '' });
    const include = Array.isArray(b.include) ? b.include.filter((x): x is string => typeof x === 'string') : undefined;
    return { type, title, fields: [key], ...(include?.length ? { include } : {}) };
  });
  // XP：ADV3.0 側欄標題旁顯示的親密度（L925–L941），不在 layout 裡但一定有
  add({ key: 'intimacy', label: '親密度 XP', type: 'number', min: 0, max: 9999, maxDelta: 20, initial: 0 });
  return { layout: [{ type: 'bars', title: '親密度', fields: ['intimacy'] }, ...blocks], fields };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * 接受三種檔：CherunoASMR 設定檔、ADV3.0 的「匯出配置」（{name, rules, definitions, layout}）、ADV3.0 整份存檔。
 * 只取規則相關欄位；角色、對話紀錄等一律不讀。
 */
export function importRules(json: unknown): ImportResult {
  if (typeof json !== 'object' || json === null) throw new RulesImportError('不是 JSON 物件');
  const j = json as Record<string, unknown>;
  if (j.format === RULES_FORMAT) {
    const fields = j.fields as StateField[];
    if (!Array.isArray(fields)) throw new RulesImportError('設定檔沒有 fields');
    validateFormat({ fields });
    const config: Partial<RulesConfig> = { fields, layout: (j.layout as PanelBlock[]) ?? [] };
    for (const k of ['name', 'rules', 'definitions', 'secretFormat', 'intimacySystem', 'intimacyScript'] as const) if (str(j[k]) !== undefined) config[k] = str(j[k])!;
    return { source: 'cheruno', config, needsFields: false };
  }
  if ('npcList' in j || 'systemRules' in j || 'intimacyUIConfig' in j) {
    const ui = j.intimacyUIConfig as { layout?: unknown } | undefined;
    const adv = fromAdvLayout(ui?.layout ?? j.layout);
    const config: Partial<RulesConfig> = { name: 'ADV3.0 存檔匯入', layout: adv.layout, ...(adv.fields.length ? { fields: adv.fields } : {}) };
    const rules = str(j.systemRules);
    const defs = str(j.intimacyStatDefinitions) ?? str(j.definitions);
    const fmt = str(j.secretFormat);
    if (rules !== undefined) config.rules = rules;
    if (defs !== undefined) config.definitions = defs;
    if (fmt !== undefined) config.secretFormat = fmt;
    if (str(j.intimacySystemPrompt) !== undefined) config.intimacySystem = str(j.intimacySystemPrompt)!;
    if (str(j.intimacyScript) !== undefined) config.intimacyScript = str(j.intimacyScript)!;
    return { source: 'adv-save', config, needsFields: !adv.fields.length };
  }
  if ('rules' in j || 'definitions' in j || 'layout' in j) {
    const adv = fromAdvLayout(j.layout);
    const config: Partial<RulesConfig> = { name: str(j.name) ?? 'ADV3.0 配置匯入', layout: adv.layout, ...(adv.fields.length ? { fields: adv.fields } : {}) };
    if (str(j.rules) !== undefined) config.rules = str(j.rules)!;
    if (str(j.definitions) !== undefined) config.definitions = str(j.definitions)!;
    return { source: 'adv-config', config, needsFields: !adv.fields.length };
  }
  throw new RulesImportError('認不出這個檔：不是 CherunoASMR 設定檔，也不是 ADV3.0 的配置或存檔');
}

export function defaultLayout(fields: StateField[]): PanelBlock[] {
  const out: PanelBlock[] = [];
  if (fields.some((f) => f.type === 'number')) out.push({ type: 'bars', title: '數值', fields: [] });
  if (fields.some((f) => (f.type === 'text' || f.type === 'enum') && !f.hidden)) out.push({ type: 'rows', title: '狀態', fields: [] });
  if (fields.some((f) => f.type === 'zones')) out.push({ type: 'zones', title: '部位', fields: [] });
  if (fields.some((f) => f.type === 'kv')) out.push({ type: 'kv', title: '身體數值', fields: [] });
  if (fields.some((f) => f.type === 'tags')) out.push({ type: 'tags', title: '標籤', fields: [] });
  if (fields.some((f) => f.hidden && f.type === 'text')) out.push({ type: 'text', title: '心裡話', fields: [] });
  return out;
}

/** 依類型把欄位分配到區塊；指名的欄位照指名；沒被任何區塊收到的欄位放到最後一個「其他」欄位列，保證每個欄位都看得到。 */
export function resolveLayout(layout: PanelBlock[], fields: StateField[]): { type: PanelBlock['type']; title: string; fields: StateField[]; include?: string[] }[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const used = new Set<string>();
  const fits = (t: PanelBlock['type'], f: StateField) =>
    t === 'bars'
      ? f.type === 'number'
      : t === 'tags'
        ? f.type === 'tags'
        : t === 'zones'
          ? f.type === 'zones'
          : t === 'kv'
            ? f.type === 'kv'
            : t === 'text' || t === 'secret'
              ? !!f.hidden && f.type === 'text'
              : t === 'section'
                ? !f.hidden
                : (f.type === 'text' || f.type === 'enum') && !f.hidden;
  const blocks = (layout.length ? layout : defaultLayout(fields)).map((b) => {
    const named = b.fields.map((k) => byKey.get(k)).filter((f): f is StateField => !!f);
    const list = named.length ? named : fields.filter((f) => fits(b.type, f) && !used.has(f.key));
    list.forEach((f) => used.add(f.key));
    return { type: b.type, title: b.title, fields: list, ...(b.include?.length ? { include: b.include } : {}) };
  });
  // 沒被收到的欄位：清單類各自一個同類型區塊（標題用欄位名稱），其餘併成「其他」
  const rest = fields.filter((f) => !used.has(f.key));
  const own: Partial<Record<StateField['type'], PanelBlock['type']>> = { number: 'bars', tags: 'tags', zones: 'zones', kv: 'kv' };
  for (const f of rest) if (own[f.type]) blocks.push({ type: own[f.type]!, title: f.label, fields: [f] });
  const other = rest.filter((f) => !own[f.type]);
  if (other.length) blocks.push({ type: 'rows', title: '其他', fields: other });
  return blocks.filter((b) => b.fields.length);
}

/**
 * 「由狀態定義產生欄位」：LLM 讀文字定義，回傳欄位表（json_schema 約束）。使用者在上限表確認後才套用。
 * schema 用單一扁平物件（type 用 enum、各型別的參數攤平、陣列不設長度上限）：六種型別各一個 anyOf 再乘上陣列長度上限，
 * Gemini 會回 400「schema produces a constraint that has too many states」（使用者 2026-11-20 回報）。
 * 和型別無關的參數模型填 0／空字串／空陣列，fieldsFromRaw 只取該型別要的，再交給 validateFormat 檢查
 */
const FIELD_TYPES = ['number', 'enum', 'text', 'tags', 'zones', 'kv'] as const;
const NUM_PARAMS = ['min', 'max', 'maxDelta', 'maxLength', 'maxItems', 'levelMin', 'levelMax', 'nameMaxLength', 'stateMaxLength', 'valueMaxLength'] as const;
export const MAX_FIELDS = 16;

export function fieldsSchema(): object {
  const item = {
    type: 'object',
    properties: {
      key: { type: 'string' },
      label: { type: 'string' },
      section: { type: 'string', description: '這個欄位屬於狀態定義裡哪一個分段標題（例：「# 生理數值」→ 生理數值）；定義沒有分段就填空字串' },
      hidden: { type: 'boolean' },
      type: { enum: [...FIELD_TYPES] },
      ...Object.fromEntries(NUM_PARAMS.map((k) => [k, { type: 'number' }])),
      options: { type: 'array', items: { type: 'string' } },
      initial: { type: 'string' },
      unit: { type: 'string', description: 'number 的單位（例：bpm、次）；沒有就空字串' },
      levelLabel: { type: 'string', description: 'zones 每個項目的等級叫什麼（例：開發度、熟練度），顯示成「開發度 12」；這是等級的名稱，不是單位；其他類型填空字串' },
      tiers: {
        type: 'array',
        description: 'number 的區間標籤：數值 ≥ min 就顯示 label（例：0 初識、100 熟人、500 戀人）；定義沒寫就空陣列',
        items: { type: 'object', properties: { min: { type: 'number' }, label: { type: 'string' } }, required: ['min', 'label'], additionalProperties: false },
      },
    },
    required: ['key', 'label', 'section', 'hidden', 'type', ...NUM_PARAMS, 'options', 'initial', 'unit', 'levelLabel', 'tiers'],
    additionalProperties: false,
  };
  return { type: 'object', properties: { fields: { type: 'array', items: item } }, required: ['fields'], additionalProperties: false };
}

type RawField = { key: string; label: string; section?: string; hidden: boolean; type: string; options: string[]; initial: string; unit?: string; levelLabel?: string; tiers?: { min: number; label: string }[] } & Record<(typeof NUM_PARAMS)[number], number>;

/** 扁平的模型輸出 → 欄位表（只取各型別要的參數；清單型的初始值一律空） */
export function fieldsFromRaw(raw: { fields: RawField[] }): SecretFormat {
  if (!Array.isArray(raw.fields) || !raw.fields.length) throw new SecretFormatError('模型沒有產生任何欄位');
  if (raw.fields.length > MAX_FIELDS) throw new SecretFormatError(`模型產生了 ${raw.fields.length} 個欄位，上限 ${MAX_FIELDS}：把狀態定義寫精簡一點再產生`);
  const int = (n: number) => Math.round(Number(n));
  const fields = raw.fields.map((f): StateField => {
    const base = { key: f.key, label: f.label, ...(f.hidden ? { hidden: true } : {}) };
    switch (f.type) {
      case 'number':
        return { ...base, type: 'number', min: Number(f.min), max: Number(f.max), maxDelta: Number(f.maxDelta), initial: Number(f.initial) || Number(f.min), ...(f.unit?.trim() ? { unit: f.unit.trim() } : {}), ...(f.tiers?.length ? { tiers: f.tiers.map((t) => ({ min: Number(t.min), label: String(t.label).trim() })) } : {}) };
      case 'enum':
        if (!Array.isArray(f.options) || f.options.length < 2) throw new SecretFormatError(`${f.key}（${f.label}）是選項型，至少要 2 個選項`);
        return { ...base, type: 'enum', options: f.options, initial: f.options.includes(f.initial) ? f.initial : (f.options[0] ?? '') };
      case 'text':
        return { ...base, type: 'text', maxLength: int(f.maxLength), initial: f.initial };
      case 'tags':
        return { ...base, type: 'tags', maxItems: int(f.maxItems), maxLength: int(f.maxLength), initial: [] };
      case 'zones':
        return { ...base, type: 'zones', levelMin: int(f.levelMin), levelMax: int(f.levelMax), maxDelta: int(f.maxDelta), nameMaxLength: int(f.nameMaxLength), stateMaxLength: int(f.stateMaxLength), ...(f.levelLabel?.trim() ? { levelLabel: f.levelLabel.trim() } : {}), initial: [] };
      case 'kv':
        return { ...base, type: 'kv', nameMaxLength: int(f.nameMaxLength), valueMaxLength: int(f.valueMaxLength), initial: [] };
      default:
        throw new SecretFormatError(`不認得的欄位型別：${f.type}`);
    }
  });
  const format: SecretFormat = { fields };
  validateFormat(format);
  return format;
}

/**
 * 模型標的分段 → 面板版面：每個分段一個 section 區塊（照第一次出現的順序），心裡話這種 hidden 欄位不放進分段（照預設放在遮住的區塊）；
 * 沒標分段的欄位交給預設版面的同類型區塊。一個分段都沒有就回空版面（＝照類型自動分配）
 */
export function layoutFromSections(raw: { fields: RawField[] }, format: SecretFormat): PanelBlock[] {
  const out: PanelBlock[] = [];
  const keys = new Set(format.fields.map((f) => f.key));
  const hidden = new Set(format.fields.filter((f) => f.hidden).map((f) => f.key));
  for (const f of raw.fields) {
    const title = String(f.section ?? '').replace(/^#+\s*/, '').trim();
    if (!title || !keys.has(f.key) || hidden.has(f.key)) continue;
    const b = out.find((x) => x.title === title);
    if (b) b.fields.push(f.key);
    else out.push({ type: 'section', title, fields: [f.key] });
  }
  if (!out.length) return [];
  const placed = new Set(out.flatMap((b) => b.fields));
  return [...out, ...defaultLayout(format.fields.filter((f) => !placed.has(f.key)))];
}

export async function fieldsFromDefinitions(o: { endpoint: LlmEndpoint; model: string; definitions: string; system: string; fetchFn?: typeof fetch }): Promise<{ format: SecretFormat; layout: PanelBlock[] }> {
  const raw = await streamChatRetry(
    o.endpoint,
    {
      model: o.model,
      temperature: 0.2,
      maxTokens: 6144,
      schema: fieldsSchema(),
      onDelta: () => {},
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.definitions },
      ],
    },
    o.fetchFn,
  );
  const parsed = parseModelJson<{ fields: RawField[] }>(raw, '欄位表');
  const format = fieldsFromRaw(parsed);
  return { format, layout: layoutFromSections(parsed, format) };
}
