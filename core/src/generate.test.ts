import { describe, expect, it } from 'vitest';
import { generateSegment, type GenerateOptions } from './generate.ts';
import type { CharacterCard } from './prompt.ts';
import { StateTimeline, type SecretFormat } from './state.ts';
import { DEFAULT_TEMPLATES } from './templates.ts';

const format: SecretFormat = { fields: [{ key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 }] };
const card: CharacterCard = { id: 'mio', name: '澪', reading: 'みお', subName: '澪', ageSex: '', relation: '', appearance: '', bio: '', personality: '', behavior: '', catchphrase: '', secret: '其實會怕黑', voiceDesc: '' };

/** 假 LLM：每次都想把好感度設成 100；記下 prompt 裡帶的目前狀態。 */
function fakeLlm(seenStates: string[]): typeof fetch {
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    seenStates.push(/## 目前的秘密狀態\n(.*)/.exec(body.messages[0]!.content)![1]!);
    const out = {
      lines: [1, 2, 3].map((i) => ({ ja: `台詞${i}`, zh: `譯文${i}`, voice: 'normal', pos: { side: 'center', distance_cm: 30 }, se: [] })),
      state: { mio: { affection: 100 } },
      actions: ['a', 'b', 'c'],
      memory: ['期末報告週五要交'],
    };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(out) } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
  }) as unknown as typeof fetch;
}

const opts = (timeline: StateTimeline, segmentId: string, fetchFn: typeof fetch, regenerate = false): GenerateOptions => ({
  endpoint: { baseUrl: 'http://x/v1', apiKey: '' },
  model: 'm',
  temperature: 0.8,
  maxTokens: 500,
  prompt: {
    systemPrompt: '',
    opening: '',
    sleepInstruction: '',
    statDefs: '',
    character: card,
    protagonist: { name: '', reading: '', callName: '', subName: '', gender: '', appearance: '', bio: '' },
    scene: null,
    glossary: null,
    world: null,
    memories: null,
    history: null,
    tone: '',
    secretFormat: format,
    mode: 'infinite',
    userInput: '',
    intimacy: true,
    intimacySystem: "",
    intimacyScript: "",
    secretTemplate: "",
    clock: null,
    context: [],
    contextLimit: 70,
    isFirstSegment: false,
    withEn: false, lineRange: { min: 3, max: 8 },
  },
  templates: DEFAULT_TEMPLATES.segment,
  timeline,
  segmentId,
  regenerate,
  onEvent: () => {},
  fetchFn,
});

describe('generateSegment', () => {
  it('依序產生 line 事件與 3 個 actions', async () => {
    const r = await generateSegment(opts(new StateTimeline(format, ['mio']), 's1', fakeLlm([])));
    expect(r.events.filter((e) => e.type === 'line')).toHaveLength(3);
    expect(r.actions).toEqual(['a', 'b', 'c']);
    expect(r.memory).toEqual(['期末報告週五要交']);
  });

  it('重生：prompt 用前一段的狀態，結果取代這段，不疊加', async () => {
    const t = new StateTimeline(format, ['mio']);
    const seen: string[] = [];
    const f = fakeLlm(seen);
    await generateSegment(opts(t, 's1', f)); // 10 → 15
    await generateSegment(opts(t, 's2', f)); // 15 → 20
    for (let i = 0; i < 5; i++) {
      const r = await generateSegment(opts(t, 's2', f, true));
      expect(r.snapshots.mio!.affection).toBe(20);
    }
    expect(seen.slice(2).every((s) => s === '{"mio":{"affection":15}}')).toBe(true);
    expect(t.length).toBe(2);
  });
});

describe('一般模式（不輸出 state）', () => {
  it('schema 沒有 state，狀態沿用前一段；之後前面段落重生時跟著重算', async () => {
    const t = new StateTimeline(format, ['mio']);
    await generateSegment(opts(t, 's1', fakeLlm([]))); // 親密模式：10 → 15
    let schema: { properties: Record<string, unknown>; required: string[] } | null = null;
    const noState = (async (_u: string, init: RequestInit) => {
      schema = JSON.parse(String(init.body)).response_format.json_schema.schema;
      const out = { lines: [1, 2, 3].map((i) => ({ ja: `台詞${i}`, zh: `譯文${i}`, voice: 'normal', pos: { side: 'center', distance_cm: 30 }, se: [] })), actions: ['a', 'b', 'c'], memory: [] };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(out) } }] })}

data: [DONE]

