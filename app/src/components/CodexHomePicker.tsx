// 連線設定 › Codex 設定資料夾（[[TASKS_Codex連線]] C-06）：選 Codex 連線用哪個 CODEX_HOME。
// 存在音訊服務那邊（存檔區設定檔旁的 codex.json，這份安裝的所有存檔共用）；選資料夾的視窗由音訊服務在電腦上開。
import { useEffect, useState } from 'react';
import { isRemote } from '../remote.ts';

interface CodexStatus {
  codexHome: string | null; // app 選的；null＝用 Codex 自己的預設
  effective: string; // 實際會用的資料夾
  exists: boolean;
  codexFound: boolean;
  loggedIn: boolean;
  cancelled?: boolean;
}

async function call(base: string, path: string, init?: RequestInit): Promise<CodexStatus> {
  const r = await fetch(`${base.replace(/\/+$/, '')}/codex${path}`, init);
  if (!r.ok) throw new Error(await r.json().then((j: { detail?: unknown }) => String(j.detail ?? r.statusText), () => `HTTP ${r.status}`));
  return (await r.json()) as CodexStatus;
}

export function CodexHomePicker(props: { audioBase: string }) {
  const [st, setSt] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function run(p: Promise<CodexStatus>) {
    setBusy(true);
    setErr('');
    try {
      setSt(await p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(call(props.audioBase, '/settings'));
  }, [props.audioBase]);

  const state = !st
    ? null
    : !st.codexFound
      ? { bad: true, text: '找不到 codex 指令：先安裝 Codex CLI（npm i -g @openai/codex）' }
      : !st.exists
        ? { bad: true, text: '這個資料夾不存在' }
        : !st.loggedIn
          ? { bad: true, text: `還沒登入：在終端機設 CODEX_HOME 為這個資料夾後執行 codex login` }
          : { bad: false, text: '已登入' };

  return (
    <div className="dd-line">
      <span className="hint">
        {st ? (st.codexHome ? st.effective : `Codex 預設（${st.effective}）`) : '讀取中…'}
        {state && <span className={state.bad ? ' bad-t' : ' ok-t'}>　{state.text}</span>}
      </span>
      {isRemote() ? (
        <span className="hint">（選資料夾的視窗會開在電腦上，要換請在電腦上按）</span>
      ) : (
        <>
          <button type="button" className="btn sm" disabled={busy} title="Codex 連線用哪個設定資料夾（CODEX_HOME）：登入資訊、模型、指示檔都在裡面" onClick={() => void run(call(props.audioBase, '/settings/pick', { method: 'POST' }))}>
            {busy ? '在系統視窗裡選資料夾…' : '選擇資料夾…'}
          </button>
          {st?.codexHome && (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void run(call(props.audioBase, '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codexHome: '' }) }))}>
              改用預設
            </button>
          )}
        </>
      )}
      {err && (
        <div className="note danger" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
