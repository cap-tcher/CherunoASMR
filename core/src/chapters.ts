// 回憶「AI 整理」：照 ADV3.0 的 Chapter Manager（Sources/ADV_3.0.jsx handleAutoGenerateChapters）。
// 把「最新一章起點之後」的台本交給 LLM，回傳 create／update 操作：延續最新一章就 update（延伸範圍、改寫摘要），
// 新的場景就 create（可一次多個）。章節之後每段 prompt 帶：最新一章一律帶，其餘看關鍵字有沒有出現。
import { parseModelJson, streamChatRetry, type LlmEndpoint } from './llm.ts';
import type { ChatMessage } from './prompt.ts';
import { fill, type PromptTemplates } from './templates.ts';

export type ChapterTemplates = PromptTemplates['chapters'];

export interface Chapter {
  id: number;
  title: string;
  summary: string;
  keywords: string[];
  range: { start: number; end: number }; // 段落序號（第幾段，從 1 起）
  pinned: boolean;
}

export interface TranscriptEntry {
  n: number; // 段落序號
  text: string; // 這段的台詞（日文＋譯文）與使用者輸入
}

export interface ChapterOp {
  type: 'create' | 'update';
  targetChapterId: number | null;
  title: string;
  summary: string;
  keywords: string[];
  range: { start: number; end: number };
}

export function chapterSchema(): object {
  return {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            type: { enum: ['create', 'update'] },
            targetChapterId: { type: ['integer', 'null'] },
            title: { type: 'string', minLength: 1, maxLength: 30 },
            summary: { type: 'string', minLength: 1, maxLength: 300 },
            keywords: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 12 }, minItems: 1, maxItems: 6 },
            range: {
              type: 'object',
              properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
              required: ['start', 'end'],
              additionalProperties: false,
            },
          },
          required: ['type', 'targetChapterId', 'title', 'summary', 'keywords', 'range'],
          additionalProperties: false,
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  };
}

export function latestChapter(chapters: Chapter[]): Chapter | null {
  return chapters.reduce<Chapter | null>((a, c) => (!a || c.range.end > a.range.end ? c : a), null);
}

/** 要交給 LLM 的段落：最新一章起點之後的全部（讓它判斷要延續還是開新章）。 */
export function unprocessed(chapters: Chapter[], transcript: TranscriptEntry[]): TranscriptEntry[] {
  const latest = latestChapter(chapters);
  return transcript.filter((t) => t.n >= (latest ? latest.range.start : 1));
}

export function buildChapterMessages(chapters: Chapter[], transcript: TranscriptEntry[], t: ChapterTemplates): ChatMessage[] {
  const latest = latestChapter(chapters);
  const body = unprocessed(chapters, transcript)
    .map((x) => `[第 ${x.n} 段]\n${x.text}`)
    .join('\n\n');
  return [
    { role: 'system', content: t.system },
    {
      role: 'user',
      content: [
        latest ? fill(t.latest, { id: String(latest.id), title: latest.title, start: String(latest.range.start), end: String(latest.range.end), summary: latest.summary }) : t.noLatest,
        fill(t.body, { body }),
      ].join('\n\n'),
    },
  ];
}

export class ChapterFormatError extends Error {}

/** 套用 LLM 回傳的操作。update 指到不存在的章節 → 丟錯（不默默改成 create）。 */
export function applyChapterOps(chapters: Chapter[], ops: ChapterOp[]): Chapter[] {
  let next = chapters.map((c) => ({ ...c }));
  let nextId = chapters.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  for (const op of ops) {
    if (op.range.end < op.range.start) throw new ChapterFormatError(`章節範圍不合理：${op.range.start}～${op.range.end}`);
    if (op.type === 'update') {
      const target = next.find((c) => c.id === op.targetChapterId);
      if (!target) throw new ChapterFormatError(`要更新的章節不存在：${op.targetChapterId}`);
      next = next.map((c) => (c.id === target.id ? { ...c, title: op.title, summary: op.summary, keywords: op.keywords, range: op.range } : c));
    } else {
      next.push({ id: nextId++, title: op.title, summary: op.summary, keywords: op.keywords, range: op.range, pinned: false });
    }
  }
  return next.sort((a, b) => a.range.start - b.range.start);
}

export async function organizeChapters(o: { endpoint: LlmEndpoint; model: string; chapters: Chapter[]; transcript: TranscriptEntry[]; templates: ChapterTemplates; fetchFn?: typeof fetch }): Promise<Chapter[]> {
  if (!unprocessed(o.chapters, o.transcript).length) throw new ChapterFormatError('沒有要整理的段落');
  const raw = await streamChatRetry(o.endpoint, { model: o.model, messages: buildChapterMessages(o.chapters, o.transcript, o.templates), schema: chapterSchema(), temperature: 0.4, maxTokens: 1200, onDelta: () => {} }, o.fetchFn);
  const parsed = parseModelJson<{ operations?: unknown }>(raw, '章節整理');
  if (!Array.isArray(parsed.operations)) throw new ChapterFormatError('輸出沒有 operations');
  return applyChapterOps(o.chapters, parsed.operations as ChapterOp[]);
}

/** 每段 prompt 要帶的章節：最新一章與釘選的一律帶；其餘看關鍵字有沒有出現在最近台詞或使用者輸入。 */
/** 回憶注入（ADV3.0 L1754–L1769）：最新一章、沒有關鍵字的章、釘選的章、關鍵字出現在掃描文字裡的章；依章節先後排。 */
export function pickChapters(chapters: Chapter[], haystack: string): Chapter[] {
  const latest = latestChapter(chapters);
  const kws = (c: Chapter) => c.keywords.map((k) => k.trim()).filter(Boolean);
  return chapters
    .filter((c) => c.id === latest?.id || c.pinned || kws(c).length === 0 || kws(c).some((k) => haystack.includes(k)))
    .sort((a, b) => a.range.start - b.range.start || a.id - b.id);
}
