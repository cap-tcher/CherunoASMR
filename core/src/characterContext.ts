// 建立角色時一起送給模型的資料（[[PLAN_創角帶更多資料]]）：聽者、情境、世界觀、方向提示提到的其他角色、圖鑑、回憶、開場劇本、親密劇本。
// 挑選規則和聆聽時一樣（pickGlossary、pickChapters），格式也用聆聽時的提示詞模板（角色卡、聽者、情境、圖鑑一條、回憶一條）。
import { pickChapters, type Chapter } from './chapters.ts';
import { pickGlossary, splitName, type CharacterCard, type GlossaryEntry, type Protagonist } from './prompt.ts';
import { fill, type PromptTemplates } from './templates.ts';

type SegmentTemplates = PromptTemplates['segment'];

export interface CharacterContextInput {
  /** 比對用的文字：方向提示＋快速標籤＋已填欄位 */
  haystack: string;
  /** 正在生成的角色（萬物之書重新生成時）：不把自己當成「其他角色」 */
  selfId: string | null;
  characters: CharacterCard[];
  protagonist: Protagonist;
  scene: { name: string; desc: string } | null;
  world: string | null;
  glossary: GlossaryEntry[] | null;
  chapters: Chapter[] | null;
  opening: string;
  intimacyScript: string;
}

/** 每一類都是格式好的文字；空字串＝沒有，請求裡整段省略 */
export interface CharacterContext {
  listener: string;
  scene: string;
  world: string;
  others: string;
  glossary: string;
  memories: string;
  opening: string;
  intimacyScript: string;
}

/** 角色的各種叫法：名字（去掉括號讀み）、括號裡的讀み、讀み欄、字幕名 */
function namesOf(c: CharacterCard): string[] {
  const base = c.name.replace(/[（(].*?[）)]/g, '').trim();
  const inParen = [...c.name.matchAll(/[（(](.*?)[）)]/g)].map((m) => m[1]!.trim());
  return [...new Set([base, ...inParen, c.reading, c.subName].map((x) => x.trim()).filter(Boolean))];
}

/** 比對文字裡提到名字、讀み或字幕名的角色（自己除外），照角色清單的順序 */
export function mentionedCharacters(characters: CharacterCard[], haystack: string, selfId: string | null): CharacterCard[] {
  return characters.filter((c) => c.id !== selfId && namesOf(c).some((n) => haystack.includes(n)));
}

const trimAll = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.trim()]));

export function characterContext(i: CharacterContextInput, t: SegmentTemplates): CharacterContext {
  const u = i.protagonist;
  const listener = fill(t.listener, trimAll({ nameWithReading: u.reading ? `${u.name}（${u.reading}）` : u.name, callName: '', subName: u.subName, gender: u.gender, appearance: u.appearance, bio: u.bio }));
  // 其他角色：角色卡模板（秘密不帶）
  const others = mentionedCharacters(i.characters, i.haystack, i.selfId)
    .map((c) => fill(t.card, trimAll({ ...splitName(c.name, c.reading), ageSex: c.ageSex, relation: c.relation, callName: c.callName, appearance: c.appearance, bio: c.bio, personality: c.personality, behavior: c.behavior, catchphrase: c.catchphrase })))
    .join('\n\n');
  const glossary = i.glossary
    ? pickGlossary(i.glossary, i.haystack)
        .map((e) => fill(t.glossaryItem, { term: e.term, reading: e.reading, subNamePart: e.subName ? `／字幕：${e.subName}` : '', notePart: e.note ? `：${e.note}` : '' }))
        .join('\n')
    : '';
  const memories = i.chapters
    ? pickChapters(i.chapters, i.haystack)
        .map((c) => fill(t.listItem, { text: `${c.title}${c.summary ? `：${c.summary}` : ''}` }))
        .join('\n')
    : '';
  return {
    listener: listener.trim(),
    scene: i.scene ? fill(t.scene, trimAll({ name: i.scene.name, desc: i.scene.desc })).trim() : '',
    world: (i.world ?? '').trim(),
    others,
    glossary,
    memories,
    opening: i.opening.trim(),
    intimacyScript: i.intimacyScript.trim(),
  };
}
