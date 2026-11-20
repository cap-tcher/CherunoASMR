// 一次生成的輸出格式與串流增量解析器。
// LLM 一段輸出一個 JSON 物件：{"lines":[台詞...], "state":{<角色 id>: 快照}, "actions":[3 個行動建議]}；每句台詞可帶 se[]（念這句之前的音效）。
// lines 放最前面：配 json_schema 約束時，llama.cpp 依 properties 順序產生，所以台詞先串流出來。
// 結構上強制至少一句台詞、音效 id 只能用清單內的（小模型實測會只吐音效、亂編 id）。
// JSONL 無法用 json_schema 約束，所以用單一物件＋增量解析（lines 每個元素一閉合就吐出）。

import { EMOTIONS, SPAN_CLOSE, SPAN_OPEN, SPEEDS, STRENGTHS, SpanFormatError, nearVoice, whisperSpans, type Emotion, type Speed, type Strength } from './tone.ts';

export type Voice = 'normal' | 'soft' | 'whisper' | 'breath';
export type Side = 'left' | 'center' | 'right';

export interface LineEvent {
  type: 'line';
  ja: string;
  zh: string;
  en?: string; // 字幕選 EN 時才要求輸出
  voice: Voice;
  /** 語氣（ZONOS controls，見 tone.ts）；2026-11-20 前存的台本沒有＝不加 */
  emotion?: Emotion;
  strength?: Strength;
  speed?: Speed;
  pos: { side: Side; distance_cm: number };
}

export interface SeEvent {
  type: 'se';
  id: string;
  side: Side;
}

export type SegmentEvent = LineEvent | SeEvent;

export const VOICES: readonly Voice[] = ['normal', 'soft', 'whisper', 'breath'];
export const SIDES: readonly Side[] = ['left', 'center', 'right'];

export interface SegmentSchemaOptions {
  stateSchema: object | null; // state.ts 的 compileSegmentStateSchema；null＝一般模式，不輸出 state
  withSecret?: boolean; // 親密模式下角色還沒有秘密：這段要寫出 secret（ADV3.0 F-64）
  withTime?: boolean; // 故事時鐘開著：這段要回報結束時刻（ADV3.0 F-69）
  seIds: readonly string[];
  withEn: boolean; // 字幕選 EN：每句多一個英文譯文
  /** 每段台詞句數（系統核心 › 系統提示詞）；min＝max 就是固定句數 */
  lineRange: LineRange;
}

export interface LineRange {
  min: number;
  max: number;
}

/** 句數範圍 1～20、最少 ≤ 最多；不合法直接丟錯（不偷偷改成預設） */
export function checkLineRange(r: LineRange): void {
  if (!Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < 1 || r.max > 20 || r.min > r.max) throw new Error(`每段台詞句數要是 1～20 的整數、最少 ≤ 最多（現在是 ${r.min}～${r.max}）`);
}

/** 整段輸出的 JSON schema（給 response_format: json_schema）。 */
export function segmentSchema(o: SegmentSchemaOptions): object {
  const { stateSchema, seIds, withEn, withSecret, withTime, lineRange } = o;
  checkLineRange(lineRange);
  const se = {
    type: 'object',
    properties: { id: { enum: seIds }, side: { enum: SIDES } },
    required: ['id', 'side'],
    additionalProperties: false,
  };
  const line = {
    type: 'object',
    properties: {
      // 一句 ≤60 字（含 {漢字|よみ}）：約 10 秒內；小模型會把 JSON 碎片塞進長字串，上限壓短讓 grammar 先擋（2026-11-19 lfm2.5-1.2b 實測一句 22 秒）
      ja: { type: 'string', minLength: 1, maxLength: 60 },
      // 不用 pattern：LM Studio 的 json_schema 遇到 regex pattern 會產生缺欄位或 500（2026-11-18 實測）
      zh: { type: 'string', minLength: 1, maxLength: 80 },
      ...(withEn ? { en: { type: 'string', minLength: 1, maxLength: 120 } } : {}),
      voice: { enum: VOICES },
      emotion: { enum: EMOTIONS },
      strength: { enum: STRENGTHS },
      speed: { enum: SPEEDS },
      pos: {
        type: 'object',
        properties: {
          side: { enum: SIDES },
          distance_cm: { type: 'integer', minimum: 3, maximum: 200 },
        },
        required: ['side', 'distance_cm'],
        additionalProperties: false,
      },
      se: { type: 'array', items: se, maxItems: 2 },
    },
    required: withEn ? ['ja', 'zh', 'en', 'voice', 'emotion', 'strength', 'speed', 'pos', 'se'] : ['ja', 'zh', 'voice', 'emotion', 'strength', 'speed', 'pos', 'se'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      lines: { type: 'array', items: line, minItems: lineRange.min, maxItems: lineRange.max },
      ...(stateSchema ? { state: stateSchema } : {}),
      ...(withSecret ? { secret: { type: 'string', minLength: 1, maxLength: 400 } } : {}),
      ...(withTime ? { time: { type: 'string', minLength: 4, maxLength: 5, description: '這段結束時的時刻 HH:MM（24 小時制）' } } : {}),
      actions: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 24 }, minItems: 3, maxItems: 3 },
      memory: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 2 },
    },
    required: [...(stateSchema ? ['lines', 'state'] : ['lines']), 'actions', 'memory', ...(withSecret ? ['secret'] : []), ...(withTime ? ['time'] : [])],
    additionalProperties: false,
  };
}

