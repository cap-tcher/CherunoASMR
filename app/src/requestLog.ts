// 請求紀錄（[[PLAN_請求紀錄]]）：送給模型的每個請求（LLM、TTS）記下 payload 與收到的內容，給系統核心 › 請求紀錄看。
// 每筆做完（成功或失敗）就寫進存檔區的 requests/<存檔 id>.jsonl，開存檔時讀回來：重新整理、換頁、換裝置（iPad）都看得到
// （使用者 2026-11-20：「請求記錄沒寫進存檔」）。只留最近 MAX 筆；可匯出 JSON。
import { useSyncExternalStore } from 'react';
import { STORE_BASE } from './saveStore.ts';

export interface LogEntry {
  id: string; // 時間＋亂數：電腦和 iPad 同時記也不會撞號
  at: string; // ISO 時間
  purpose: string; // 台詞、狀態、角色卡、語音合成…
  kind: 'llm' | 'tts';
  url: string;
  method: string;
  /** 送到哪：LLM 是模型 id，TTS 是引擎 */
  target: string;
  request: unknown; // 解析後的 request body（JSON）；不是 JSON 就是原文
  state: 'pending' | 'done' | 'error';
  status?: number;
  ms?: number;
  /** 收到：LLM 串流組回來的完整文字；一般 JSON 回應的原文 */
  text?: string;
  /** 收到：text 解析成 JSON（解析不了就沒有） */
  json?: unknown;
  /** 收到：二進位回應（音檔）只記大小與標頭 */
  meta?: Record<string, string | number>;
  error?: string;
}

const MAX = 100; // 只留最近 100 筆（使用者 2026-11-20）；存檔區那份也是 100 筆
let entries: LogEntry[] = [];
let saveId: string | null = null;
/** 寫進存檔區失敗的原因（畫面顯示，不默默丟掉） */
let persistError = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const reqUrl = (id: string) => `${STORE_BASE}/store/saves/${id}/requests`;

/** 圖片這類 data URL 一張就好幾 MB：存檔裡只留開頭與長度，文字與參數照存 */
function shrink(v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith('data:') && v.length > 2000 ? `${v.slice(0, 48)}…（省略 ${v.length} 字元）` : v;
  if (Array.isArray(v)) return v.map(shrink);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
}

function persist(e: LogEntry) {
  if (!saveId) return;
  fetch(reqUrl(saveId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shrink(e)) }).then(
    (r) => {
      if (r.ok) return;
      persistError = `請求紀錄寫不進存檔區（HTTP ${r.status}）`;
      emit();
    },
    (err: unknown) => {
      persistError = `請求紀錄寫不進存檔區：${err instanceof Error ? err.message : String(err)}`;
      emit();
    },
  );
}

function put(e: LogEntry) {
  const i = entries.findIndex((x) => x.id === e.id);
  entries = i >= 0 ? entries.map((x) => (x.id === e.id ? e : x)) : [e, ...entries].slice(0, MAX);
  if (e.state !== 'pending') persist(e); // 做完才寫：一筆一行
  emit();
}

/** 開存檔時呼叫：讀回這個存檔的請求紀錄；之後的請求都寫進它 */
export async function attachLog(id: string | null) {
  saveId = id;
  persistError = '';
  entries = [];
  emit();
  if (!id) return;
  const r = await fetch(reqUrl(id));
  if (!r.ok) throw new Error(`讀請求紀錄失敗（HTTP ${r.status}）`);
  entries = ((await r.json()) as LogEntry[]).slice(0, MAX);
  emit();
}

export const clearLog = () => {
  entries = [];
  emit();
  if (saveId)
    fetch(reqUrl(saveId), { method: 'DELETE' }).then(
      (r) => {
        if (!r.ok) persistError = `清不掉存檔區的請求紀錄（HTTP ${r.status}）`;
        emit();
      },
      (err: unknown) => {
        persistError = `清不掉存檔區的請求紀錄：${String(err)}`;
        emit();
      },
    );
};
export const logSnapshot = () => entries;
export const logPersistError = () => persistError;
export function useRequestLog(): LogEntry[] {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => entries,
  );
}

