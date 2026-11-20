// 系統核心 › 請求紀錄（[[PLAN_請求紀錄]]）：送給模型的每個請求一列；點開分「送出」「收到」，巢狀資料可摺疊。
// 10 筆一頁、沒展開的不渲染內容（使用者 2026-11-20：「太多筆的時候會很 lag」）。
import { useState } from 'react';
import { clearLog, downloadLog, logPersistError, useRequestLog, type LogEntry } from '../requestLog.ts';
import { Fold, JsonTree } from './JsonTree.tsx';

const PAGE = 10;

const host = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};
const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-TW', { hour12: false });

function Entry({ e }: { e: LogEntry }) {
  const status = e.state === 'pending' ? '進行中' : e.state === 'error' ? '失敗' : '完成';
  return (
    <Fold
      className="rl-item"
      data-state={e.state}
      summary={
        <summary className="rl-head">
          <span className="rl-purpose">{e.purpose}</span>
          <span className="rl-target mono">{e.target || '—'}</span>
          <span className="rl-host mono">{host(e.url)}</span>
          <span className="rl-time num">{time(e.at)}</span>
          <span className="rl-ms num">{e.ms !== undefined ? `${(e.ms / 1000).toFixed(1)} 秒` : '…'}</span>
          <span className={e.state === 'error' ? 'rl-status bad-t' : 'rl-status'}>
            {status}
            {e.status ? ` ${e.status}` : ''}
          </span>
        </summary>
      }
    >
      {() => (
        <div className="rl-body">
          <section aria-label="送出">
            <h4>送出</h4>
            <div className="jt">
              <div className="jt-row">
                <span className="jt-key">網址</span>
                <span className="jt-val mono">
                  {e.method} {e.url}
                </span>
              </div>
              <div className="jt-row">
                <span className="jt-key">{e.kind === 'tts' ? '引擎' : '模型'}</span>
                <span className="jt-val mono">{e.target || '—'}</span>
              </div>
            </div>
            {e.request === null ? <p className="hint">沒有 body</p> : <JsonTree value={e.request} openDepth={1} />}
          </section>
          <section aria-label="收到">
            <h4>收到</h4>
            {e.error && <div className="note danger">{e.error}</div>}
            {e.state === 'pending' && <p className="hint">還在等回應…</p>}
            {e.meta && <JsonTree value={e.meta} />}
            {e.json !== undefined ? <JsonTree value={e.json} openDepth={1} /> : e.text ? <JsonTree value={{ 內容: e.text }} /> : null}
            {e.text && e.json !== undefined && (
              <Fold className="jt-long" summary={<summary className="jt-meta">原始文字（{e.text.length.toLocaleString()} 字）</summary>}>
                {() => <pre className="jt-pre">{e.text}</pre>}
              </Fold>
            )}
          </section>
        </div>
      )}
    </Fold>
  );
}

export function RequestLog() {
  const log = useRequestLog();
  const [kind, setKind] = useState<'all' | 'llm' | 'tts'>('all');
  const [page, setPage] = useState(0);
  const shown = log.filter((e) => kind === 'all' || e.kind === kind);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const p = Math.min(page, pages - 1); // 清除或篩選後筆數變少：停在最後一頁
  const view = shown.slice(p * PAGE, (p + 1) * PAGE);
  return (
    <div className="rl">
      <div className="row rl-tools">
        <div className="seg" role="group" aria-label="篩選">
          {(
            [
              ['all', '全部'],
              ['llm', 'LLM'],
              ['tts', '語音'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className="chip"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="hint">
          {shown.length} 筆（最近 100 筆，存在這個存檔裡，重新整理、換裝置都在；圖片只留開頭）
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" disabled={!log.length} onClick={downloadLog}>
          匯出 JSON
        </button>
        <button type="button" className="btn sm" disabled={!log.length} onClick={clearLog}>
          清除
        </button>
      </div>
      {logPersistError() && (
        <div className="note danger" role="alert">
          {logPersistError()}
        </div>
      )}
      {shown.length === 0 ? <p className="hint">還沒有請求。到聆聽送出一段、或在連線設定按「測試連線」，這裡就會出現。</p> : view.map((e) => <Entry key={e.id} e={e} />)}
      {pages > 1 && (
        <nav className="row rl-tools" aria-label="分頁">
          <button type="button" className="btn sm" disabled={p === 0} onClick={() => setPage(p - 1)}>
            上一頁
          </button>
          <div className="seg" role="group" aria-label="頁碼">
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} type="button" className="chip" aria-pressed={i === p} aria-label={`第 ${i + 1} 頁`} onClick={() => setPage(i)}>
                {i + 1}
              </button>
            ))}
          </div>
          <button type="button" className="btn sm" disabled={p === pages - 1} onClick={() => setPage(p + 1)}>
            下一頁
          </button>
          <span className="hint">
            第 {p * PAGE + 1} 到 {p * PAGE + view.length} 筆，共 {shown.length} 筆
          </span>
        </nav>
      )}
    </div>
  );
}
