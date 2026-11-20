// 建立角色（SCR-02）：角色圖（選用）＋方向提示＋快速標籤 → LLM 一次寫好角色卡與日文聲音描述。
// 重新生成時只填空白欄位（mergeKeepFilled）。
import { streamChatRetry, type LlmEndpoint } from './llm.ts';
import { CARD_TEXT_FIELDS, mergeKeepFilled, type CardTextField, type ChatMessage } from './prompt.ts';
import { fill, type PromptTemplates } from './templates.ts';

export type CharacterTemplates = PromptTemplates['character'];

const hint = (t: CharacterTemplates, k: CardTextField) => t[`hint_${k}` as keyof CharacterTemplates];

export function characterSchema(t: CharacterTemplates): object {
  return {
    type: 'object',
    properties: Object.fromEntries(CARD_TEXT_FIELDS.map((k) => [k, { type: 'string', minLength: 1, maxLength: k === 'voiceDesc' ? 160 : k === 'secret' ? 800 : 200, description: hint(t, k) }])),
    required: [...CARD_TEXT_FIELDS],
    additionalProperties: false,
  };
}

export interface CharacterRequest {
  direction: string;
  tags: string[];
  imageDataUrl: string | null; // data:image/...;base64,...
  current: Partial<Record<CardTextField, string>>; // 使用者已填的欄位
  secretTemplate: string; // 秘密生成格式（系統核心 › 秘密規則）：secret 欄依此模板寫；空字串＝自由寫
}

export function buildCharacterMessages(r: CharacterRequest, t: CharacterTemplates): ChatMessage[] {
  const filled = CARD_TEXT_FIELDS.filter((k) => r.current[k]?.trim()).map((k) => `- ${k}：${r.current[k]}`);
  const text = [
    t.intro,
    r.imageDataUrl ? t.withImage : '',
    r.direction.trim() ? fill(t.direction, { direction: r.direction.trim() }) : '',
    r.tags.length ? fill(t.tags, { tags: r.tags.join('、') }) : '',
    filled.length ? fill(t.filled, { filled: filled.join('\n') }) : '',
    r.secretTemplate.trim() ? fill(t.secretTemplate, { template: r.secretTemplate.trim() }) : '',
    fill(t.fields, { fields: CARD_TEXT_FIELDS.map((k) => `- ${k}：${hint(t, k)}`).join('\n') }),
  ]
    .filter((x) => x.trim())
    .join('\n\n');
  return [
    { role: 'system', content: t.system },
    { role: 'user', content: r.imageDataUrl ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: r.imageDataUrl } }] : text },
  ];
}

export class CharacterFormatError extends Error {}

export async function generateCharacter(o: { endpoint: LlmEndpoint; model: string; request: CharacterRequest; templates: CharacterTemplates; signal?: AbortSignal; fetchFn?: typeof fetch }) {
  const raw = await streamChatRetry(
    o.endpoint,
    { model: o.model, messages: buildCharacterMessages(o.request, o.templates), schema: characterSchema(o.templates), temperature: 0.9, maxTokens: 1200, ...(o.signal ? { signal: o.signal } : {}), onDelta: () => {} },
    o.fetchFn,
  );
  let card: unknown;
  try {
    card = JSON.parse(raw);
  } catch (e) {
    throw new CharacterFormatError(`角色卡不是合法 JSON：${String(e)}`);
  }
  const rec = card as Record<string, unknown>;
  const missing = CARD_TEXT_FIELDS.filter((k) => typeof rec[k] !== 'string' || !(rec[k] as string).trim());
  if (missing.length) throw new CharacterFormatError(`角色卡缺欄位：${missing.join('、')}`);
  return mergeKeepFilled(o.request.current, rec as Record<CardTextField, string>);
}

/**
 * 送給 Qwen 聲音設計的 instruct：聲音描述＋角色基本欄位（使用者 2026-11-20：「餵的提示詞要包含角色的其他基本必要欄位 例如名字 年齡與性別 性格 說話方式」）。
 * 空的欄位略過；每項截在 maxEach 字，免得一長段背景把聲音描述淹掉。鎖定 Qwen 聲音時存的也是這份（每句用同一份＋seed 才是同一個聲音）
 */
export function buildVoiceInstruct(voiceDesc: string, c: { name: string; ageSex: string; personality: string; behavior: string; catchphrase: string }, maxEach = 120): string {
  const cut = (x: string) => x.trim().replace(/\s+/g, ' ').slice(0, maxEach);
  const speech = [cut(c.behavior), c.catchphrase.trim() ? `口頭禪「${cut(c.catchphrase)}」` : ''].filter(Boolean).join('；');
  return [cut(voiceDesc), c.name.trim() && `角色：${cut(c.name)}`, c.ageSex.trim() && `年齡與性別：${cut(c.ageSex)}`, c.personality.trim() && `性格：${cut(c.personality)}`, speech && `說話方式：${speech}`].filter(Boolean).join('\n');
}