const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined; // 不是 JSON：只顯示原文（記錄用，不影響請求本身）
  }
};

/** SSE（OpenAI 串流）組回完整文字：把每個 data 的 delta.content 接起來；有 error 也記下 */
function joinSse(raw: string): { text: string; error?: string } {
  let text = '';
  let error: string | undefined;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const d = t.slice(5).trim();
    if (d === '[DONE]') continue;
    const c = tryJson(d) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } } | undefined;
    if (c?.error) error = c.error.message ?? d;
    text += c?.choices?.[0]?.delta?.content ?? '';
  }
  return error ? { text, error } : { text };
}

/** 從聊天請求的 schema 判斷用途（同一個 generateSegment 會送台詞與狀態兩種） */
function chatPurpose(body: unknown, fallback: string): string {
  const props = (body as { response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } } })?.response_format?.json_schema?.schema?.properties;
  if (!props) return fallback;
  if ('lines' in props) return '台詞';
  if ('state' in props) return '狀態';
  return fallback;
}

/** 會記錄的 fetch：用途寫在 purpose；回應用 tee 分一份讀完記錄，另一份照常交給呼叫端（串流不會變慢） */
export function traced(purpose: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const request = bodyText === undefined ? null : (tryJson(bodyText) ?? bodyText);
    const isChat = /\/chat\/completions$/.test(url);
    const isTts = /\/tts$|\/voice\/register$/.test(url);
    const target = isChat || /\/models$/.test(url) ? String((request as { model?: unknown })?.model ?? '（列出模型）') : isTts ? String((request as { engine?: unknown })?.engine ?? '') : '';
    // 斷線重連時 core 會輪詢 /models 等端點恢復：標成「等端點恢復」，和真正的連線測試分開
    const p = isChat ? chatPurpose(request, purpose) : /\/models$/.test(url) && purpose !== '連線測試' ? `${purpose}：等端點恢復` : purpose;
    const e: LogEntry = { id: newId(), at: new Date().toISOString(), purpose: p, kind: isTts ? 'tts' : 'llm', url, method, target, request, state: 'pending' };
    put(e);
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      put({ ...e, state: 'error', ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    const base = { ...e, status: res.status };
    if (!res.body) {
      put({ ...base, state: res.ok ? 'done' : 'error', ms: Math.round(performance.now() - t0) });
      return res;
    }
    const [mine, theirs] = res.body.tee();
    const type = res.headers.get('content-type') ?? '';
    void (async () => {
      try {
        if (/audio|octet-stream/.test(type)) {
          const bytes = (await new Response(mine).arrayBuffer()).byteLength;
          const meta: Record<string, string | number> = { 'content-type': type, 大小: `${(bytes / 1024).toFixed(1)} KB` };
          const synth = res.headers.get('X-Synth-Ms');
          if (synth) meta['合成毫秒'] = Number(synth);
          put({ ...base, state: res.ok ? 'done' : 'error', ms: Math.round(performance.now() - t0), meta });
          return;
        }
        const raw = await new Response(mine).text();
        const sse = /event-stream/.test(type) || /^\s*data:/.test(raw);
        const { text, error } = sse ? joinSse(raw) : { text: raw, error: undefined };
        const json = tryJson(text);
        put({ ...base, state: res.ok && !error ? 'done' : 'error', ms: Math.round(performance.now() - t0), text, ...(json !== undefined ? { json } : {}), ...(error ? { error } : !res.ok ? { error: `HTTP ${res.status}` } : {}) });
      } catch (err) {
        put({ ...base, state: 'error', ms: Math.round(performance.now() - t0), error: `讀回應失敗：${err instanceof Error ? err.message : String(err)}` });
      }
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

export function downloadLog() {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cheruno-requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
