// openai-compatible adapter：LM Studio（localhost:1234/v1）、llama.cpp server、Ollama（localhost:11434/v1）共用。
// 「測試連線」＝GET {base}/models，結果分六種（借鏡 Obsidian Copilot V4 的分類，只參考設計）。
import type { ChatMessage } from './prompt.ts';

export interface LlmEndpoint {
  baseUrl: string; // 例：http://localhost:1234/v1
  apiKey: string; // 本機後端留空
  /** 送 reasoning_effort: "none"：關掉會先思考的模型（Gemma 4 等）的思考，台詞才不會等很久（2026-11-19 實測 LM Studio 有效） */
  noThinking?: boolean;
}

export type ConnectionResult =
  | { kind: 'ok'; models: string[] }
  | { kind: 'invalid_key' | 'rate_limited' | 'http_error'; status: number; message: string; hint?: string }
  | { kind: 'timeout' | 'network'; message: string };

type FetchFn = typeof fetch;

const trimBase = (b: string) => b.trim().replace(/\/+$/, '');

function headers(ep: LlmEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey.trim()) h.Authorization = `Bearer ${ep.apiKey.trim()}`;
  return h;
}

export class LlmHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * 斷線重連（[[PLAN_斷線重連與重新開始]]）：只認連線類錯誤——LM Studio 引擎中斷（串流錯誤「terminated」「predict request failed」「fetch failed」、模型被卸載）、
 * 連不上（fetch 丟 TypeError）、伺服器 5xx、閒置逾時。模型輸出格式錯、HTTP 4xx、使用者按停止都不算，照常報錯。
 */
export function isReconnectable(e: unknown): boolean {
  if (e instanceof LlmIdleError) return true;
  // 「Model unloaded」：LM Studio 閒置卸載、JIT 換模型或被手動卸載；重送時 LM Studio 會自己再載入
  if (e instanceof LlmHttpError) return e.status >= 500 || /terminated|predict request failed|fetch failed|ECONNRESET|socket hang up|model (is )?unloaded|not loaded|no model/i.test(e.message);
  if (e instanceof TypeError) return /fetch|network|terminated|ECONNREFUSED|ECONNRESET/i.test(e.message);
  return false;
}

/** 等端點恢復：每 2 秒試一次 GET {base}/models，回 200 就好；超過 timeoutMs 丟錯（使用者按停止也會停） */
export async function waitReady(ep: LlmEndpoint, opts: { timeoutMs?: number; intervalMs?: number; fetchFn?: FetchFn; signal?: AbortSignal } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60000);
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const r = await testConnection(ep, { timeoutMs: 5000, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
    if (r.kind === 'ok') return;
    if (Date.now() > deadline) throw new Error(`LLM 端點 ${Math.round((opts.timeoutMs ?? 60000) / 1000)} 秒內沒有恢復（${r.message}）`);
    await new Promise((ok) => setTimeout(ok, opts.intervalMs ?? 2000));
  }
}

export async function testConnection(ep: LlmEndpoint, opts: { timeoutMs?: number; fetchFn?: FetchFn } = {}): Promise<ConnectionResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = trimBase(ep.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetchFn(`${base}/models`, { headers: headers(ep), signal: ctrl.signal });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) return { kind: 'invalid_key', status: res.status, message: text.slice(0, 200) };
    if (res.status === 429) return { kind: 'rate_limited', status: res.status, message: text.slice(0, 200) };
    if (!res.ok) {
      const hint = res.status === 404 && !/\/v1$/.test(base) ? `網址結尾可能少了 /v1（試試 ${base}/v1）` : undefined;
      return { kind: 'http_error', status: res.status, message: text.slice(0, 200), ...(hint ? { hint } : {}) };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'http_error', status: res.status, message: `回應不是 JSON：${text.slice(0, 120)}` };
    }
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return { kind: 'http_error', status: res.status, message: '回應沒有 data 陣列，可能不是 OpenAI 相容端點' };
    return { kind: 'ok', models: data.map((m) => String((m as { id?: unknown }).id).replace(/^models\//, '')) }; // Gemini 有時帶 models/ 前綴
  } catch (e) {
    if (ctrl.signal.aborted) return { kind: 'timeout', message: `${opts.timeoutMs ?? 8000} ms 內沒有回應` };
    return { kind: 'network', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  schema: object; // response_format: json_schema
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** 多久沒收到任何資料就放棄並報錯（預設 120 秒，留給模型冷啟動載入）；2026-11-19 實測 LM Studio 偶爾卡住不回 */
  idleMs?: number;
}

/**
 * 一次性的請求（角色卡、圖鑑、欄位表、章節整理）用：遇到連線類錯誤（isReconnectable）就等一下、等端點恢復再重送。
 * LM Studio 偶爾在生成完才中斷（串流錯誤「terminated」，2026-11-20 生成角色卡時遇到），重送結果一樣，所以重送是安全的。
 */
export async function streamChatRetry(ep: LlmEndpoint, req: ChatRequest, fetchFn: FetchFn = fetch, opts: { attempts?: number; delayMs?: number } = {}): Promise<string> {
  const attempts = opts.attempts ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamChat(ep, req, fetchFn);
    } catch (e) {
      if (req.signal?.aborted || attempt >= attempts || !isReconnectable(e)) throw e;
      await new Promise((ok) => setTimeout(ok, opts.delayMs ?? 3000));
      await waitReady(ep, { fetchFn, ...(req.signal ? { signal: req.signal } : {}) });
    }
  }
}

/** Google Gemini 的 OpenAI 相容端點（aistudio.google.com/docs/openai；datasets/gemini-api） */
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const isGemini = (baseUrl: string) => /generativelanguage\.googleapis\.com/.test(baseUrl);

/** OpenAI 官方 API（developers.openai.com/api/docs；datasets/openai-api） */
export const OPENAI_BASE = 'https://api.openai.com/v1';
export const isOpenAI = (baseUrl: string) => /api\.openai\.com/.test(baseUrl);

/**
 * 「關掉思考」送什麼：Gemini 只有 2.5 能用 none 關掉，3、4 關不掉、最低是 minimal（官方文件）；
 * OpenAI 的 gpt-6.2-astra／sol 沒有 none、最低是 low，其他（terra、luna 等）有 none（官方模型頁 2026-11-20）；其他端點（LM Studio）送 none
 */
export function thinkingOff(baseUrl: string, model: string): string {
  if (isOpenAI(baseUrl)) return /astra|sol/.test(model) ? 'low' : 'none';
  if (!isGemini(baseUrl)) return 'none';
  return /gemini-2\.5/.test(model) ? 'none' : 'minimal';
}

/**
 * OpenAI strict 模式只收 JSON Schema 的子集（Structured Outputs「Supported schemas」）：字串只有 pattern／format，沒有 minLength／maxLength；
 * 每個物件都要 additionalProperties: false、所有欄位都在 required。拿掉不支援的關鍵字；物件不符合就直接丟錯並指出位置（不靜靜送出去等 400）。
 * 拿掉的長度上限改由解析時的檢查與提示詞約束（OpenAI 模型遵守格式，不像小模型會把 JSON 碎片塞進字串）。
 */
const OPENAI_UNSUPPORTED = new Set(['minLength', 'maxLength', 'uniqueItems', 'default']);
export function toOpenAiStrict(schema: unknown, path = '$'): unknown {
  if (Array.isArray(schema)) return schema.map((x, i) => toOpenAiStrict(x, `${path}[${i}]`));
  if (!schema || typeof schema !== 'object') return schema;
  const o = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (OPENAI_UNSUPPORTED.has(k)) continue;
    // properties／$defs 的鍵是欄位名，不是關鍵字：只往下轉值
    if ((k === 'properties' || k === '$defs' || k === 'definitions') && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toOpenAiStrict(pv, `${path}.${k}.${pk}`)]));
    } else out[k] = toOpenAiStrict(v, `${path}.${k}`);
  }
  if (o.type === 'object' && o.properties) {
    const keys = Object.keys(o.properties as object);
    const req = new Set((o.required as string[] | undefined) ?? []);
    const missing = keys.filter((k) => !req.has(k));
    if (o.additionalProperties !== false) throw new Error(`OpenAI strict 格式不合：${path} 沒有 additionalProperties: false`);
    if (missing.length) throw new Error(`OpenAI strict 格式不合：${path} 的 ${missing.join('、')} 不在 required`);
  }
  return out;
}