export class SegmentFormatError extends Error {}

export interface RubyPart {
  text: string;
  reading?: string;
  /** 句中耳語《》裡的字（畫面不顯示括號，改用樣式標出） */
  whisper?: boolean;
}

const RUBY_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;

/** 「{明日|あした}ね」→ [{text:'明日', reading:'あした'}, {text:'ね'}]：字幕用 <ruby> 顯示振假名。 */
export function rubyParts(ja: string): RubyPart[] {
  const out: RubyPart[] = [];
  let whisper = false;
  // 《》把台詞切成一般／耳語幾塊，每塊再拆振假名
  for (const chunk of ja.split(new RegExp(`([${SPAN_OPEN}${SPAN_CLOSE}])`))) {
    if (chunk === SPAN_OPEN || chunk === SPAN_CLOSE) {
      whisper = chunk === SPAN_OPEN;
      continue;
    }
    let last = 0;
    const push = (p: RubyPart) => out.push(whisper ? { ...p, whisper: true } : p);
    for (const m of chunk.matchAll(RUBY_RE)) {
      if (m.index > last) push({ text: chunk.slice(last, m.index) });
      push({ text: m[1]!, reading: m[2]! });
      last = m.index + m[0].length;
    }
    if (last < chunk.length) push({ text: chunk.slice(last) });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 檢查一句台詞的形狀，展開成「音效…、台詞」的 event 序列；不合格就丟 SegmentFormatError（不猜、不補值）。 */
export function parseLine(v: unknown, seIds: readonly string[]): SegmentEvent[] {
  if (!isObj(v)) throw new SegmentFormatError(`台詞不是物件：${JSON.stringify(v)}`);
  const pos = v.pos;
  if (typeof v.ja !== 'string' || !v.ja.trim()) throw new SegmentFormatError('line.ja 缺漏');
  if (typeof v.zh !== 'string' || !v.zh.trim()) throw new SegmentFormatError('line.zh 缺漏');
  // 台詞會整句送進 TTS：去掉合法的 {漢字|よみ} 後還有 ASCII 括號、角括號、雙引號，就是模型把 JSON／標記混進台詞
  const stray = /[{}[\]<>"]/.exec(v.ja.replace(/\{[^{}|]+\|[^{}|]+\}/g, ''));
  if (stray) throw new SegmentFormatError(`台詞混進了程式碼標記「${stray[0]}」，這段沒有採用（模型太小時常見，換大一點的模型或按重試）：${v.ja.slice(0, 40)}`);
  if (!VOICES.includes(v.voice as Voice)) throw new SegmentFormatError(`line.voice 不合法：${String(v.voice)}`);
  try {
    whisperSpans(v.ja); // 句中耳語《》要成對、不巢狀
  } catch (e) {
    if (e instanceof SpanFormatError) throw new SegmentFormatError(`台詞的耳語標記不合法（${e.message}）`);
    throw e;
  }
  if (!EMOTIONS.includes(v.emotion as Emotion)) throw new SegmentFormatError(`line.emotion 不合法：${String(v.emotion)}`);
  if (!STRENGTHS.includes(v.strength as Strength)) throw new SegmentFormatError(`line.strength 不合法：${String(v.strength)}`);
  if (!SPEEDS.includes(v.speed as Speed)) throw new SegmentFormatError(`line.speed 不合法：${String(v.speed)}`);
  if (!isObj(pos) || !SIDES.includes(pos.side as Side) || typeof pos.distance_cm !== 'number') {
    throw new SegmentFormatError(`line.pos 不合法：${JSON.stringify(pos)}`);
  }
  if (!Array.isArray(v.se)) throw new SegmentFormatError('line.se 要是陣列（沒有音效就給 []）');
  const out: SegmentEvent[] = v.se.map((x: unknown) => {
    if (!isObj(x) || typeof x.id !== 'string' || !seIds.includes(x.id)) throw new SegmentFormatError(`se.id 不在音效清單內：${JSON.stringify(x)}`);
    if (!SIDES.includes(x.side as Side)) throw new SegmentFormatError(`se.side 不合法：${JSON.stringify(x)}`);
    return { type: 'se', id: x.id, side: x.side as Side };
  });
  const emotion = v.emotion as Emotion;
  // 位置連動：貼耳（10 公分內）又沒標激動的 normal 句改成小聲（tone.ts nearVoice）
  const line: LineEvent = { type: 'line', ja: v.ja, zh: v.zh, voice: nearVoice(v.voice as Voice, pos.distance_cm, emotion), emotion, strength: v.strength as Strength, speed: v.speed as Speed, pos: { side: pos.side as Side, distance_cm: pos.distance_cm } };
  if (typeof v.en === 'string' && v.en.trim()) line.en = v.en;
  out.push(line);
  return out;
}

interface Frame {
  kind: 'obj' | 'arr';
  start: number;
  key: string | null; // obj：目前這個值的 key
  expectingKey: boolean;
}

export interface SegmentParserHandlers {
  onLine: (raw: unknown, index: number) => void;
  onState: (raw: unknown) => void;
  onActions?: (raw: unknown) => void;
  onMemory?: (raw: unknown) => void;
}

/**
 * 增量解析器：feed() 可以吃任意切法的字串片段。
 * 只追蹤括號深度、字串與 key；lines 陣列（第二層）的元素或 state 值（第一層）閉合時，切出那一段 JSON.parse 後回呼。
 */
export class SegmentStreamParser {
  private buf = '';
  private pos = 0;
  private stack: Frame[] = [];
  private inString = false;
  private escape = false;
  private strStart = 0;
  private lineCount = 0;
  private done = false;
  private readonly h: SegmentParserHandlers;

  constructor(h: SegmentParserHandlers) {
    this.h = h;
  }

  get finished(): boolean {
    return this.done;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    for (; this.pos < this.buf.length; this.pos++) this.step(this.buf[this.pos]!, this.pos);
  }

  /** 串流結束時呼叫：根物件沒閉合代表輸出被截斷。 */
  end(): void {
    if (!this.done) throw new SegmentFormatError(`輸出不完整（停在第 ${this.buf.length} 字元，深度 ${this.stack.length}）`);
  }

  private step(c: string, i: number): void {
    if (this.inString) {
      if (this.escape) this.escape = false;
      else if (c === '\\') this.escape = true;
      else if (c === '"') {
        this.inString = false;
        const top = this.stack[this.stack.length - 1];
        if (top?.kind === 'obj' && top.expectingKey) top.key = JSON.parse(this.buf.slice(this.strStart, i + 1)) as string;
      }
      return;
    }
    if (this.done) {
      if (!/\s/.test(c)) throw new SegmentFormatError(`根物件結束後還有內容：${JSON.stringify(c)}`);
      return;
    }
    const top = this.stack[this.stack.length - 1];
    switch (c) {
      case '"':
        this.inString = true;
        this.strStart = i;
        break;
      case '{':
      case '[':
        if (!top && c !== '{') throw new SegmentFormatError('根值必須是物件');
        this.stack.push({ kind: c === '{' ? 'obj' : 'arr', start: i, key: null, expectingKey: c === '{' });
        break;
      case '}':
      case ']': {
        const f = this.stack.pop();
        if (!f || (f.kind === 'obj') !== (c === '}')) throw new SegmentFormatError(`括號不成對（第 ${i} 字元）`);
        this.closed(f, i);
        break;
      }
      case ':':
        if (top?.kind === 'obj') top.expectingKey = false;
        break;
      case ',':
        if (top?.kind === 'obj') top.expectingKey = true;
        break;
      default:
        break;
    }
  }

  private closed(f: Frame, i: number): void {
    const depth = this.stack.length; // f 已 pop
    if (depth === 0) {
      this.done = true;
      return;
    }
    const parent = this.stack[depth - 1]!;
    const root = this.stack[0]!;
    const raw = () => JSON.parse(this.buf.slice(f.start, i + 1)) as unknown;
    if (depth === 2 && parent.kind === 'arr' && root.key === 'lines') this.h.onLine(raw(), this.lineCount++);
    else if (depth === 1 && parent.key === 'state') this.h.onState(raw());
    else if (depth === 1 && parent.key === 'actions') this.h.onActions?.(raw());
    else if (depth === 1 && parent.key === 'memory') this.h.onMemory?.(raw());
  }
}
