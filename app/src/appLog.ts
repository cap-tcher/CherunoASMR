// App 紀錄（使用者 2026-11-20：「你可能要額外寫一個app log 這樣比較好追蹤」）：app 自己做了什麼的經過——送出、生成開始／結束／重連、
// 每句的合成與播放狀態、單獨播放、暫停與繼續（含原因）、自動播放被擋、未處理的錯誤。請求內容在「請求紀錄」，這裡只記事件。
// 每 2 秒一批寫進存檔區 events/<存檔 id>.jsonl（最近 500 筆），開存檔時讀回來；系統核心 › App 紀錄看。
import { useSyncExternalStore } from 'react';
import { STORE_BASE } from './saveStore.ts';

export interface AppEvent {
  at: string; // ISO 時間（含毫秒）
  ev: string; // 事件名，例：line.status、gen.start、play.solo
  detail?: Record<string, unknown>;
  dev: string; // 哪台裝置：電腦／iPad…（同一個存檔兩邊都在用時分得出來）
}

const MAX = 500;
let entries: AppEvent[] = [];
let pending: AppEvent[] = [];
let saveId: string | null = null;
let persistError = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const url = (id: string) => `${STORE_BASE}/store/saves/${id}/events`;
const DEV = /iPad|iPhone|Macintosh.*Mobile/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'iPad' : location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '電腦' : `遠端 ${location.hostname}`;

export function appLog(ev: string, detail?: Record<string, unknown>) {
  const e: AppEvent = { at: new Date().toISOString(), ev, dev: DEV, ...(detail ? { detail } : {}) };
  entries = [e, ...entries].slice(0, MAX);
  if (saveId) pending.push(e);
  emit();
}

function flush() {
  if (!saveId || !pending.length) return;
  const batch = pending;
  pending = [];
  fetch(url(saveId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) }).then(
    (r) => {
      if (r.ok) return;
      persistError = `App 紀錄寫不進存檔區（HTTP ${r.status}）`;
      emit();
    },
    (err: unknown) => {
      persistError = `App 紀錄寫不進存檔區：${err instanceof Error ? err.message : String(err)}`;
      emit();
    },
  );
}
window.setInterval(flush, 2000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
window.addEventListener('error', (e) => appLog('error.uncaught', { message: e.message, at: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => appLog('error.unhandled', { message: e.reason instanceof Error ? e.reason.message : String(e.reason) }));

/** 開存檔時呼叫：讀回這個存檔的 App 紀錄；之後的事件都寫進它 */
export async function attachAppLog(id: string | null) {
  flush();
  saveId = id;
  persistError = '';
  pending = [];
  entries = [];
  emit();
  if (!id) return;
  const r = await fetch(url(id));
  if (!r.ok) throw new Error(`讀 App 紀錄失敗（HTTP ${r.status}）`);
  entries = ((await r.json()) as AppEvent[]).slice(0, MAX);
  emit();
  appLog('save.open', { save: id });
}

export function clearAppLog() {
  entries = [];
  pending = [];
  emit();
  if (saveId) void fetch(url(saveId), { method: 'DELETE' });
}
export const appLogError = () => persistError;
export function useAppLog(): AppEvent[] {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => entries,
  );
}
