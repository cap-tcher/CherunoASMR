// 範例資料只用成年角色、非性內容（見 Obsidian/UI/ADV3.0功能對照.md）
import { describe, expect, it } from 'vitest';
import { RulesImportError, checkInclude, exportRules, fieldsFromDefinitions, importRules, includeMatch, resolveLayout, type RulesConfig } from './rules.ts';
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
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ fields }) } }] })}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    const r = await fieldsFromDefinitions({ endpoint: { baseUrl: 'http://x/v1', apiKey: '' }, model: 'm', definitions: '好感度 0～100', system: 'sys', fetchFn });
    expect(r.fields).toHaveLength(5);
    expect(JSON.parse(body).response_format.type).toBe('json_schema');
  });
});
