// 依角色圖＋方向提示＋標籤重新生成角色卡的空白欄位（使用者 2026-11-20：萬物之書角色卡「把欄位刪掉變空白然後根據圖片和提示重新生成欄位 跟創角的功能一樣」）。
// 和建立角色用同一個 generateCharacter：只填空的欄位，已填的保留。
import { CARD_TEXT_FIELDS, generateCharacter, type CardTextField } from '@cheruno/core';
import { useState } from 'react';
import { imageToDataUrl, isKey } from '../library.ts';
import { traced } from '../requestLog.ts';
import { endpointOf, type AppData, type Character } from '../store.ts';
import { Field } from './Outline.tsx';

/** 方向提示的快速標籤（建立角色與萬物之書共用） */
export const DIR: [string, string[]][] = [
  ['關係', ['隔壁的大學學姊', '大學同學', '咖啡店店員', '同公司的前輩', '旅館的接待員']],
  ['氣質', ['溫柔', '愛捉弄人', '慵懶', '元氣', '冷淡但體貼']],
  ['ASMR', ['耳かき', '添い寝', '囁き多め', '寝かしつけ', '雨音']],
];

export function CardRegen(props: { data: AppData; c: Character; onMerged: (fields: Record<CardTextField, string>) => void; toast: (m: string, bad?: boolean) => void }) {
  const { data, c } = props;
  const s = data.settings;
  const [direction, setDirection] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const current = Object.fromEntries(CARD_TEXT_FIELDS.map((k) => [k, c[k]])) as Record<CardTextField, string>;
  const empty = CARD_TEXT_FIELDS.filter((k) => !current[k].trim());
  const hasInput = !!c.image || !!direction.trim() || tags.length > 0;

  async function gen() {
    if (!s.model) return setErr('還沒選模型：到系統核心的連線設定測試連線並選一個模型。');
    setBusy(true);
    setErr('');
    try {
      const imageDataUrl = c.image ? (isKey(c.image) ? await imageToDataUrl(c.image) : c.image) : null;
      const { merged, kept } = await generateCharacter({
        endpoint: endpointOf(s),
        fetchFn: traced('角色卡'),
        model: s.model,
        templates: data.templates.character,
        request: { direction, tags, imageDataUrl, current, secretTemplate: data.secretTemplate, listener: data.protagonist.reading ? `${data.protagonist.name}（${data.protagonist.reading}）` : data.protagonist.name },
      });
      props.onMerged(merged);
      props.toast(`已重新生成空白欄位（保留你填的 ${kept} 欄）`);
    } catch (e) {
      setErr(`生成失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lin-sub">
      <h4>重新生成欄位</h4>
      <p className="hint">把想重寫的欄位清空，再按生成：只填空白的欄位，已填的保留。{c.image ? '會一起看角色圖。' : '這個角色沒有角色圖，只用方向提示與標籤。'}</p>
      <Field label="方向提示">
        <textarea className="textarea" rows={2} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="例：比較成熟、說話更慢" />
      </Field>
      {DIR.map(([label, list]) => (
        <Field key={label} as="div" label={`標籤：${label}`}>
          <div className="lin-actions">
            {list.map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={tags.includes(t)} onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>
                {t}
              </button>
            ))}
          </div>
        </Field>
      ))}
      <div className="lin-actions">
        <button type="button" className="btn primary" disabled={busy || !hasInput || !empty.length} onClick={() => void gen()}>
          {busy ? (c.image ? '正在看圖' : '正在構思') : '生成空白欄位'}
        </button>
        <span className="hint">{!empty.length ? '沒有空白的欄位：先清空想重寫的欄位' : !hasInput ? '要有角色圖、方向提示或標籤' : `會填 ${empty.length} 個空白欄位`}</span>
      </div>
      {err && <div className="note danger">{err}</div>}
    </div>
  );
}
