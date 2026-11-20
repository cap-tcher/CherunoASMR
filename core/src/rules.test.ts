// 範例資料只用成年角色、非性內容（見 Obsidian/UI/ADV3.0功能對照.md）
import { describe, expect, it } from 'vitest';
import { RulesImportError, checkInclude, exportRules, fieldsFromDefinitions, importRules, includeMatch, resolveLayout, type RulesConfig, fieldsSchema, fieldsFromRaw, MAX_FIELDS } from './rules.ts';
import type { StateField } from './state.ts';

const fields: StateField[] = [
  { key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 8, initial: 60 },
  { key: 'mood', label: '心情', type: 'text', maxLength: 8, initial: '平靜' },
  { key: 'heart', label: '心跳', type: 'enum', options: ['平穏', '少し速い'], initial: '平穏' },
  { key: 'inner', label: '心裡話', type: 'text', maxLength: 40, initial: '', hidden: true },
  { key: 'tags', label: '標籤', type: 'tags', maxItems: 3, maxLength: 8, initial: [] },
];
const config: RulesConfig = { name: '睡前陪伴', rules: '台詞用日文', definitions: '好感度：被依賴 +3～+8', secretFormat: '- 不說出口的心事', layout: [], fields };

describe('importRules', () => {
  it('CherunoASMR 設定檔：匯出再匯入內容一致', () => {
    const r = importRules(JSON.parse(exportRules(config)));
    expect(r.source).toBe('cheruno');
    expect(r.needsFields).toBe(false);
    expect(r.config).toEqual({ name: '睡前陪伴', rules: '台詞用日文', definitions: '好感度：被依賴 +3～+8', secretFormat: '- 不說出口的心事', layout: [], fields });
  });
  it('ADV3.0 匯出配置：四種區塊照原本類型對應，並依版面建出欄位（含 XP）', () => {
    const r = importRules({ name: 'Config Export', rules: '規則', definitions: '定義', layout: [{ type: 'zones', title: '區域' }, { type: 'kv_group', title: '數值', source: 'stats', include: ['heartbeat', '^br'] }, { type: 'tags', title: '標籤' }, { type: 'text', title: '心情', source: 'mood' }] });
    expect(r.source).toBe('adv-config');
    expect(r.needsFields).toBe(false);
    expect(r.config.layout!.map((b) => b.type)).toEqual(['bars', 'zones', 'kv', 'tags', 'text']);
    expect(r.config.layout![2]).toEqual({ type: 'kv', title: '數值', fields: ['stats'], include: ['heartbeat', '^br'] });
    expect(r.config.fields!.map((f) => [f.key, f.type])).toEqual([
      ['zones', 'zones'],
      ['stats', 'kv'],
      ['tags', 'tags'],
      ['mood', 'text'],
      ['intimacy', 'number'],
    ]);
  });
  it('ADV3.0 整份存檔：只取規則相關欄位，不讀角色與對話', () => {
    const r = importRules({ systemRules: 'S', intimacyStatDefinitions: 'D', secretFormat: 'F', intimacyUIConfig: { layout: [{ type: 'tags', title: 'T' }] }, npcList: [{ name: 'x' }], history: [{ text: 'x' }] });
    expect(r.source).toBe('adv-save');
    expect(r.config.rules).toBe('S');
    expect(r.config.definitions).toBe('D');
    expect(r.config.layout).toEqual([{ type: 'bars', title: '親密度', fields: ['intimacy'] }, { type: 'tags', title: 'T', fields: ['tags'] }]);
    expect(JSON.stringify(r.config)).not.toContain('npcList');
  });
  it('認不出的檔、壞的欄位表、不認得的區塊類型 → 丟錯', () => {
    expect(() => importRules({ foo: 1 })).toThrow(RulesImportError);
    expect(() => importRules({ format: 'cheruno-rules', fields: [{ key: 'bad key', label: 'x', type: 'text', maxLength: 1, initial: '' }] })).toThrow();
    expect(() => importRules({ rules: 'r', layout: [{ type: 'chart' }] })).toThrow(RulesImportError);
  });
});

describe('resolveLayout', () => {
  it('依類型自動分配；沒被收到的欄位放到「其他」，每個欄位都看得到', () => {
    const r = resolveLayout([{ type: 'bars', title: '數值', fields: [] }, { type: 'secret', title: '心裡話', fields: [] }], fields);
    expect(r.map((b) => [b.title, b.fields.map((f) => f.key)])).toEqual([
      ['數值', ['affection']],
      ['心裡話', ['inner']],
      ['標籤', ['tags']],
      ['其他', ['mood', 'heart']],
    ]);
  });
  it('沒被收到的清單類欄位各自成一個同類型區塊', () => {
    const extra: StateField[] = [...fields, { key: 'zones', label: '部位', type: 'zones', levelMin: 0, levelMax: 10, maxDelta: 2, nameMaxLength: 10, stateMaxLength: 10, initial: [] }];
    const r = resolveLayout([{ type: 'bars', title: '數值', fields: [] }], extra);
    expect(r.find((b) => b.title === '部位')!.type).toBe('zones');
  });
  it('沒有版面時用預設（心裡話直接顯示）', () => {
    expect(resolveLayout([], fields).map((b) => b.type)).toEqual(['bars', 'rows', 'tags', 'text']);
  });
});