`, { status: 200 });
    }) as unknown as typeof fetch;
    const o2 = opts(t, 's2', noState);
    const r = await generateSegment({ ...o2, prompt: { ...o2.prompt, intimacy: false } });
    expect(schema!.required).not.toContain('state');
    expect('state' in schema!.properties).toBe(false);
    expect(r.snapshots.mio).toEqual({ affection: 15 });
    t.editCurrent('mio', { affection: 50 });
    expect(t.current().mio).toEqual({ affection: 50 });
  });
});

describe('秘密自動生成（ADV3.0 F-64）', () => {
  it('角色沒有秘密：schema 要求 secret，回傳寫好的秘密；沒給就丟錯', async () => {
    const mk = (withSecret: boolean, seen: { schema?: { required: string[] } }) =>
      (async (_u: string, init: RequestInit) => {
        seen.schema = JSON.parse(String(init.body)).response_format.json_schema.schema;
        const out = { lines: [1, 2, 3].map((i) => ({ ja: `台詞${i}`, zh: `譯文${i}`, voice: 'normal', pos: { side: 'center', distance_cm: 30 }, se: [] })), state: { mio: { affection: 12 } }, actions: ['a', 'b', 'c'], memory: [], ...(withSecret ? { secret: '其實一直在等你敲門' } : {}) };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(out) } }] })}

data: [DONE]

`, { status: 200 });
      }) as unknown as typeof fetch;
    const seen: { schema?: { required: string[] } } = {};
    const o = opts(new StateTimeline(format, ['mio']), 's1', mk(true, seen));
    const r = await generateSegment({ ...o, prompt: { ...o.prompt, character: { ...card, secret: '' } } });
    expect(seen.schema!.required).toContain('secret');
    expect(r.secret).toBe('其實一直在等你敲門');
    const o2 = opts(new StateTimeline(format, ['mio']), 's1', mk(false, {}));
    await expect(generateSegment({ ...o2, prompt: { ...o2.prompt, character: { ...card, secret: '' } } })).rejects.toThrow('沒有 secret');
  });
});

describe('狀態另外問一次（stateSeparately）', () => {
  /** 假 LLM：記下每次請求的 schema 與最後一則 messages；第一次回台詞（不含 state），第二次回 state */
  function twoPass(seen: { schema: { properties: Record<string, unknown>; required: string[] }; last: { role: string; content: string }; roles: string[] }[]): typeof fetch {
    return (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[]; response_format: { json_schema: { schema: { properties: Record<string, unknown>; required: string[] } } } };
      const schema = body.response_format.json_schema.schema;
      seen.push({ schema, last: body.messages[body.messages.length - 1]!, roles: body.messages.map((m) => m.role) });
      const out = 'lines' in schema.properties
        ? { lines: [1, 2, 3].map((i) => ({ ja: `台詞${i}`, zh: `譯文${i}`, voice: 'normal', pos: { side: 'center', distance_cm: 30 }, se: [] })), actions: ['a', 'b', 'c'], memory: [] }
        : { state: { mio: { affection: 13 } } };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(out) } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as unknown as typeof fetch;
  }
  it('第一次只問台詞、第二次只問狀態；狀態照第二次的套用、限幅照常', async () => {
    const seen: Parameters<typeof twoPass>[0] = [];
    const t = new StateTimeline(format, ['mio']);
    const o = opts(t, 's1', twoPass(seen));
    const r = await generateSegment({ ...o, prompt: { ...o.prompt, stateSeparately: true } });
    expect(seen).toHaveLength(2);
    expect(Object.keys(seen[0]!.schema.properties)).not.toContain('state');
    expect(seen[0]!.last.content).not.toContain('- state：');
    expect(Object.keys(seen[1]!.schema.properties)).toEqual(['state']);
    expect(seen[1]!.roles.slice(-2)).toEqual(['assistant', 'user']); // 帶著剛才的台詞再問
    expect(seen[1]!.last.content).toContain('只根據上面這段');
    expect(r.events.filter((e) => e.type === 'line')).toHaveLength(3);
    expect(r.snapshots.mio!.affection).toBe(13);
    expect(r.stateRaw).toContain('13');
    expect(r.stateMs).not.toBeNull();
  });
  it('角色沒秘密：secret 移到第二次請求', async () => {
    const seen: Parameters<typeof twoPass>[0] = [];
    const t = new StateTimeline(format, ['mio']);
    const o = opts(t, 's1', twoPass(seen));
    await expect(generateSegment({ ...o, prompt: { ...o.prompt, character: { ...card, secret: '' }, stateSeparately: true } })).rejects.toThrow(/沒有 secret/);
    expect(Object.keys(seen[0]!.schema.properties)).not.toContain('secret');
    expect(seen[1]!.schema.required).toEqual(['state', 'secret']);
  });
  it('沒開：一次請求、state 在同一個 schema', async () => {
    const seen: Parameters<typeof twoPass>[0] = [];
    const t = new StateTimeline(format, ['mio']);
    await generateSegment(opts(t, 's1', twoPass(seen))).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!.schema.properties)).toContain('state');
  });
});