/** Gemini 的模型清單裡大部分不是聊天用的（TTS、embedding、生圖、音樂、Live、轉錄…）：選單只列聊天模型 */
export function chatModels(baseUrl: string, models: string[]): string[] {
  const notChat = isGemini(baseUrl)
    ? /embed|tts|image|imagen|veo|lyria|live|transcribe|translate|robotics|genie|aqa|deep-research|antigravity|decision|nano-banana|omni/i
    : isOpenAI(baseUrl)
      ? /embed|tts|whisper|transcribe|image|dall-e|realtime|live|audio|moderation|sora|search|cyber|computer-use|davinci|babbage|codex/i
      : /embed/i;
  return models.filter((m) => !notChat.test(m));
}

/** LLM 太久沒回任何資料：和使用者按「停止」分開，讓畫面說清楚原因 */
export class LlmIdleError extends Error {}

/** 串流 chat completions（SSE）。回傳完整文字。 */
export async function streamChat(ep: LlmEndpoint, req: ChatRequest, fetchFn: FetchFn = fetch): Promise<string> {
  const idleMs = req.idleMs ?? 120_000;
  const ctrl = new AbortController();
  let idle = false;
  const onOuter = () => ctrl.abort();
  req.signal?.addEventListener('abort', onOuter);
  let timer = 0 as unknown as ReturnType<typeof setTimeout>;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      ctrl.abort();
    }, idleMs);
  };
  kick();
  try {
    return await streamOnce(ep, req, fetchFn, ctrl.signal, kick);
  } catch (e) {
    if (idle) throw new LlmIdleError(`LLM ${Math.round(idleMs / 1000)} 秒沒有回任何資料，已放棄這段（模型可能卡住或還在載入；確認 LM Studio／端點正常後按重試）`);
    throw e;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onOuter);
  }
}

async function streamOnce(ep: LlmEndpoint, req: ChatRequest, fetchFn: FetchFn, signal: AbortSignal, kick: () => void): Promise<string> {
  const res = await fetchFn(`${trimBase(ep.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(ep),
    signal,
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      temperature: req.temperature,
      // OpenAI 的 max_tokens 已淘汰、改 max_completion_tokens（含思考用的 token）
      ...(isOpenAI(ep.baseUrl) ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      ...(ep.noThinking ? { reasoning_effort: thinkingOff(ep.baseUrl, req.model) } : {}),
      response_format: { type: 'json_schema', json_schema: { name: 'segment', strict: true, schema: isOpenAI(ep.baseUrl) ? toOpenAiStrict(req.schema) : req.schema } },
    }),
  });
  if (!res.ok || !res.body) throw new LlmHttpError(res.status, `LLM 回應 ${res.status}：${(await res.text()).slice(0, 300)}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    kick();
    pending += value;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
      if (chunk.error) throw new LlmHttpError(res.status, `LLM 串流錯誤：${chunk.error.message ?? data}`);
      const d = chunk.choices?.[0]?.delta?.content;
      if (d) {
        full += d;
        req.onDelta(d);
      }
    }
  }
  return full;
}
