import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmHttpError, LlmIdleError, isReconnectable, streamChat, testConnection, streamChatRetry, thinkingOff, chatModels, GEMINI_BASE, OPENAI_BASE, toOpenAiStrict } from './llm.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    if (url === '/ok/v1/models') return send(200, JSON.stringify({ data: [{ id: 'gemma-4-e4b' }, { id: 'lfm2.5' }] }));
    if (url === '/key/v1/models') return send(401, '{"error":"bad key"}');
    if (url === '/rate/v1/models') return send(429, '{"error":"slow down"}');
    if (url === '/boom/v1/models') return send(500, 'internal');
    if (url === '/notjson/v1/models') return send(200, '<html>');
    if (url === '/hang/v1/models') return; // 永不回應
    if (url === '/ok/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = ['{"events":[', '{"type":"se","id":"rain","side":"left"}', '],"state":{}}'];
      for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    send(404, 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const ep = (path: string) => ({ baseUrl: `${base}${path}`, apiKey: '' });

describe('testConnection：六種結果', () => {
  it('ok：回模型清單', async () => {
    expect(await testConnection(ep('/ok/v1'))).toEqual({ kind: 'ok', models: ['gemma-4-e4b', 'lfm2.5'] });
  });
  it('invalid_key', async () => {
    expect((await testConnection(ep('/key/v1'))).kind).toBe('invalid_key');
  });
  it('rate_limited', async () => {
    expect((await testConnection(ep('/rate/v1'))).kind).toBe('rate_limited');
  });
  it('http_error：500', async () => {
    const r = await testConnection(ep('/boom/v1'));
    expect(r).toMatchObject({ kind: 'http_error', status: 500 });
  });
  it('http_error：404 且網址沒有 /v1 時提示補上', async () => {
    const r = await testConnection(ep('/ok'));
    expect(r).toMatchObject({ kind: 'http_error', status: 404 });
    expect('hint' in r && r.hint).toContain('/v1');
  });
  it('http_error：200 但不是 JSON', async () => {
    expect((await testConnection(ep('/notjson/v1'))).kind).toBe('http_error');
  });
  it('timeout', async () => {
    expect((await testConnection(ep('/hang/v1'), { timeoutMs: 300 })).kind).toBe('timeout');
  });
  it('network：連不上的埠', async () => {
    expect((await testConnection({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' })).kind).toBe('network');
  });
});

describe('streamChat', () => {
  it('把 SSE 的 delta 依序吐出並回傳完整文字', async () => {
    const deltas: string[] = [];
    const full = await streamChat(ep('/ok/v1'), { model: 'm', messages: [], schema: {}, temperature: 0.8, maxTokens: 100, onDelta: (d) => deltas.push(d) });
    expect(deltas).toHaveLength(3);
    expect(JSON.parse(full)).toEqual({ events: [{ type: 'se', id: 'rain', side: 'left' }], state: {} });
  });
});

describe('streamChat 閒置逾時', () => {
  // 假端點：回 200 但永遠不送資料；abort 時讓 body 出錯（跟真的 fetch 一樣）
  const silent = (async (_u: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const req = { model: 'm', messages: [], schema: {}, temperature: 0.8, maxTokens: 100, onDelta: () => {} };
  it('太久沒收到資料就丟 LlmIdleError', async () => {
    await expect(streamChat(ep('/x/v1'), { ...req, idleMs: 80 }, silent)).rejects.toThrow(LlmIdleError);
  });
  it('使用者按停止不算閒置逾時', async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 30);
    const p = streamChat(ep('/x/v1'), { ...req, idleMs: 5000, signal: c.signal }, silent);
    await expect(p).rejects.not.toThrow(LlmIdleError);
  });
});

describe('isReconnectable（斷線重連只認連線類錯誤）', () => {
  it('LM Studio 引擎中斷、模型被卸載、連不上、5xx、閒置逾時＝重連；4xx 與其他錯誤＝不重連', () => {
    expect(isReconnectable(new LlmHttpError(200, 'LLM 串流錯誤：terminated'))).toBe(true);
    expect(isReconnectable(new LlmHttpError(200, 'LLM 串流錯誤：Engine protocol predict request failed: fetch failed'))).toBe(true);
    expect(isReconnectable(new LlmHttpError(200, 'LLM 串流錯誤：Model unloaded by user or API request.'))).toBe(true);
    expect(isReconnectable(new LlmHttpError(200, 'LLM 串流錯誤：Model is unloaded.'))).toBe(true); // 卸載途中重送收到的
    expect(isReconnectable(new LlmHttpError(503, 'LLM 回應 503'))).toBe(true);
    expect(isReconnectable(new TypeError('fetch failed'))).toBe(true);
    expect(isReconnectable(new LlmIdleError('120 秒沒有資料'))).toBe(true);
    expect(isReconnectable(new LlmHttpError(400, 'LLM 回應 400：bad schema'))).toBe(false);
    expect(isReconnectable(new LlmHttpError(401, 'LLM 回應 401'))).toBe(false);
    expect(isReconnectable(new Error('輸出的 actions 不是 3 個'))).toBe(false);
    expect(isReconnectable(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('streamChatRetry', () => {
  const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}

data: [DONE]

`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const terminated = () => new Response(`data: ${JSON.stringify({ error: { message: 'terminated' } })}

`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  it('串流中斷（terminated）就等端點恢復再重送；格式錯這類不算連線問題的不重送', async () => {
    const calls: string[] = [];
    let n = 0;
    const f = (async (url: string) => {
      calls.push(String(url).endsWith('/models') ? 'models' : 'chat');
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      return n++ === 0 ? terminated() : sse('ok');
    }) as unknown as typeof fetch;
    const out = await streamChatRetry({ baseUrl: 'http://x/v1', apiKey: '' }, { model: 'm', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {}, schema: {}, temperature: 0.5, maxTokens: 16 }, f, { delayMs: 0 });
    expect(out).toBe('ok');
    expect(calls).toEqual(['chat', 'models', 'chat']);
    const bad = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
    await expect(streamChatRetry({ baseUrl: 'http://x/v1', apiKey: '' }, { model: 'm', messages: [], onDelta: () => {}, schema: {}, temperature: 0.5, maxTokens: 16 }, bad, { delayMs: 0 })).rejects.toThrow();
  });
});

describe('Gemini', () => {
  it('關掉思考：Gemini 2.5 送 none、3／4 送 minimal（關不掉）；LM Studio 送 none', () => {
    expect(thinkingOff(GEMINI_BASE, 'gemini-2.5-flash-lite')).toBe('none');
    expect(thinkingOff(GEMINI_BASE, 'gemini-3.8-flash')).toBe('minimal');
    expect(thinkingOff(GEMINI_BASE, 'gemini-4-neon')).toBe('minimal');
    expect(thinkingOff('http://localhost:1234/v1', 'gemma-4-e2b')).toBe('none');
  });
  it('模型選單只列聊天模型', () => {
    const all = ['gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-embedding-2', 'gemini-3.1-flash-image', 'lyria-3.5', 'gemini-3.8-live', 'gemini-4-neon', 'veo-3', 'gemini-2.5-flash-lite'];
    expect(chatModels(GEMINI_BASE, all)).toEqual(['gemini-3.8-flash', 'gemini-4-neon', 'gemini-2.5-flash-lite']);
    expect(chatModels('http://localhost:1234/v1', ['gemma', 'text-embedding-nomic'])).toEqual(['gemma']);
  });
});

describe('OpenAI', () => {
  it('關掉思考：astra／sol 送 low，其他送 none', () => {
    expect(thinkingOff(OPENAI_BASE, 'gpt-6.2-astra')).toBe('low');
    expect(thinkingOff(OPENAI_BASE, 'gpt-6.2-sol')).toBe('low');
    expect(thinkingOff(OPENAI_BASE, 'gpt-6-luna')).toBe('none');
  });
  it('模型選單只列聊天模型', () => {
    const all = ['gpt-6.2-sol', 'gpt-image-2.6-flare', 'gpt-realtime-2.1', 'gpt-transcribe', 'text-embedding-3-small', 'tts-1', 'whisper-1', 'omni-moderation-latest', 'gpt-6-luna'];
    expect(chatModels(OPENAI_BASE, all)).toEqual(['gpt-6.2-sol', 'gpt-6-luna']);
  });
  it('strict 子集：拿掉 minLength 等、properties 裡同名欄位不誤刪；物件缺 additionalProperties 或 required 不全就丟錯', () => {
    const s = { type: 'object', properties: { default: { type: 'string', minLength: 1, maxLength: 9 }, n: { type: 'integer', minimum: 1 } }, required: ['default', 'n'], additionalProperties: false };
    expect(toOpenAiStrict(s)).toEqual({ type: 'object', properties: { default: { type: 'string' }, n: { type: 'integer', minimum: 1 } }, required: ['default', 'n'], additionalProperties: false });
    expect(() => toOpenAiStrict({ type: 'object', properties: { a: { type: 'string' } }, required: [] , additionalProperties: false })).toThrow(/a 不在 required/);
    expect(() => toOpenAiStrict({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toThrow(/additionalProperties/);
  });
  it('送出 max_completion_tokens、不送 max_tokens；schema 換成 strict 子集', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }) as unknown as typeof fetch;
    const schema = { type: 'object', properties: { a: { type: 'string', maxLength: 5 } }, required: ['a'], additionalProperties: false };
    await streamChat({ baseUrl: OPENAI_BASE, apiKey: 'k', noThinking: true }, { model: 'gpt-6-luna', messages: [], schema, temperature: 1, maxTokens: 800, onDelta: () => {} }, fetchFn);
    expect(body.max_completion_tokens).toBe(800);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('none');
    expect(JSON.stringify(body.response_format)).not.toContain('maxLength');
  });
});
