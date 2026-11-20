// RAG（[[PLAN_RAG]]）：生成一段前用什麼查、檢索結果怎麼放進提示詞。檢索本身在音訊服務（/rag/search）。
import type { CharacterCard, RagReference } from './prompt.ts';

export interface RagQueryInput {
  userInput: string; // 這次說的話（互動模式）
  scene: { name: string; desc: string } | null;
  character: Pick<CharacterCard, 'personality' | 'behavior' | 'catchphrase'>;
  tone: string; // 語氣 FAB
}

/** 查詢＝使用者這次說的話＋情境＋語氣＋角色說話方式；空的部分略過，總長截在 maxChars */
export function buildRagQuery(q: RagQueryInput, maxChars = 600): string {
  const parts = [q.userInput, q.scene ? `${q.scene.name} ${q.scene.desc}` : '', q.tone, q.character.behavior, q.character.catchphrase, q.character.personality].map((s) => s.trim()).filter(Boolean);
  return parts.join('\n').slice(0, maxChars);
}

/** 依序放片段，總字數（表頭＋內容）超過 maxChars 就停；第一個片段太長時截斷內容（至少帶一個） */
export function fitReferences(hits: RagReference[], maxChars: number): RagReference[] {
  const out: RagReference[] = [];
  let used = 0;
  for (const h of hits) {
    const len = h.header.length + h.text.length;
    if (used + len <= maxChars) {
      out.push(h);
      used += len;
    } else if (out.length === 0) {
      out.push({ ...h, text: h.text.slice(0, Math.max(0, maxChars - h.header.length)) });
      break;
    } else break;
  }
  return out;
}
