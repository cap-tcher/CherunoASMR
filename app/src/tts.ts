import { traced } from './requestLog.ts';
export interface AudioHealth {
  ok: boolean;
  engines: Record<string, { reachable: boolean; url: string; status?: number; error?: string }>;
}

const trim = (b: string) => b.replace(/\/+$/, '');

export async function audioHealth(base: string): Promise<AudioHealth> {
  const r = await fetch(`${trim(base)}/health`);
  if (!r.ok) throw new Error(`音訊服務回 ${r.status}`);
  return (await r.json()) as AudioHealth;
}

export interface SynthRequest {
  engine: string;
  text: string;
  voice: 'normal' | 'whisper' | 'breath';
  speaker: string;
  caption?: string;
  seed?: number;
  num_steps?: number; // Irodori 取樣步數
  style?: string; // Qwen：接在聲音描述後的語氣後綴
  unload_after?: boolean; // Qwen：這句產完就卸載模型（騰 VRAM 給播放引擎）
}

export interface SynthResult {
  url: string; // blob URL
  blob: Blob;
  synthMs: number;
  seconds: number;
}

async function errorDetail(r: Response, what: string): Promise<string> {
  const text = await r.text();
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    if (typeof j.detail === 'string') return j.detail;
  } catch {
    // 不是 JSON：直接顯示原文
  }
  return `${what} 回 ${r.status}：${text.slice(0, 200)}`;
}

/** 呼叫 audio 服務 /tts，回傳可播放的 blob URL。失敗時丟出服務給的錯誤訊息。 */
export async function synthesize(base: string, req: SynthRequest, signal?: AbortSignal): Promise<SynthResult> {
  const r = await traced('語音合成')(`${trim(base)}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new Error(await errorDetail(r, 'TTS'));
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const seconds = await new Promise<number>((resolve, reject) => {
    const a = new Audio(url);
    a.onloadedmetadata = () => resolve(a.duration);
    a.onerror = () => reject(new Error('瀏覽器無法解碼 TTS 回傳的音檔'));
  });
  return { url, blob, synthMs: Number(r.headers.get('X-Synth-Ms')), seconds };
}

/** 把鎖定的候選音登錄成引擎端參考音，回傳 voice id。 */
export async function registerVoice(base: string, engine: string, voiceId: string, wav: Blob): Promise<string> {
  const buf = new Uint8Array(await wav.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const r = await traced('聲音登錄')(`${trim(base)}/voice/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, voice_id: voiceId, wav_base64: btoa(bin) }),
  });
  if (!r.ok) throw new Error(await errorDetail(r, '登錄參考音'));
  return ((await r.json()) as { voice_id: string }).voice_id;
}
