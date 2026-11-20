// 存檔區（音訊服務 /store，[[PLAN_存檔區與語音庫]]）：設定、存檔、共用庫。app 不把資料存在瀏覽器。
// 存檔區的位址是本機音訊服務（設定本身就存在這裡，不能從設定讀）；VITE_STORE_BASE 只給測試用另一套隔離的存檔區
export const STORE_BASE: string = import.meta.env.VITE_STORE_BASE ?? 'http://127.0.0.1:8790';

export interface SaveMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveFile<D, S> {
  meta: SaveMeta;
  data: D;
  session: S | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(STORE_BASE + '/store' + path, init);
  } catch (e) {
    throw new Error(`連不上存檔區（音訊服務 ${STORE_BASE}）：${e instanceof Error ? e.message : String(e)}。先執行 startserver.bat`);
  }
  if (!r.ok) {
    const detail = await r.json().then((j: { detail?: unknown }) => String(j.detail ?? r.statusText), () => r.statusText);
    throw new Error(`存檔區回 ${r.status}：${detail}`);
  }
  return (await r.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const storeInfo = () => call<{ dataDir: string }>('/info');
export const getDataDir = () => call<{ dataDir: string | null; locked: string | null; configFile: string }>('/datadir');
/** 開系統的選資料夾視窗（音訊服務在本機開），選了就切換；cancelled＝使用者按了取消 */
export const pickDataDir = () => call<{ dataDir: string | null; cancelled: boolean }>('/datadir/pick', { method: 'POST' });
export const getSettings = <T>() => call<{ settings: T | null }>('/settings').then((r) => r.settings);
export const putSettings = (s: unknown) => call<{ ok: true }>('/settings', json('PUT', s));
export const listSaves = () => call<SaveMeta[]>('/saves');
export const createSave = (name: string, data: unknown, session: unknown = null) => call<SaveMeta>('/saves', json('POST', { name, data, session }));
export const readSave = <D, S>(id: string) => call<SaveFile<D, S>>(`/saves/${id}`);
export const putSaveData = (id: string, data: unknown) => call<SaveMeta>(`/saves/${id}/data`, json('PUT', data));
export const putSaveSession = (id: string, session: unknown) => call<SaveMeta>(`/saves/${id}/session`, json('PUT', session));
export const renameSave = (id: string, name: string) => call<SaveMeta>(`/saves/${id}`, json('PATCH', { name }));
export const deleteSave = (id: string) => call<{ trashed: string }>(`/saves/${id}`, { method: 'DELETE' });

/** 防抖寫入：資料變動後 wait 毫秒沒再變才寫；寫入中又變就等這次寫完再寫最新的。flush＝馬上寫完（切換存檔、離開頁面）。 */
export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'error'; message: string };
export interface Writer<T> {
  push: (v: T) => void;
  flush: () => Promise<void>;
}
export function debouncedWriter<T>(write: (v: T) => Promise<unknown>, onState: (s: SaveState) => void, wait = 500): Writer<T> {
  let timer = 0;
  let pending: { v: T } | null = null;
  let running: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    while (pending) {
      const { v } = pending;
      pending = null;
      onState({ kind: 'saving' });
      try {
        await write(v);
        if (!pending) onState({ kind: 'saved' });
      } catch (e) {
        onState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  const start = () => {
    running ??= run().finally(() => {
      running = null;
      if (pending) start();
    });
    return running;
  };
  return {
    push: (v) => {
      pending = { v };
      onState({ kind: 'saving' });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void start(), wait);
    },
    flush: async () => {
      window.clearTimeout(timer);
      while (pending || running) await start();
    },
  };
}
