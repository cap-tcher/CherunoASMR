// 巢狀資料顯示（請求紀錄用）：最上層「欄位：值」排成兩欄；物件與陣列可摺疊；長字串收成一行、點開保留換行。
// 收合的內容不渲染（<details> 收著也會把子元素全建進 DOM，100 筆請求就卡；使用者 2026-11-20）。
import { useState, type ReactNode } from 'react';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const LONG = 120;

/** 展開才渲染內容的 <details>：children 是函式，收合時不呼叫 */
export function Fold({
  className,
  open: initial = false,
  summary,
  children,
  ...attrs
}: {
  className: string;
  open?: boolean;
  summary: ReactNode;
  children: () => ReactNode;
  [data: `data-${string}`]: string;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <details className={className} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} {...attrs}>
      {summary}
      {open && children()}
    </details>
  );
}

/** 陣列裡的物件用什麼當摘要：聊天訊息＝角色＋字數；有 name／id／ja 就用它 */
function itemLabel(v: unknown): string {
  if (!isObj(v)) return '';
  if (typeof v.role === 'string') {
    const c = v.content;
    const n = typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
    return `${v.role} · ${n.toLocaleString()} 字`;
  }
  for (const k of ['name', 'id', 'ja', 'key', 'type']) if (typeof v[k] === 'string' || typeof v[k] === 'number') return String(v[k]);
  return '';
}

function summary(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} 項`;
  if (isObj(v)) return `${Object.keys(v).length} 個欄位`;
  return '';
}

function Scalar({ v }: { v: unknown }) {
  if (v === null) return <span className="jt-null">null</span>;
  if (typeof v === 'boolean') return <span className="jt-bool">{String(v)}</span>;
  if (typeof v === 'number') return <span className="jt-num num">{v}</span>;
  const s = String(v);
  if (s.length <= LONG && !s.includes('\n')) return <span className="jt-str">{s === '' ? <span className="jt-null">（空字串）</span> : s}</span>;
  return (
    <Fold
      className="jt-long"
      summary={
        <summary>
          <span className="jt-str">{s.replace(/\s+/g, ' ').slice(0, 60)}…</span> <span className="jt-meta">{s.length.toLocaleString()} 字</span>
        </summary>
      }
    >
      {() => <pre className="jt-pre">{s}</pre>}
    </Fold>
  );
}

function Node({ k, v, depth, openDepth }: { k: ReactNode; v: unknown; depth: number; openDepth: number }) {
  if (!Array.isArray(v) && !isObj(v))
    return (
      <div className="jt-row">
        <span className="jt-key">{k}</span>
        <span className="jt-val">
          <Scalar v={v} />
        </span>
      </div>
    );
  const entries: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  return (
    <Fold
      className="jt-node"
      open={depth < openDepth}
      summary={
        <summary className="jt-row">
          <span className="jt-key">{k}</span>
          <span className="jt-meta">{summary(v)}</span>
        </summary>
      }
    >
      {() => (
        <div className="jt-children">
          {entries.length === 0 ? (
            <span className="jt-null">（空）</span>
          ) : (
            entries.map(([ck, cv]) => {
              const label = Array.isArray(v) ? itemLabel(cv) : '';
              return <Node key={ck} k={label ? `${Number(ck) + 1}. ${label}` : Array.isArray(v) ? `${Number(ck) + 1}.` : ck} v={cv} depth={depth + 1} openDepth={openDepth} />;
            })
          )}
        </div>
      )}
    </Fold>
  );
}

/** value 的最上層一律展開；openDepth＝再往下自動展開幾層 */
export function JsonTree({ value, openDepth = 1 }: { value: unknown; openDepth?: number }) {
  if (!Array.isArray(value) && !isObj(value)) return <Scalar v={value} />;
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((x, i) => [String(i), x]) : Object.entries(value);
  return (
    <div className="jt">
      {entries.map(([k, v]) => {
        const label = Array.isArray(value) ? itemLabel(v) : '';
        return <Node key={k} k={label ? `${Number(k) + 1}. ${label}` : Array.isArray(value) ? `${Number(k) + 1}.` : k} v={v} depth={0} openDepth={openDepth} />;
      })}
    </div>
  );
}
