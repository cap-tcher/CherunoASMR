// 備份檔（使用者 2026-11-20：「下載的備份檔 沒有對話紀錄…備份檔需要涵蓋所有的可填可改動資料」）
// v3＝這個存檔的全部可改資料：AppData（設定、角色含秘密狀態、主角、場景、圖鑑、回憶、歷史、世界觀、規則、提示詞、欄位表、面板版面）
//   ＋對話（台本、每段的狀態快照、段號）＋共用庫裡被引用的檔：角色圖、鎖定聲音時的候選音（引擎聲音遺失時可重新登錄）。
// 不含：API key（金鑰不出這台電腦）、每句的合成語音（可重新合成，還原後播放時會自己合成）、請求紀錄與 App 紀錄（不是可改的資料）。
import { fetchAsset, isKey, putAsset } from './library.ts';
import { readSave } from './saveStore.ts';
import type { SavedSession } from './session.tsx';
import { migrate, type AppData } from './store.ts';

type Kind = 'image' | 'refvoice';
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' };

export interface BackupV3 {
  kind: 'cheruno-backup';
  v: 3;
  exportedAt: string;
  name: string;
  data: Omit<AppData, 'settings'> & { settings: AppData['settings'] };
  session: SavedSession | null;
  assets: Record<Kind, Record<string, { ext: string; base64: string }>>;
}

async function toBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(s: string, type: string): Blob {
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

/** 這個存檔引用的共用庫檔：角色圖、聲音鎖定時的候選音 */
function referencedKeys(d: AppData): Record<Kind, Set<string>> {
  const out: Record<Kind, Set<string>> = { image: new Set(), refvoice: new Set() };
  for (const c of d.characters) {
    if (c.image && isKey(c.image)) out.image.add(c.image);
    if (c.voice?.ref && isKey(c.voice.ref)) out.refvoice.add(c.voice.ref);
  }
  return out;
}

/** 從存檔區讀這個存檔（呼叫前先把還沒寫的寫掉）打包成 v3 備份 */
export async function buildBackup(saveId: string, machineSettings: AppData['settings']): Promise<BackupV3> {
  const f = await readSave<Omit<AppData, 'settings'>, SavedSession>(saveId);
  const data = { ...f.data, settings: { ...machineSettings, apiKey: '' } } as AppData;
  const assets: BackupV3['assets'] = { image: {}, refvoice: {} };
  const keys = referencedKeys(data);
  for (const kind of ['image', 'refvoice'] as const) {
    for (const key of keys[kind]) {
      const blob = await fetchAsset(kind, key);
      if (!blob) throw new Error(`共用庫裡找不到${kind === 'image' ? '角色圖' : '候選音'}（${key.slice(0, 8)}…），備份會不完整`);
      const ext = EXT[blob.type] ?? (kind === 'refvoice' ? 'wav' : '');
      if (!ext) throw new Error(`不認得的檔案格式：${blob.type}（${key.slice(0, 8)}…）`);
      assets[kind][key] = { ext, base64: await toBase64(blob) };
    }
  }
  return { kind: 'cheruno-backup', v: 3, exportedAt: new Date().toISOString(), name: f.meta.name, data, session: f.session && 'charId' in f.session ? f.session : null, assets };
}

export interface ParsedBackup {
  name: string | null;
  data: AppData;
  session: SavedSession | null;
  assets: BackupV3['assets'];
}

/** 讀備份檔：v3（含對話與共用庫檔）或舊的 v2（只有 AppData） */
export function parseBackup(text: string): ParsedBackup {
  const j = JSON.parse(text) as Partial<BackupV3> & Partial<AppData>;
  if (j.kind === 'cheruno-backup' && j.v === 3 && j.data) {
    if (!Array.isArray(j.data.characters)) throw new Error('備份檔的 data 不完整（沒有角色清單）');
    return { name: j.name ?? null, data: migrate(j.data as AppData), session: j.session ?? null, assets: j.assets ?? { image: {}, refvoice: {} } };
  }
  if (j.v === 2 && Array.isArray(j.characters)) return { name: null, data: migrate(j as AppData), session: null, assets: { image: {}, refvoice: {} } };
  throw new Error('不是 CherunoASMR 的備份檔（v3 或舊的 v2）');
}

/** 備份裡的共用庫檔寫回共用庫；key＝內容的 sha256，寫回去應該一樣，不一樣就是檔案壞了 */
export async function restoreAssets(assets: BackupV3['assets']): Promise<number> {
  let n = 0;
  for (const kind of ['image', 'refvoice'] as const) {
    for (const [key, a] of Object.entries(assets[kind] ?? {})) {
      const got = await putAsset(kind, a.ext, fromBase64(a.base64, kind === 'image' ? `image/${a.ext === 'jpg' ? 'jpeg' : a.ext}` : 'audio/wav'));
      if (got !== key) throw new Error(`備份裡的${kind === 'image' ? '角色圖' : '候選音'}和記錄的 key 對不上（檔案可能壞了）`);
      n++;
    }
  }
  return n;
}
