// 存檔畫面：首次開啟只有這一頁。新建（空的存檔）、開啟、改名、刪除（移到存檔區的 trash）、從備份檔或舊瀏覽器資料建立。
import { useEffect, useRef, useState } from 'react';
import { DataDirPicker } from '../components/DataDirPicker.tsx';
import { deleteSave, getDataDir, renameSave, type SaveMeta } from '../saveStore.ts';
import type { SavedSession } from '../session.tsx';
import { migrate, newSaveData, type AppData, type Settings } from '../store.ts';

const fmt = (t: string) => t.replace('T', ' ').slice(0, 16);

export function SavesPage(props: {
  saves: SaveMeta[];
  current: string | null;
  hasLegacy: boolean;
  refresh: () => void;
  onOpen: (id: string) => Promise<void>;
  onCreate: (name: string, data: AppData, session: SavedSession | null) => Promise<void>;
  onImportLegacy: () => Promise<void>;
  /** 從備份檔建一個新存檔（含對話與共用庫檔） */
  onCreateFromBackup: (file: File) => Promise<void>;
  machineSettings: () => Settings;
  onDataDirChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dir, setDir] = useState<{ dataDir: string | null; locked: string | null } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<SaveMeta | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getDataDir().then(setDir, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setErr('');
    try {
      await f();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function fromBackup(f: File | undefined) {
    if (!f) return;
    await run(() => props.onCreateFromBackup(f));
  }

  return (
    <main className="saves">
      <header>
        <h1>CherunoASMR</h1>
        {dir ? <DataDirPicker current={dir.dataDir} locked={dir.locked} onChanged={props.onDataDirChanged} /> : <p className="hint">讀取存檔區…</p>}
      </header>

      <section aria-label="新建存檔" className="section">
        <h2>新建存檔</h2>
        <div className="row">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            <span>存檔名稱</span>
            <input className="input" value={name} maxLength={60} placeholder="例：澪的雨夜" onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="button" className="btn primary" style={{ alignSelf: 'end' }} disabled={busy || !name.trim()} onClick={() => void run(() => props.onCreate(name.trim(), newSaveData(props.machineSettings()), null))}>
            建立
          </button>
        </div>
        <p className="hint">新存檔是空的：沒有角色、主角、場景、圖鑑與台本，只帶預設的規則與提示詞（系統核心可以改或匯入）。</p>
        <div className="row">
          <button type="button" className="btn sm" disabled={busy} onClick={() => file.current?.click()}>
            從備份檔建立
          </button>
          {props.hasLegacy && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => void run(props.onImportLegacy)}>
              把這個瀏覽器裡的舊資料存成存檔
            </button>
          )}
          <input ref={file} type="file" accept="application/json" className="sr-only" onChange={(e) => void fromBackup(e.target.files?.[0])} />
        </div>
        {props.hasLegacy && <p className="hint">這個瀏覽器還留著存檔區之前的資料（包含測試留下的台本）。搬進存檔後才會從瀏覽器清掉；不需要的話不用理它。</p>}
      </section>

      {err && (
        <div className="note danger" role="alert">
          {err}
        </div>
      )}

      <section aria-label="存檔" className="section">
        <h2>存檔</h2>
        {props.saves.length === 0 ? (
          <p className="hint">還沒有存檔。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <colgroup>
                <col />
                <col style={{ width: 150 }} />
                <col style={{ width: 220 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>最後儲存</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.saves.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {renaming?.id === s.id ? (
                        <input
                          className="input cell"
                          autoFocus
                          aria-label="新名稱"
                          value={renaming.name}
                          maxLength={60}
                          onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && renaming.name.trim()) void run(async () => { await renameSave(s.id, renaming.name.trim()); setRenaming(null); props.refresh(); });
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                        />
                      ) : (
                        <>
                          {s.name}
                          {s.id === props.current && <span className="hint">（上次開的）</span>}
                        </>
                      )}
                    </td>
                    <td className="num" style={{ color: 'var(--color-ink-2)' }}>
                      {fmt(s.updatedAt)}
                    </td>
                    <td className="act">
                      <button type="button" className="btn sm primary" disabled={busy} onClick={() => void run(() => props.onOpen(s.id))}>
                        開啟
                      </button>
                      <button type="button" className="btn sm" disabled={busy} onClick={() => setRenaming({ id: s.id, name: s.name })}>
                        改名
                      </button>
                      <button type="button" className="btn sm danger" disabled={busy} onClick={() => setConfirmDel(s)}>
                        刪除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmDel && (
        <div className="scrim">
          <div role="alertdialog" aria-modal="true" aria-label="刪除存檔" className="dialog">
            <h2>刪除「{confirmDel.name}」？</h2>
            <p className="hint">存檔會移到存檔區的 trash 資料夾，需要時可以從那裡找回。語音與角色圖留在共用庫，其他存檔照常使用。</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setConfirmDel(null)}>
                取消
              </button>
              <button type="button" className="btn danger" onClick={() => void run(async () => { await deleteSave(confirmDel.id); setConfirmDel(null); props.refresh(); })}>
                移到 trash
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
