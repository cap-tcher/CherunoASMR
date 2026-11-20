// 系統核心 › 秘密規則 › 欄位表：每個欄位兩行（第一行 key／名稱／類型／心裡話／刪除，第二行是該類型的設定，各自有標籤）。
import type { StateField } from '@cheruno/core';
import { useState } from 'react';

export const TYPE_LABEL: Record<StateField['type'], string> = { number: '數值', enum: '選項', text: '文字', tags: '標籤', zones: '可疊加清單', kv: '數值表' };

export function blankField(type: StateField['type'], key: string): StateField {
  if (type === 'number') return { key, label: '新數值', type, min: 0, max: 100, maxDelta: 5, initial: 0 };
  if (type === 'enum') return { key, label: '新選項', type, options: ['A', 'B'], initial: 'A' };
  if (type === 'tags') return { key, label: '新標籤', type, maxItems: 5, maxLength: 12, initial: [] };
  if (type === 'zones') return { key, label: '部位', type, levelMin: 0, levelMax: 100, maxDelta: 10, nameMaxLength: 20, stateMaxLength: 40, initial: [] };
  if (type === 'kv') return { key, label: '身體數值', type, nameMaxLength: 20, valueMaxLength: 30, initial: [] };
  return { key, label: '新文字', type, maxLength: 40, initial: '' };
}

const DEFAULT_LABELS = new Set((Object.keys(TYPE_LABEL) as StateField['type'][]).map((t) => blankField(t, 'x').label));

function Num(props: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <label className="cfg-item">
      <span>{props.label}</span>
      <input className="input num" type="number" value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      {props.suffix && <span className="hint">{props.suffix}</span>}
    </label>
  );
}

/** 允許的名稱（部位、數值表）：用、或逗號分隔；離開欄位才拆開，打字途中的分隔號不會被吃掉；空白＝自由命名 */
function Names({ f, set }: { f: Extract<StateField, { type: 'zones' | 'kv' }>; set: (p: Partial<StateField>) => void }) {
  const [draft, setDraft] = useState((f.names ?? []).join('、'));
  return (
    <label className="cfg-item grow">
      <span>允許的名稱</span>
      <input
        className="input"
        value={draft}
        placeholder="空白＝LLM 自己命名；例：耳朵、首筋、唇"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const names = [...new Set(draft.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean))];
          setDraft(names.join('、'));
          set({ names: names.length ? names : undefined } as Partial<StateField>);
        }}
      />
    </label>
  );
}

export function FieldRow({ f, onChange, onRemove }: { f: StateField; onChange: (f: StateField) => void; onRemove: () => void }) {
  const set = (p: Partial<StateField>) => onChange({ ...f, ...p } as StateField);
  return (
    <div className="field-card">
      <div className="field-top">
        <input className="input mono" aria-label="key" value={f.key} onChange={(e) => set({ key: e.target.value })} />
        <input className="input" aria-label="名稱" value={f.label} onChange={(e) => set({ label: e.target.value })} />
        <select className="select" aria-label="類型" value={f.type} onChange={(e) => {
            const nb = blankField(e.target.value as StateField['type'], f.key);
            const keepLabel = !DEFAULT_LABELS.has(f.label); // 名稱還是預設值就跟著換成新類型的預設名稱
            onChange({ ...nb, ...(keepLabel ? { label: f.label } : {}), ...(f.hidden ? { hidden: true } : {}) });
          }}>
          {(Object.keys(TYPE_LABEL) as StateField['type'][]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        {f.type === 'text' ? (
          <label className="check" title="面板放在「心裡話」區塊：不念出來、不進字幕">
            <input type="checkbox" checked={!!f.hidden} onChange={(e) => set({ hidden: e.target.checked || undefined })} />
            <span>心裡話</span>
          </label>
        ) : (
          <span />
        )}
        <button type="button" className="btn sm ghost" onClick={onRemove}>
          刪除
        </button>
      </div>
      <div className="field-cfg">
        {f.type === 'number' && (
          <>
            <Num label="最小" value={f.min} onChange={(v) => set({ min: v } as Partial<StateField>)} />
            <Num label="最大" value={f.max} onChange={(v) => set({ max: v } as Partial<StateField>)} />
            <Num label="每段最多變化" value={f.maxDelta} onChange={(v) => set({ maxDelta: v } as Partial<StateField>)} />
            <Num label="初始值" value={f.initial} onChange={(v) => set({ initial: v } as Partial<StateField>)} />
          </>
        )}
        {f.type === 'enum' && (
          <>
            <label className="cfg-item grow">
              <span>選項（用／分隔）</span>
              <input className="input" value={f.options.join('／')} onChange={(e) => set({ options: e.target.value.split(/[／/]/).map((x) => x.trim()).filter(Boolean) } as Partial<StateField>)} />
            </label>
            <label className="cfg-item">
              <span>初始值</span>
              <select className="select" value={f.initial} onChange={(e) => set({ initial: e.target.value } as Partial<StateField>)}>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {f.type === 'text' && (
          <>
            <Num label="最多" value={f.maxLength} suffix="字" onChange={(v) => set({ maxLength: v } as Partial<StateField>)} />
            <label className="cfg-item grow">
              <span>初始值</span>
              <input className="input" value={f.initial} onChange={(e) => set({ initial: e.target.value } as Partial<StateField>)} />
            </label>
          </>
        )}
        {f.type === 'tags' && (
          <>
            <Num label="最多" value={f.maxItems} suffix="個" onChange={(v) => set({ maxItems: v } as Partial<StateField>)} />
            <Num label="每個最多" value={f.maxLength} suffix="字" onChange={(v) => set({ maxLength: v } as Partial<StateField>)} />
            <span className="hint">每段列出現在成立的全部標籤；可寫成「名稱：說明」</span>
          </>
        )}
        {f.type === 'zones' && (
          <>
            <Num label="Lv. 下限" value={f.levelMin} onChange={(v) => set({ levelMin: v } as Partial<StateField>)} />
            <Num label="Lv. 上限" value={f.levelMax} onChange={(v) => set({ levelMax: v } as Partial<StateField>)} />
            <Num label="每段最多變化" value={f.maxDelta} onChange={(v) => set({ maxDelta: v } as Partial<StateField>)} />
            <Num label="名稱最多" value={f.nameMaxLength} suffix="字" onChange={(v) => set({ nameMaxLength: v } as Partial<StateField>)} />
            <Num label="狀態最多" value={f.stateMaxLength} suffix="字" onChange={(v) => set({ stateMaxLength: v } as Partial<StateField>)} />
            <Names f={f} set={set} />
            <span className="hint">LLM 只回這段有變化或新出現的項目，其餘維持原樣；刪除在面板「編輯數值」做</span>
          </>
        )}
        {f.type === 'kv' && (
          <>
            <Num label="名稱最多" value={f.nameMaxLength} suffix="字" onChange={(v) => set({ nameMaxLength: v } as Partial<StateField>)} />
            <Num label="值最多" value={f.valueMaxLength} suffix="字" onChange={(v) => set({ valueMaxLength: v } as Partial<StateField>)} />
            <Names f={f} set={set} />
            <span className="hint">沒設允許的名稱時 LLM 會自己命名；不要和其他欄位重複（例：已經有心跳欄位就別在這裡再放心跳）</span>
          </>
        )}
      </div>
    </div>
  );
}
