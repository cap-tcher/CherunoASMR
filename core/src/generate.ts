// 一段的生成：組 prompt → 串流 LLM（json_schema 約束）→ 增量解析 → line／se 逐個分派 → state 進時間軸。
import { isReconnectable, streamChat, waitReady, type LlmEndpoint } from './llm.ts';
import { advanceClock, buildMessages, type ChatMessage, type PromptInput, type SegmentTemplates } from './prompt.ts';
import { fill } from './templates.ts';
import { SegmentStreamParser, parseLine, segmentSchema, type SegmentEvent } from './segment.ts';
import { CARRY, compileSegmentStateSchema, type ClampEvent, type Snapshot, type StateTimeline } from './state.ts';

// 跟著台詞開始的音效（LLM 寫進 se[]）；雨聲這類循環背景音由聽者自己開關，不進時間軸、不給 LLM 用（使用者 2026-11-20）
export const SE_IDS = ['breath_blow', 'ear_tap', 'blanket', 'cup_on_table', 'page_turn'] as const;

export interface GenerateOptions {
  endpoint: LlmEndpoint;
  model: string;
  temperature: number;
  maxTokens: number;
  prompt: Omit<PromptInput, 'state' | 'statePrev' | 'seIds'>;
  templates: SegmentTemplates; // 系統核心 › 提示詞
  onActions?: (actions: string[]) => void;
  timeline: StateTimeline;
  segmentId: string;
  regenerate?: boolean; // true：重生這段（prompt 用前一段的狀態，結果取代這段的快照）
  signal?: AbortSignal;
  onEvent: (e: SegmentEvent, index: number) => void;
  /** 送出前：這段實際送給 LLM 的 messages 與輸出 schema（系統核心 › AI 流程顯示用）；pass＝lines（台詞）或 state（狀態另外問一次的第二次） */
  onRequest?: (req: { messages: ChatMessage[]; schema: object; pass: 'lines' | 'state' }) => void;
  /**
   * 斷線重連：連線類錯誤（見 llm.ts isReconnectable）時等端點恢復再重送，最多 attempts 次。
   * 台詞請求重來前呼叫 onReset（app 清掉這段已出現的台詞）；狀態請求只重問狀態。
   */
  // delayMs：端點回 200 後再等一下才重送（LM Studio 卸載／重新載入模型時 /models 早就回 200，太快重送會收到「Model is unloaded」；預設 3000）
  reconnect?: { attempts: number; onRetry?: (attempt: number, pass: 'lines' | 'state', error: string) => void; waitTimeoutMs?: number; waitIntervalMs?: number; delayMs?: number };
  onReset?: () => void;
  /** 狀態另外問一次時，第二次請求一回來就通知（app 顯示面板更新時間） */
  onStateRaw?: (raw: string) => void;
  fetchFn?: typeof fetch;
}

export interface GenerateResult {
  userContent: string;
  secret: string | null; // 角色原本沒有秘密時，這段寫出來的秘密
  time: string | null; // 故事時鐘：這段結束時的時刻（已檢查只往前）
  timeNote: string | null;
  events: SegmentEvent[];
  snapshots: Record<string, Snapshot>;
  clamps: ClampEvent[];
  actions: string[];
  memory: string[]; // 新記憶候選（使用者確認才存）
  raw: string;
  /** 狀態另外問一次時第二次請求的原始輸出；沒分開是 null */
  stateRaw: string | null;
  firstEventMs: number | null;
  /** 狀態就緒的時間（從送出算起） */
  stateMs: number | null;
}

