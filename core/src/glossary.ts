// 整理進名詞圖鑑（ADV3.0 F-73 handleAutoGlossary，L2118–L2230）：把一段台詞交給 LLM，依 json_schema 回 create／update 操作。
import { streamChatRetry, type LlmEndpoint } from './llm.ts';
import type { ChatMessage, GlossaryEntry } from './prompt.ts';
import { fill, type PromptTemplates } from './templates.ts';

export type GlossaryTemplates = PromptTemplates['glossary'];

export type GlossaryOp =
  | { type: 'create'; term: string; reading: string; subName: string; synonyms: string[]; related: string[]; note: string }
  | { type: 'update'; target: string; reading: string; subName: string; synonyms: string[]; related: string[]; note: string };

export class GlossaryFormatError extends Error {}

const fieldsOf = { reading: { type: 'string', maxLength: 40 }, subName: { type: 'string', maxLength: 40 }, synonyms: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 8 }, related: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 8 }, note: { type: 'string', maxLength: 200 } };
const req = ['reading', 'subName', 'synonyms', 'related', 'note'];

export function glossarySchema(): object {
  return {
    type: 'object',
    properties: {
      glossary_ops: {
        type: 'array',
        maxItems: 8,
        items: {
          anyOf: [
            { type: 'object', properties: { type: { const: 'create' }, term: { type: 'string', minLength: 1, maxLength: 30 }, ...fieldsOf }, required: ['type', 'term', ...req], additionalProperties: false },
            { type: 'object', properties: { type: { const: 'update' }, target: { type: 'string', minLength: 1, maxLength: 30 }, ...fieldsOf }, required: ['type', 'target', ...req], additionalProperties: false },
          ],
        },
      },
    },
    required: ['glossary_ops'],
    additionalProperties: false,
  };
}

const keysOf = (e: GlossaryEntry) => [e.term, e.reading, e.subName, ...e.synonyms].map((w) => w.trim()).filter(Boolean);

/** 和這段台詞相關的既有條目（表記／讀み／譯名／同義詞出現在台詞裡），交給 LLM 判斷要不要 update */
export function relatedEntries(entries: GlossaryEntry[], text: string): GlossaryEntry[] {
  return entries.filter((e) => keysOf(e).some((k) => text.includes(k)));
}

export function buildGlossaryMessages(text: string, related: GlossaryEntry[], t: GlossaryTemplates): ChatMessage[] {
  const rel = related.length ? related.map((e) => JSON.stringify({ term: e.term, reading: e.reading, subName: e.subName, synonyms: e.synonyms, related: e.related, note: e.note })).join('\n') : '（沒有）';
  return [
    { role: 'system', content: t.system },
    { role: 'user', content: fill(t.user, { text, related: rel }) },
  ];
}

/**
 * 套用操作：create 插在最前面（同 ADV3.0）；表記已存在就丟錯。
 * update 找表記相同的條目，字串給了非空值才覆蓋、陣列給了非空才覆蓋（同 ADV3.0 的「有給才蓋」）；找不到就丟錯。
 */
export function applyGlossaryOps(entries: GlossaryEntry[], ops: GlossaryOp[]): { entries: GlossaryEntry[]; created: number; updated: number } {
  let out = [...entries];
  let created = 0;
  let updated = 0;
  for (const op of ops) {
    if (op.type === 'create') {
      const term = op.term.trim();
      if (out.some((e) => e.term === term)) throw new GlossaryFormatError(`條目「${term}」已經在圖鑑裡，應該用 update`);
      out = [{ term, reading: op.reading.trim(), subName: op.subName.trim(), synonyms: op.synonyms.map((x) => x.trim()).filter(Boolean), related: op.related.map((x) => x.trim()).filter(Boolean), note: op.note.trim(), always: false }, ...out];
      created++;
    } else {
      const i = out.findIndex((e) => e.term === op.target.trim());
      if (i < 0) throw new GlossaryFormatError(`要更新的條目「${op.target}」不在圖鑑裡`);
      const e = out[i]!;
      const s = (v: string, old: string) => (v.trim() ? v.trim() : old);
      const a = (v: string[], old: string[]) => (v.some((x) => x.trim()) ? v.map((x) => x.trim()).filter(Boolean) : old);
      out = out.map((x, j) => (j === i ? { ...e, reading: s(op.reading, e.reading), subName: s(op.subName, e.subName), synonyms: a(op.synonyms, e.synonyms), related: a(op.related, e.related), note: s(op.note, e.note) } : x));
      updated++;
    }
  }
  return { entries: out, created, updated };
}

export async function organizeGlossary(o: { endpoint: LlmEndpoint; model: string; entries: GlossaryEntry[]; text: string; templates: GlossaryTemplates; fetchFn?: typeof fetch }) {
  const raw = await streamChatRetry(
    o.endpoint,
    { model: o.model, temperature: 0.2, maxTokens: 1500, schema: glossarySchema(), onDelta: () => {}, messages: buildGlossaryMessages(o.text, relatedEntries(o.entries, o.text), o.templates) },
    o.fetchFn,
  );
  const parsed = JSON.parse(raw) as { glossary_ops?: unknown };
  if (!Array.isArray(parsed.glossary_ops)) throw new GlossaryFormatError(`輸出沒有 glossary_ops：${raw.slice(0, 120)}`);
  return applyGlossaryOps(o.entries, parsed.glossary_ops as GlossaryOp[]);
}
