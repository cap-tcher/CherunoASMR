// app 實際送出的每一種 schema 都要過 OpenAI strict 子集（toOpenAiStrict 不丟錯、轉完沒有不支援的關鍵字）
import { describe, expect, it } from 'vitest';
import { chapterSchema } from './chapters.ts';
import { characterSchema } from './character.ts';
import { glossarySchema } from './glossary.ts';
import { toOpenAiStrict } from './llm.ts';
import { fieldsSchema } from './rules.ts';
import { segmentSchema } from './segment.ts';
import { compileSegmentStateSchema, type SecretFormat } from './state.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const format: SecretFormat = {
  fields: [
    { key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 },
    { key: 'mood', label: '心情', type: 'text', maxLength: 30, initial: '' },
    { key: 'heart', label: '心跳', type: 'enum', options: ['普通', '速い'], initial: '普通' },
    { key: 'tags', label: '標籤', type: 'tags', maxItems: 5, maxLength: 10, initial: [] },
    { key: 'zones', label: '部位', type: 'zones', levelMin: 0, levelMax: 5, maxDelta: 1, nameMaxLength: 10, stateMaxLength: 20, initial: [] },
    { key: 'kv', label: '筆記', type: 'kv', nameMaxLength: 10, valueMaxLength: 20, initial: [] },
  ],
} as SecretFormat;

const state = compileSegmentStateSchema(format, ['c1']);
const cases: [string, object][] = [
  ['台詞＋狀態＋秘密＋時鐘＋英文', segmentSchema({ stateSchema: state, seIds: ['rain'], withEn: true, withSecret: true, withTime: true, lineRange: { min: 2, max: 5 } })],
  ['只有台詞', segmentSchema({ stateSchema: null, seIds: ['rain'], withEn: false, withSecret: false, withTime: false, lineRange: { min: 1, max: 3 } })],
  ['狀態', state],
  ['角色', characterSchema(DEFAULT_TEMPLATES.character)],
  ['圖鑑', glossarySchema()],
  ['欄位表', fieldsSchema()],
  ['章節', chapterSchema()],
];

/** 找出還留著的不支援關鍵字；properties 底下的鍵是欄位名（欄位表就有叫 maxLength 的欄位），不算 */
function leftovers(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => leftovers(v, out));
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) {
      if (['minLength', 'maxLength', 'uniqueItems', 'default'].includes(k)) out.push(k);
      if (k === 'properties' && v && typeof v === 'object') Object.values(v).forEach((pv) => leftovers(pv, out));
      else leftovers(v, out);
    }
  return out;
}

describe('OpenAI strict：app 的所有 schema', () => {
  for (const [name, schema] of cases)
    it(name, () => {
      expect(leftovers(toOpenAiStrict(schema))).toEqual([]);
    });
});