export async function generateSegment(o: GenerateOptions): Promise<GenerateResult> {
  const t0 = Date.now();
  let firstEventMs: number | null = null;
  const events: SegmentEvent[] = [];
  let rawState: unknown;
  let gotState = false;
  let actions: string[] = [];
  let memory: string[] = [];
  const makeParser = () => new SegmentStreamParser({
    onLine: (raw) => {
      const evs = parseLine(raw, SE_IDS);
      firstEventMs ??= Date.now() - t0;
      for (const e of evs) {
        o.onEvent(e, events.length);
        events.push(e);
      }
    },
    onState: (raw) => {
      rawState = raw;
      gotState = true;
    },
    onActions: (raw) => {
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw new Error(`actions 不是文字陣列：${JSON.stringify(raw)}`);
      actions = raw;
      o.onActions?.(raw);
    },
    onMemory: (raw) => {
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw new Error(`memory 不是文字陣列：${JSON.stringify(raw)}`);
      memory = raw;
    },
  });
  let parser = makeParser();
  // 斷線重連：要不要重試、重試前等端點恢復
  const retry = async (e: unknown, attempt: number, pass: 'lines' | 'state'): Promise<void> => {
    const rc = o.reconnect;
    if (o.signal?.aborted || !rc || attempt >= rc.attempts || !isReconnectable(e)) throw e;
    rc.onRetry?.(attempt + 1, pass, e instanceof Error ? e.message : String(e));
    await new Promise((ok) => setTimeout(ok, rc.delayMs ?? 3000));
    await waitReady(o.endpoint, { ...(rc.waitTimeoutMs ? { timeoutMs: rc.waitTimeoutMs } : {}), ...(rc.waitIntervalMs !== undefined ? { intervalMs: rc.waitIntervalMs } : {}), ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  };
  const { now: stateBefore, prev: statePrev } = o.timeline.pair(o.regenerate ? o.segmentId : undefined);
  const messages = buildMessages({ ...o.prompt, state: stateBefore, statePrev, seIds: SE_IDS }, o.templates);
  const im = o.prompt.intimacy;
  const withSecret = im && !o.prompt.character.secret.trim();
  const sep = im && !!o.prompt.stateSeparately;
  const stateSchema = im ? compileSegmentStateSchema(o.prompt.secretFormat, [o.prompt.character.id]) : null;
  const schema = segmentSchema({ stateSchema: sep ? null : stateSchema, seIds: SE_IDS, withEn: o.prompt.withEn, withSecret: withSecret && !sep, withTime: !!o.prompt.clock, lineRange: o.prompt.lineRange });
  o.onRequest?.({ messages, schema, pass: 'lines' });
  let raw = '';
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await streamChat(
        o.endpoint,
        { model: o.model, messages, schema, temperature: o.temperature, maxTokens: o.maxTokens, ...(o.signal ? { signal: o.signal } : {}), onDelta: (d) => parser.feed(d) },
        o.fetchFn,
      );
      parser.end();
      break;
    } catch (e) {
      await retry(e, attempt, 'lines');
      // 整段重來：丟掉這次已收到的台詞與欄位，app 也清掉畫面上的
      events.length = 0;
      firstEventMs = null;
      rawState = undefined;
      gotState = false;
      actions = [];
      memory = [];
      parser = makeParser();
      o.onReset?.();
    }
  }
  // 狀態另外問一次：同樣的上下文＋剛才的輸出＋「只更新狀態」，schema 只有 state（＋角色沒秘密時的 secret）
  let stateRaw: string | null = null;
  let stateMs: number | null = sep ? null : Date.now() - t0;
  if (sep) {
    const ask = fill(o.templates.stateAsk, { charName: o.prompt.character.name, charId: o.prompt.character.id, secretPart: withSecret ? fill(o.templates.stateAskSecret, { charName: o.prompt.character.name }) : '' });
    const messages2: ChatMessage[] = [...messages, { role: 'assistant', content: raw }, { role: 'user', content: ask }];
    const schema2 = {
      type: 'object',
      properties: { state: stateSchema!, ...(withSecret ? { secret: { type: 'string', minLength: 1, maxLength: 400 } } : {}) },
      required: ['state', ...(withSecret ? ['secret'] : [])],
      additionalProperties: false,
    };
    o.onRequest?.({ messages: messages2, schema: schema2, pass: 'state' });
    for (let attempt = 0; ; attempt++) {
      try {
        stateRaw = await streamChat(o.endpoint, { model: o.model, messages: messages2, schema: schema2, temperature: o.temperature, maxTokens: o.maxTokens, ...(o.signal ? { signal: o.signal } : {}), onDelta: () => {} }, o.fetchFn);
        break;
      } catch (e) {
        await retry(e, attempt, 'state'); // 台詞已經在播：只重問狀態
      }
    }
    o.onStateRaw?.(stateRaw);
    const obj = JSON.parse(stateRaw) as { state?: unknown };
    if (!('state' in obj)) throw new Error('第二次請求（只問狀態）的輸出沒有 state');
    rawState = obj.state;
    gotState = true;
    stateMs = Date.now() - t0;
  }
  if (im && !gotState) throw new Error('輸出沒有 state');
  if (!im) rawState = { [o.prompt.character.id]: CARRY }; // 一般模式：狀態沿用前一段
  if (actions.length !== 3) throw new Error(`輸出的 actions 不是 3 個：${JSON.stringify(actions)}`);
  const { snapshots, clamps } = o.regenerate ? o.timeline.regenerate(o.segmentId, rawState) : o.timeline.append(o.segmentId, rawState);
  // 這段實際送出的 user 內容：app 存起來，之後當上下文裡聽者那一則
  const userContent = messages[messages.length - 1]!.content as string;
  let secret: string | null = null;
  if (withSecret) {
    const s = (JSON.parse(stateRaw ?? raw) as { secret?: unknown }).secret;
    if (typeof s !== 'string' || !s.trim()) throw new Error('角色還沒有秘密，但這段的輸出沒有 secret');
    secret = s.trim();
  }
  let time: string | null = null;
  let timeNote: string | null = null;
  if (o.prompt.clock) {
    const r = advanceClock(o.prompt.clock, (JSON.parse(raw) as { time?: unknown }).time);
    time = r.time;
    timeNote = r.note;
  }
  return { events, snapshots, clamps, actions, memory, raw, stateRaw, firstEventMs, stateMs, userContent, secret, time, timeNote };
}
