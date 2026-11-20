// 服務按需啟動（[[PLAN_服務按需啟動]]）：按「連線」才請音訊服務開 LM Studio、載入模型、啟動 TTS 引擎。
export type TtsService = 'zonos' | 'irodori' | 'qwen';
/** installed：引擎裝好了沒（startserver 選裝；公開版沒有 Irodori）；missing：沒裝好時缺什麼 */
export interface TtsStatus {
  running: boolean;
  ready: boolean;
  installed: boolean;
  missing: string | null;
  log: string;
}
export interface ServiceStatus {
  zonos: TtsStatus;
  irodori: TtsStatus;
  qwen: TtsStatus;
  /** loading：伺服器上正在載入的模型（不管是哪個頁面按的；電腦、iPad、重新整理後都看得到） */
  lmstudio: { running: boolean; models: { id: string; state: string; type: string }[]; loading: { model: string; seconds: number | null } | null }; // seconds 為 null＝不是從這裡按的（LM Studio 自動載入或卡住）
}

const trim = (b: string) => b.trim().replace(/\/+$/, '');

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(trim(base) + path, init);
  } catch (e) {
    throw new Error(`音訊服務連不上（${base}）：${e instanceof Error ? e.message : String(e)}。先執行 startserver.bat`);
  }
  if (!r.ok) {
    const detail = await r.json().then((j: { detail?: unknown }) => String(j.detail ?? r.statusText), () => r.statusText);
    throw new Error(detail);
  }
  return (await r.json()) as T;
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const serviceStatus = (base: string, signal?: AbortSignal) => call<ServiceStatus>(base, '/services', signal ? { signal } : undefined);
export const startTts = (base: string, name: TtsService) => call<{ running: boolean; ready: boolean; starting?: boolean; already?: boolean; stopped: string[] }>(base, `/services/${name}/start`, post());
export const startLms = (base: string) => call<{ running: boolean }>(base, '/services/lmstudio/start', post());
export const loadLmsModel = (base: string, model: string) => call<{ model: string; already: boolean; unloaded?: string[] }>(base, '/services/lmstudio/load', post({ model }));
export const stopTts = (base: string, name: TtsService) => call<{ stopped: number }>(base, `/services/${name}/stop`, post());
export const unloadLms = (base: string) => call<{ unloaded: boolean; reason?: string }>(base, '/services/lmstudio/unload', post());

/** 端點是不是本機 LM Studio（是的話「連線」要先開 server、載入模型） */
export const isLocalLms = (llmBase: string) => /\/\/(localhost|127\.0\.0\.1):1234(\/|$)/.test(llmBase.trim());

/** 等 TTS 引擎就緒；onTick 給畫面顯示等了幾秒 */
export async function waitTtsReady(base: string, name: TtsService, opts: { timeoutMs: number; onTick?: (sec: number) => void; signal?: AbortSignal }): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new Error('已取消');
    const s = await serviceStatus(base, opts.signal);
    if (s[name].ready) return;
    const sec = Math.round((Date.now() - t0) / 1000);
    if (Date.now() - t0 > opts.timeoutMs) throw new Error(`${name} ${Math.round(opts.timeoutMs / 1000)} 秒內沒有就緒；看 log：${s[name].log}`);
    opts.onTick?.(sec);
    // 等下一輪：按了取消就馬上結束，不等這 2 秒
    await new Promise<void>((ok, bad) => {
      const t = setTimeout(ok, 2000);
      opts.signal?.addEventListener('abort', () => (clearTimeout(t), bad(new Error('已取消'))), { once: true });
    });
  }
}

/** 各引擎從啟動到就緒的上限（Irodori 預先載入模型 2～3 分鐘、ComfyUI 載入節點約 1 分鐘、ZONOS 約 30 秒） */
/** 各引擎從啟動到就緒的上限（Irodori 預先載入模型 2～3 分鐘、Qwen 依序讀模型檔＋讀進顯存約 1 分鐘、ZONOS 約 30 秒） */
export const READY_TIMEOUT: Record<TtsService, number> = { irodori: 300_000, qwen: 180_000, zonos: 90_000 };
export const SERVICE_LABEL: Record<TtsService, string> = { irodori: 'Irodori', zonos: 'ZONOS', qwen: 'Qwen 聲音設計' };
