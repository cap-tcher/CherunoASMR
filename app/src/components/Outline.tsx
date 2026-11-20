// 設定類頁面的共用版面（[[SCR-03_設定頁版面]]）：左側可展開的 outline（分類 → 區塊），右側單欄線性表單。
import { useEffect, useState, type ReactNode } from 'react';

export interface OutlineCat<K extends string> {
  k: K;
  label: string;
  note?: string;
  /** 分類群組標題（例：設定、檢查）；同群組連續排在一起 */
  group?: string;
  /** 這個分類裡的區塊（Sec 的 id 與標題）；只有一個區塊時 outline 不列 */
  sections: { id: string; label: string }[];
}

/** 捲到某個區塊（換分類後等畫面出來再捲） */
export function scrollToSection(id: string) {
  const go = () => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1200);
    return true;
  };
  if (!go()) window.setTimeout(go, 60);
}

export function Outline<K extends string>(props: { title: string; label: string; cats: OutlineCat<K>[]; current: K; onSelect: (k: K) => void }) {
  const { cats, current } = props;
  const [open, setOpen] = useState<Set<K>>(() => new Set([current]));
  const [active, setActive] = useState<string | null>(null);
  const cur = cats.find((c) => c.k === current);

  // 換分類時只展開目前這個（其他的可以手動按 ▸ 展開），outline 才不會越點越長
  useEffect(() => setOpen(new Set([current])), [current]);

  // 捲動時標出目前區塊：最上面一個進入視窗上方 40% 的區塊
  useEffect(() => {
    const ids = cur?.sections.map((s) => s.id) ?? [];
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = ids.find((id) => seen.get(id));
        if (first) setActive(first);
      },
      { rootMargin: '0px 0px -60% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [current, cur?.sections.map((s) => s.id).join('|')]);

  let lastGroup: string | undefined;
  return (
    <nav aria-label={props.label} className="outline">
      <h1>{props.title}</h1>
      {cats.map((c) => {
        const header = c.group && c.group !== lastGroup ? <div className="outline-group">{c.group}</div> : null;
        lastGroup = c.group;
        const expandable = c.sections.length > 1;
        const isOpen = expandable && open.has(c.k);
        return (
          <div key={c.k} className="outline-cat">
            {header}
            <div className="outline-row" aria-current={c.k === current ? 'page' : undefined}>
              {expandable ? (
                <button
                  type="button"
                  className="outline-toggle"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? '收合' : '展開'}${c.label}`}
                  onClick={() =>
                    setOpen((s) => {
                      const n = new Set(s);
                      if (n.has(c.k)) n.delete(c.k);
                      else n.add(c.k);
                      return n;
                    })
                  }
                >
                  {isOpen ? '▾' : '▸'}
                </button>
              ) : (
                <span className="outline-toggle" aria-hidden="true" />
              )}
              <button type="button" className="outline-label" onClick={() => props.onSelect(c.k)}>
                <span>{c.label}</span>
                {c.note && (
                  <span className="outline-note" title={c.note}>
                    {c.note}
                  </span>
                )}
              </button>
            </div>
            {isOpen && (
              <div className="outline-secs">
                {c.sections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={c.k === current && active === s.id ? 'location' : undefined}
                    onClick={() => {
                      if (c.k !== current) props.onSelect(c.k);
                      scrollToSection(s.id);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** 一個區塊：卡片＋標題＋一句說明；id 給 outline 跳轉 */
export function Sec(props: { id: string; title: string; desc?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={props.id} aria-labelledby={`${props.id}-h`} className="lin-sec card">
      <div className="lin-sec-head">
        <div>
          <h3 id={`${props.id}-h`}>{props.title}</h3>
          {props.desc && <p className="lin-hint">{props.desc}</p>}
        </div>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/** 一個欄位：標籤 → 說明 → 控制項，垂直排。控制項只有一個輸入框時用 label 包住；有按鈕、表格時傳 as="div" */
export function Field(props: { label: ReactNode; hint?: ReactNode; as?: 'label' | 'div'; children: ReactNode }) {
  const body = (
    <>
      <span className="lin-label">{props.label}</span>
      {props.hint && <span className="lin-hint">{props.hint}</span>}
      {props.children}
    </>
  );
  return props.as === 'div' ? <div className="lin-field">{body}</div> : <label className="lin-field">{body}</label>;
}

/** 勾選欄位：勾選框在左、標籤與說明在右（說明可以折行） */
export function Check(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="lin-check">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>
        <span className="lin-label">{props.label}</span>
        {props.hint && <span className="lin-hint">{props.hint}</span>}
      </span>
    </label>
  );
}