describe('斷線重連', () => {
  const lineOut = (tag: string) => ({ lines: [1, 2, 3].map((i) => ({ ja: `${tag}${i}`, zh: `譯${i}`, voice: 'normal', pos: { side: 'center', distance_cm: 30 }, se: [] })), actions: ['a', 'b', 'c'], memory: [] });
  const sse = (obj: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(obj) } }] })}\n\ndata: [DONE]\n\n`;
  /** 假 LM Studio：/models 永遠 200；chat 照 plan 依序回（'broken'＝先送一句台詞再丟引擎錯誤） */
  function flaky(plan: ('broken' | 'ok' | 'badRequest')[], log: string[]): typeof fetch {
    let n = 0;
    return (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) {
        log.push('models');
        return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      }
      const body = JSON.parse(String(init!.body)) as { response_format: { json_schema: { schema: { properties: Record<string, unknown> } } } };
      const pass = 'lines' in body.response_format.json_schema.schema.properties ? 'lines' : 'state';
      const step = plan[n++] ?? 'ok';
      log.push(`${pass}:${step}`);
      if (step === 'badRequest') return new Response('bad', { status: 400 });
      if (step === 'broken') {
        const head = JSON.stringify(lineOut('壞')).slice(0, 120); // 送出第一句台詞左右就斷
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: head } }] })}\n\ndata: ${JSON.stringify({ error: { message: 'terminated' } })}\n\n`, { status: 200 });
      }
      const withState = 'state' in body.response_format.json_schema.schema.properties;
      return new Response(sse(pass === 'lines' ? { ...lineOut('好'), ...(withState ? { state: { mio: { affection: 12 } } } : {}) } : { state: { mio: { affection: 13 } } }), { status: 200 });
    }) as unknown as typeof fetch;
  }
  const reconnect = (retries: number[]) => ({ attempts: 2, waitIntervalMs: 0, delayMs: 0, onRetry: (n: number) => retries.push(n) });

  it('台詞請求中斷：等端點恢復、通知清掉已出現的台詞、整段重來', async () => {
    const log: string[] = [];
    const retries: number[] = [];
    let resets = 0;
    const shown: string[] = [];
    const t = new StateTimeline(format, ['mio']);
    const o = opts(t, 's1', flaky(['broken', 'ok'], log));
    const r = await generateSegment({ ...o, reconnect: reconnect(retries), onReset: () => { resets++; shown.length = 0; }, onEvent: (e) => { if (e.type === 'line') shown.push(e.ja); } });
    expect(log).toEqual(['lines:broken', 'models', 'lines:ok']);
    expect(retries).toEqual([1]);
    expect(resets).toBe(1);
    expect(shown).toEqual(['好1', '好2', '好3']); // 壞掉那次出現過的台詞被清掉
    expect(r.events.filter((e) => e.type === 'line').map((e) => (e as { ja: string }).ja)).toEqual(['好1', '好2', '好3']);
  });
  it('狀態請求中斷：只重問狀態，台詞請求只送一次、不清台詞', async () => {
    const log: string[] = [];
    let resets = 0;
    const t = new StateTimeline(format, ['mio']);
    const o = opts(t, 's1', flaky(['ok', 'broken', 'ok'], log));
    const r = await generateSegment({ ...o, prompt: { ...o.prompt, stateSeparately: true }, reconnect: reconnect([]), onReset: () => resets++ });
    expect(log).toEqual(['lines:ok', 'state:broken', 'models', 'state:ok']);
    expect(resets).toBe(0);
    expect(r.snapshots.mio!.affection).toBe(13);
  });
  it('超過次數照樣丟錯；HTTP 400 不重試', async () => {
    const t = new StateTimeline(format, ['mio']);
    const log1: string[] = [];
    await expect(generateSegment({ ...opts(t, 's1', flaky(['broken', 'broken', 'broken'], log1)), reconnect: reconnect([]) })).rejects.toThrow(/terminated/);
    expect(log1.filter((x) => x.startsWith('lines'))).toHaveLength(3); // 原本 1 次＋重連 2 次
    const log2: string[] = [];
    await expect(generateSegment({ ...opts(t, 's1', flaky(['badRequest'], log2)), reconnect: reconnect([]) })).rejects.toThrow(/400/);
    expect(log2).toEqual(['lines:badRequest']);
  });
  it('沒開重連：中斷直接丟錯', async () => {
    const log: string[] = [];
    const t = new StateTimeline(format, ['mio']);
    await expect(generateSegment(opts(t, 's1', flaky(['broken', 'ok'], log)))).rejects.toThrow(/terminated/);
    expect(log).toEqual(['lines:broken']);
  });
});
