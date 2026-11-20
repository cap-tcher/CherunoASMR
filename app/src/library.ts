// 共用庫（存檔區 library，[[PLAN_存檔區與語音庫]]）：台詞語音、角色圖、參考音。存檔裡只寫 key。
import { sha256Hex } from './sha256.ts';
import { STORE_BASE } from './saveStore.ts';

export type AssetKind = 'voice' | 'image' | 'refvoice';
export const libraryUrl = (kind: AssetKind, key: string) => `${STORE_BASE}/store/library/${kind}/${key}`;
export const isKey = (v: string) => /^[0-9a-f]{64}$/.test(v);

export interface VoiceParams {
  engine: string;
  speaker: string;
  seed: number | null;
  steps: number | null;
  voice: string;
  text: string;
}

/** 和 audio/cheruno_audio/store.py 的 voice_key 一樣：sha256(引擎|聲音|seed|步數|語氣|文字) */
export async function voiceKey(p: VoiceParams): Promise<string> {
  const raw = [p.engine, p.speaker, p.seed === null ? '' : String(p.seed), p.steps === null ? '' : String(p.steps), p.voice, p.text].join('|');
  return sha256Hex(new TextEncoder().encode(raw)); // 純 JS：iPad 從區網 http 連進來時沒有 crypto.subtle
}

async function fail(r: Response, what: string): Promise<never> {
  const detail = await r.json().then((j: { detail?: unknown }) => String(j.detail ?? r.statusText), () => r.statusText);
  throw new Error(`${what}失敗（${r.status}）：${detail}`);
}

/** 庫裡有就回檔案，沒有回 null（其他錯誤丟出來） */
export async function fetchAsset(kind: AssetKind, key: string): Promise<Blob | null> {
  const r = await fetch(libraryUrl(kind, key));
  if (r.status === 404) return null;
  if (!r.ok) return fail(r, '讀語音庫');
  return r.blob();
}

const toBase64 = async (b: Blob) => {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function putVoice(key: string, p: VoiceParams, wav: Blob): Promise<void> {
  const r = await fetch(libraryUrl('voice', key), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, data_base64: await toBase64(wav) }) });
  if (!r.ok) await fail(r, '存進語音庫');
}

/** 圖片、參考音：key＝內容 sha256（伺服器算） */
export async function putAsset(kind: 'image' | 'refvoice', ext: string, data: Blob, meta: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${STORE_BASE}/store/library/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext, data_base64: await toBase64(data), meta }) });
  if (!r.ok) await fail(r, '存進共用庫');
  return ((await r.json()) as { key: string }).key;
}

/** 角色圖：存檔裡是庫 key；建立角色頁與 LLM 看圖用 data URL */
export const imageSrc = (v: string) => (isKey(v) ? libraryUrl('image', v) : v);
export async function imageToKey(v: string): Promise<string> {
  if (isKey(v)) return v;
  const blob = await (await fetch(v)).blob();
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  return putAsset('image', ext, blob);
}
export async function imageToDataUrl(v: string): Promise<string> {
  if (!isKey(v)) return v;
  const b = await fetchAsset('image', v);
  if (!b) throw new Error(`共用庫裡沒有這張角色圖（${v.slice(0, 8)}…）`);
  return new Promise((ok, bad) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result));
    fr.onerror = () => bad(fr.error);
    fr.readAsDataURL(b);
  });
}
