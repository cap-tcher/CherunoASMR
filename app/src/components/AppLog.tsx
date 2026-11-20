// 系統核心 › App 紀錄：app 做了什麼的經過，一行一個事件（新的在上）
import { useState } from 'react';
import { appLogError, clearAppLog, useAppLog } from '../appLog.ts';
import { download } from '../store.ts';

const time = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString('zh-TW', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const brief = (d?: Record<string, unknown>) =>
  d
    ? Object.entries(d)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('  ')
    : '';

export function AppLog() {
  const log = useAppLog();
  const [q, setQ] = useState('');
  const shown = q ? log.filter((e) => `${e.ev} ${brief(e.detail)}`.includes(q)) : log;
  return (
    <div className="rl">
      <div className="row rl-tools">
        <label className="grow" style={{ display: 'flex', minWidth: 0 }}>
          <span className="sr-only">篩選</span>
          <input className="input" value={q} placeholder="篩選（例：line.status、play、gen）" onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="hint">{shown.length} 筆（最近 500 筆，存在這個存檔裡）</span>
        <button type="button" className="btn sm" disabled={!log.length} onClick={() => download(`app-log-${new Date().toISOString().slice(0, 19)}.json`, JSON.stringify(log, null, 2))}>
          匯出 JSON
        </button>
        <button type="button" className="btn sm" disabled={!log.length} onClick={clearAppLog}>
          清除
        </button>
      </div>
      {appLogError() && (
        <div className="note danger" role="alert">
          {appLogError()}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="hint">還沒有事件。到聆聽送出一段，這裡就會記下生成、合成、播放的每一步。</p>
      ) : (
        <ol className="al-list">
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="num al-t">{time(e.at)}</span>
              <span className="hint al-d">{e.dev}</span>
              <span className="al-e">{e.ev}</span>
              <span className="al-x">{brief(e.detail)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