describe('include（ADV3.0 KvBlock）', () => {
  it('以 ^ 開頭或 $ 結尾當 regex，其餘精確比對；空的＝全部', () => {
    expect(includeMatch(['heartbeat', '^br'], 'heartbeat')).toBe(true);
    expect(includeMatch(['heartbeat', '^br'], 'breathing')).toBe(true);
    expect(includeMatch(['heartbeat', '^br'], 'heart')).toBe(false);
    expect(includeMatch([], 'x')).toBe(true);
  });
  it('寫壞的 regex 在存檔前就被擋下', () => {
    expect(checkInclude(['^(bad'])).toMatch('不是合法的 regex');
    expect(checkInclude(['ok', '^fine$'])).toBeNull();
  });
});

describe('fieldsFromDefinitions', () => {
  it('走 json_schema，回傳的欄位表要通過格式檢查', async () => {
    let body = '';
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ fields: fields.map(flat) }) } }] })}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    const r = await fieldsFromDefinitions({ endpoint: { baseUrl: 'http://x/v1', apiKey: '' }, model: 'm', definitions: '好感度 0～100', system: 'sys', fetchFn });
    expect(r.fields).toHaveLength(5);
    expect(JSON.parse(body).response_format.type).toBe('json_schema');
  });
});

/** 欄位表 → 模型會回的扁平格式（和型別無關的參數填 0／空） */
function flat(f: StateField) {
  const z = { min: 0, max: 0, maxDelta: 0, maxLength: 0, maxItems: 0, levelMin: 0, levelMax: 0, nameMaxLength: 0, stateMaxLength: 0, valueMaxLength: 0, options: [] as string[], initial: '', unit: '', levelLabel: '', tiers: [] as { min: number; label: string }[] };
  const g = f as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...z, key: f.key, label: f.label, hidden: !!f.hidden, type: f.type };
  for (const k of Object.keys(z)) if (k !== 'initial' && g[k] !== undefined) out[k] = g[k];
  out.initial = typeof g.initial === 'string' || typeof g.initial === 'number' ? String(g.initial) : '';
  return out;
}

describe('fieldsSchema（扁平，Gemini 收得下）', () => {
  const schema = fieldsSchema() as { properties: { fields: Record<string, unknown> & { items: { properties: Record<string, Record<string, unknown>> } } } };
  it('沒有 anyOf、陣列沒有長度上限', () => {
    expect(JSON.stringify(schema)).not.toContain('anyOf');
    const arr = schema.properties.fields;
    expect(arr.maxItems).toBeUndefined();
    expect(arr.minItems).toBeUndefined();
    expect(arr.items.properties.options!.maxItems).toBeUndefined(); // 欄位參數裡的 maxItems 是名稱，不是陣列限制
  });
  it('六種型別都轉得回合法欄位表；清單型初始值為空', () => {
    const all: StateField[] = [
      { key: 'a', label: '好感', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 },
      { key: 'b', label: '心跳', type: 'enum', options: ['普通', '速い'], initial: '速い' },
      { key: 'c', label: '心情', type: 'text', maxLength: 20, initial: '平靜' },
      { key: 'd', label: '標籤', type: 'tags', maxItems: 3, maxLength: 8, initial: [] },
      { key: 'e', label: '性感帶', type: 'zones', levelMin: 0, levelMax: 100, maxDelta: 10, nameMaxLength: 20, stateMaxLength: 40, initial: [] },
      { key: 'f', label: '筆記', type: 'kv', nameMaxLength: 10, valueMaxLength: 30, initial: [] },
    ];
    expect(fieldsFromRaw({ fields: all.map(flat) as never }).fields).toEqual(all);
  });
  it('超過上限、enum 選項太少、不認得的型別都報錯', () => {
    const n = (i: number) => flat({ key: `k${i}`, label: `L${i}`, type: 'number', min: 0, max: 10, maxDelta: 1, initial: 0 });
    expect(() => fieldsFromRaw({ fields: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => n(i)) as never })).toThrow(/上限/);
    expect(() => fieldsFromRaw({ fields: [flat({ key: 'x', label: 'x', type: 'enum', options: ['只有一個'], initial: '只有一個' })] as never })).toThrow();
    expect(() => fieldsFromRaw({ fields: [{ ...n(0), type: 'weird' }] as never })).toThrow(/不認得/);
  });
});
