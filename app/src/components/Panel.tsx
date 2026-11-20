import type { ReactNode } from 'react';
// 聆聽 › 右側「X 的狀態」：照系統核心 › 秘密規則的面板版面顯示；編輯鍵＝在面板內直接改數值（ADV3.0 IntimacyPanel editMode）。
// 區塊對應 ADV3.0：zones（部位 Lv.＋狀態）、kv（身體數值，可用 include 篩選）、tags（狀態標籤，「名稱：說明」）、text（心裡話，直接顯示）。
import { tierLabel } from '@cheruno/core';
import { includeMatch, resolveLayout, type KvItem, type Snapshot, type StateField, type Zone } from '@cheruno/core';
import { useState } from 'react';
import { humanStateError, useSession } from '../session.tsx';
import type { AppData } from '../store.ts';

const splitTag = (t: string) => {
  const m = /^([^:：]+)[:：](.*)$/.exec(t);
  return m ? { label: m[1]!.trim(), desc: m[2]!.trim() } : { label: t, desc: '' };
};

export function Panel({ data }: { data: AppData }) {
  const s = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Snapshot>({});
  const [err, setErr] = useState('');
  const [peek, setPeek] = useState(false);
  const [newTag, setNewTag] = useState<Record<string, string>>({});
  const fields = data.secretFormat.fields;

  if (!s) {
    return (
      <aside className="panel" aria-label="狀態">
        <div className="panel-inner">
          <h2 style={{ fontSize: 16 }}>狀態</h2>
          <p className="hint" style={{ fontSize: 14 }}>
            建立角色並開始聆聽後，這裡會依秘密規則顯示她的狀態。
          </p>
        </div>
      </aside>
    );
  }
  const name = s.character.subName || s.character.name;
  const snap = editing ? draft : s.panel.snap;
  const prev = s.panel.prev;
  const blocks = resolveLayout(data.layout, fields);
  const set = (k: string, v: Snapshot[string]) => setDraft({ ...draft, [k]: v });

  function startEdit() {
    setDraft(structuredClone(s!.panel.snap));
    setErr('');
    setEditing(true);
  }
  function save() {
    const e = s!.editState(draft);
    // 錯誤訊息給人看：拿掉內部角色 id，欄位 key 換成名稱
    if (e) setErr(humanStateError(e, fields, s!.character.id));
    else {
      setEditing(false);
      setErr('');
    }
  }

  const delta = (f: StateField) => {
    if (f.type !== 'number' || !prev || editing) return null;
    const d = (s.panel.snap[f.key] as number) - (prev[f.key] as number);
    return d ? <span className={d > 0 ? 'd ok-t' : 'd bad-t'}>{d > 0 ? `+${d}` : d}</span> : null;
  };

  /** 數值顯示：值 單位 變化量 區間標籤（例：158 +8 熟人、80 bpm +5） */
  const numShown = (f: Extract<StateField, { type: 'number' }>) => {
    const v = snap[f.key] as number;
    const tier = tierLabel(f, v);
    return (
      <>
        <span className="v">{String(v)}</span>
        {f.unit ? <span className="hint"> {f.unit}</span> : null} {delta(f)}
        {tier ? <span className="tier"> {tier}</span> : null}
      </>
    );
  };

  function valueEditor(f: StateField) {
    const v = snap[f.key];
    if (f.type === 'number')
      return <input className="input num" type="number" min={f.min} max={f.max} value={v as number} aria-label={f.label} onChange={(e) => set(f.key, Number(e.target.value))} style={{ maxWidth: 120 }} />;
    if (f.type === 'enum')
      return (
        <select className="select" value={v as string} aria-label={f.label} onChange={(e) => set(f.key, e.target.value)}>
          {f.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    if (f.type === 'text') return <textarea className="textarea" rows={2} value={v as string} maxLength={f.maxLength} aria-label={f.label} onChange={(e) => set(f.key, e.target.value)} />;
    return null;
  }

  function zonesBlock(f: Extract<StateField, { type: 'zones' }>) {
    const list = (snap[f.key] as Zone[]) ?? [];
    const before = new Map(((prev?.[f.key] as Zone[] | undefined) ?? []).map((z) => [z.name, z.level]));
    const put = (next: Zone[]) => set(f.key, next);
    if (editing)
      return (
        <div key={f.key} className="zone-edit">
          {list.map((z, i) => (
            <div key={i} className="zone-row edit">
              <input className="input" aria-label="名稱" value={z.name} maxLength={f.nameMaxLength} onChange={(e) => put(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className="input num" type="number" aria-label="Lv." min={f.levelMin} max={f.levelMax} value={z.level} onChange={(e) => put(list.map((x, j) => (j === i ? { ...x, level: Number(e.target.value) } : x)))} />
              <input className="input" aria-label="狀態" value={z.state} maxLength={f.stateMaxLength} placeholder="狀態" onChange={(e) => put(list.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} />
              <button type="button" className="icon-x" aria-label={`刪除 ${z.name}`} onClick={() => put(list.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => put([...list, { name: `新項目${list.length + 1}`, level: f.levelMin, state: '' }])}>
            新增一筆
          </button>
        </div>
      );
    if (!list.length) return <p key={f.key} className="hint">還沒有</p>;
    return (
      <div key={f.key} className="zone-list">
        {list.map((z) => {
          const was = before.get(z.name);
          const d = prev ? z.level - (was ?? f.levelMin) : 0;
          return (
            <div key={z.name} className="zone-row">
              <span className="zn">{z.name}</span>
              <span className="num zl">
                {f.levelLabel || 'Lv.'} {z.level}
                {d !== 0 && <span className={d > 0 ? 'd ok-t' : 'd bad-t'}> {d > 0 ? `+${d}` : d}</span>}
                {was === undefined && prev && <span className="d accent"> 新</span>}
              </span>
              {z.state && <span className="zs">{z.state}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  function kvBlock(f: Extract<StateField, { type: 'kv' }>, include?: string[]) {
    const list = (snap[f.key] as KvItem[]) ?? [];
    const put = (next: KvItem[]) => set(f.key, next);
    if (editing)
      return (
        <div key={f.key} className="zone-edit">
          {list.map((x, i) => (
            <div key={i} className="kv-row edit">
              <input className="input" aria-label="名稱" value={x.name} maxLength={f.nameMaxLength} onChange={(e) => put(list.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
              <input className="input" aria-label="值" value={x.value} maxLength={f.valueMaxLength} onChange={(e) => put(list.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
              <button type="button" className="icon-x" aria-label={`刪除 ${x.name}`} onClick={() => put(list.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => put([...list, { name: `項目${list.length + 1}`, value: '' }])}>
            新增一筆
          </button>
        </div>
      );
    const shown = list.filter((x) => includeMatch(include, x.name)); // 只篩顯示；編輯時全部列出（同 ADV3.0）
    if (!shown.length) return <p key={f.key} className="hint">還沒有</p>;
    const before = new Map(((prev?.[f.key] as KvItem[] | undefined) ?? []).map((x) => [x.name, x.value]));
    return (
      <dl key={f.key} className="kv">
        {shown.map((x) => (
          <div key={x.name} style={{ display: 'contents' }}>
            <dt>{x.name}</dt>
            <dd lang="ja" className={prev && before.get(x.name) !== x.value ? 'changed' : ''}>
              {x.value || '—'}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <aside className="panel" aria-label={`${name}的狀態`} data-testid="state">
      <div className="panel-inner">
        <div className="panel-head">
          <h2>{name}的狀態</h2>
          {fields.length > 0 &&
            (editing ? (
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
                  取消
                </button>
                <button type="button" className="btn sm" onClick={save}>
                  完成
                </button>
              </span>
            ) : (
              <button type="button" className="btn sm" onClick={startEdit} title="直接修改目前的數值">
                編輯數值
              </button>
            ))}
        </div>

        {!data.ui.intimacy && <div className="note caution">一般模式：這段起不帶秘密、狀態不更新。按頂列「一般模式」切回親密模式。</div>}
        {fields.length === 0 ? (
          <p className="hint" style={{ fontSize: 14 }}>
            秘密規則還沒有欄位表。到系統核心的秘密規則分頁新增欄位，或由狀態定義產生。
          </p>
        ) : (
          blocks.map(function renderBlock(b: (typeof blocks)[number], bi: number, _all?: unknown, sub = false): ReactNode {
            const title = sub ? null : <span className="block-title">{b.title}</span>;
            // 分段：標題＋每個欄位照自己的類型顯示（數值條、欄位列、標籤、清單）
            if (b.type === 'section')
              return (
                <div key={bi} className="pblock section">
                  {title}
                  {b.fields.map((f, fi) =>
                    renderBlock({ type: f.type === 'number' ? 'bars' : f.type === 'tags' ? 'tags' : f.type === 'zones' ? 'zones' : f.type === 'kv' ? 'kv' : f.hidden ? 'text' : 'rows', title: f.label, fields: [f] }, fi, undefined, true),
                  )}
                </div>
              );
            if (b.type === 'bars')
              return (
                <div key={bi} className={sub ? 'sub' : 'pblock'}>
                  {blocks.filter((x) => x.type === 'bars').length > 1 && title}
                  {b.fields.map((f) =>
                    f.type === 'number' ? (
                      <div key={f.key} className="bar-field">
                        <div className="top-line">
                          <span className="k">{f.label}</span>
                          {editing ? (
                            valueEditor(f)
                          ) : (
                            <span className="num">{numShown(f)}</span>
                          )}
                        </div>
                        <div className="meter">
                          <div style={{ width: `${Math.min(100, Math.max(0, (((snap[f.key] as number) - f.min) / (f.max - f.min)) * 100))}%` }} />
                        </div>
                      </div>
                    ) : null,
                  )}
                </div>
              );
            if (b.type === 'rows')
              return (
                <div key={bi} className={sub ? 'sub' : 'pblock'}>
                  {blocks.filter((x) => x.type === 'rows').length > 1 && title}
                  <dl className="kv">
                    {b.fields.map((f) => (
                      <div key={f.key} style={{ display: 'contents' }}>
                        <dt>{f.label}</dt>
                        <dd lang="ja">
                          {editing ? (
                            valueEditor(f)
                          ) : f.type === 'number' ? (
                            <span className="num">{numShown(f)}</span>
                          ) : (
                            String(snap[f.key] ?? '') || '沒有'
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            if (b.type === 'zones' || b.type === 'kv')
              return (
                <div key={bi} className={sub ? 'sub' : 'pblock'}>
                  {sub ? <span className="sub-label">{b.title}</span> : title}
                  {b.fields.map((f) => (f.type === 'zones' ? zonesBlock(f) : f.type === 'kv' ? kvBlock(f, b.include) : null))}
                </div>
              );
            if (b.type === 'tags')
              return (
                <div key={bi} className={sub ? 'sub' : 'pblock'}>
                  {sub ? <span className="sub-label">{b.title}</span> : title}
                  {b.fields.map((f) => {
                    const tags = (snap[f.key] as string[]) ?? [];
                    return (
                      <div key={f.key} className="tags">
                        {tags.length === 0 && !editing && <span className="hint">沒有</span>}
                        {tags.map((t) => {
                          const { label, desc } = splitTag(t);
                          return (
                            <span key={t} className="tag-pill" title={desc || undefined}>
                              {label}
                              {editing && (
                                <button type="button" aria-label={`移除 ${label}`} onClick={() => set(f.key, tags.filter((x) => x !== t))}>
                                  ✕
                                </button>
                              )}
                            </span>
                          );
                        })}
                        {editing && f.type === 'tags' && tags.length < f.maxItems && (
                          <span className="row" style={{ gap: 6 }}>
                            <input className="input" style={{ width: 140, minHeight: 32 }} maxLength={f.maxLength} value={newTag[f.key] ?? ''} placeholder="名稱：說明" aria-label={`新增${f.label}`} onChange={(e) => setNewTag({ ...newTag, [f.key]: e.target.value })} />
                            <button
                              type="button"
                              className="btn sm"
                              disabled={!(newTag[f.key] ?? '').trim()}
                              onClick={() => {
                                set(f.key, [...tags, (newTag[f.key] ?? '').trim()]);
                                setNewTag({ ...newTag, [f.key]: '' });
                              }}
                            >
                              新增
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            if (b.type === 'text')
              return (
                <div key={bi} className={sub ? 'sub text-block' : 'pblock text-block'}>
                  {sub ? <span className="sub-label">{b.title}</span> : title}
                  {b.fields.map((f) =>
                    editing ? (
                      <label key={f.key} className="field">
                        {b.fields.length > 1 && <span>{f.label}</span>}
                        {valueEditor(f)}
                      </label>
                    ) : (
                      <p key={f.key} lang="ja" className="ja">
                        {String(snap[f.key] ?? '') || <span className="hint">還沒有</span>}
                      </p>
                    ),
                  )}
                </div>
              );
            return (
              <div key={bi} className="secret">
                <div className="head">
                  <span>{b.title}</span>
                  {!editing && (
                    <button type="button" className="btn sm" aria-pressed={peek} onClick={() => setPeek(!peek)}>
                      {peek ? '遮住' : '偷看'}
                    </button>
                  )}
                </div>
                {b.fields.map((f) =>
                  editing ? (
                    <label key={f.key} className="field">
                      <span>{f.label}</span>
                      {valueEditor(f)}
                    </label>
                  ) : peek ? (
                    <p key={f.key} lang="ja" className="ja">
                      {String(snap[f.key] ?? '') || '還沒有'}
                    </p>
                  ) : (
                    <p key={f.key} className="masked">
                      遮住中，不念出來也不進字幕。
                    </p>
                  ),
                )}
              </div>
            );
          })
        )}

        {editing && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hint">手動修改只檢查範圍與選項，不受每段變化上限限制。</span>
            <button
              type="button"
              className="btn sm danger"
              onClick={() => {
                s.resetState();
                setEditing(false);
              }}
            >
              重置成初始值
            </button>
          </div>
        )}
        {err && <div className="note danger">{err}</div>}
        {!editing &&
          s.panel.clamps.map((c, i) => (
            <div key={i} className="note caution">
              {fields.find((f) => f.key === c.key)?.label ?? c.key}：{c.detail}
            </div>
          ))}

        {s.memory.length > 0 && (
          <div className="mem">
            <span className="block-title">新記憶候選</span>
            {s.memory.map((c) => (
              <div key={c.segId + c.text} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span>{c.text}</span>
                <span className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn sm" onClick={() => s.acceptMemory(c)}>
                    存進回憶
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => s.dismissMemory(c)}>
                    略過
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="foot">
          {s.panel.n ? `這份狀態屬於第 ${s.panel.n} 段。重生或刪除第 ${s.panel.n} 段，會回到${s.panel.n > 1 ? `第 ${s.panel.n - 1} 段` : '初始'}的狀態。` : '第一段生成後，狀態會跟著每一段更新。'}
        </p>
      </div>
    </aside>
  );
}
