// 台詞的語氣 → ZONOS 的 controls（[[PLAN_ZONOS語氣控制]]、TASKS Z-02 的量測與篩選）。
// 使用者 2026-11-20：「該耳語沒耳語 該激烈沒激烈」——之前 LLM 標的 voice 完全沒傳給 ZONOS，每句都同一種語氣。
import type { Voice } from './segment.ts';

export type Emotion = 'none' | 'serene' | 'relieved' | 'content' | 'adoring' | 'sad' | 'happy' | 'cute' | 'embarrassed' | 'surprised' | 'interested' | 'sleepy' | 'excited';
export type Speed = 'normal' | 'slow' | 'very_slow' | 'fast';
export type Strength = 1 | 2;

export const EMOTIONS: readonly Emotion[] = ['none', 'serene', 'relieved', 'content', 'adoring', 'sad', 'happy', 'cute', 'embarrassed', 'surprised', 'interested', 'sleepy', 'excited'];
export const SPEEDS: readonly Speed[] = ['normal', 'slow', 'very_slow', 'fast'];
export const STRENGTHS: readonly Strength[] = [1, 2];

/** 畫面上顯示的標籤（Z-02 的標籤名） */
export const EMOTION_LABEL: Record<Emotion, string> = {
  none: '',
  serene: '優しい',
  relieved: '安心',
  content: '満足',
  adoring: '甘え',
  sad: '寂しい',
  happy: '嬉しい',
  cute: '可愛く',
  embarrassed: '照れ',
  surprised: '驚き',
  interested: '興味',
  sleepy: '眠い',
  excited: '高ぶり',
};
export const SPEED_LABEL: Record<Speed, string> = { normal: '', slow: 'ゆっくり', very_slow: 'とてもゆっくり', fast: '速め' };

type Controls = Record<string, number>;
export interface ZonosToneTable {
  voice: Record<Voice, Controls>;
  speed: Record<Speed, Controls>;
  /** [強度 1, 強度 2]；強度 2 是 null＝音高會超過上限，一律用強度 1 */
  emotion: Record<Exclude<Emotion, 'none'>, [Controls, Controls | null]>;
  /** 句中《》的耳語（Z-02：整句 4 太弱太容易壞，句中短範圍用 3） */
  span: Controls;
  /**
   * 情緒與起伏強度（0.3～1）：情緒（emotions.*）與激動（mood.*）的強度乘上這個比例；耳語、速度、響度不受影響。
   * 使用者 2026-11-20：「語調變化好像開太大 聲音有點破掉」（量過沒有削波，峰值都在 0.8 以下 → 是控制太強把音高起伏推太猛）→ 預設 0.7
   */
  scale: number;
}
export const SCALE_RANGE = [0.3, 1] as const;

/**
 * Z-02 篩選結果（GTX 1070、聲音 c_6892a0el、三個 seed 量有聲比例／F0／長度）：
 * 音高不超過基準約 +40%、不出 500 或空音。excited 是 Z-08 的初始組合（arousal＋tempo），待使用者抽聽再調
 */
export const DEFAULT_ZONOS_TONE: ZonosToneTable = {
  // 第三輪（tone_listen.py）：耳語加響度條件 -29 有聲比例 0.69 → 0.48～0.57（三個 seed 都正常）；whisper 4＋響度 -29 三個 seed 兩個 500 → 吐息也用 3＋響度
  voice: { normal: {}, soft: { 'delivery.whisper': 1.5, 'cond.loudness': -26 }, whisper: { 'delivery.whisper': 3, 'cond.loudness': -29 }, breath: { 'delivery.whisper': 3, 'cond.loudness': -29 } },
  speed: { normal: {}, slow: { 'delivery.tempo': -1 }, very_slow: { 'delivery.tempo': -2 }, fast: { 'delivery.tempo': 1 } },
  emotion: {
    serene: [{ 'emotions.serene': 2 }, { 'emotions.serene': 4 }],
    relieved: [{ 'emotions.relieved': 2 }, { 'emotions.relieved': 4 }],
    content: [{ 'emotions.content': 2 }, { 'emotions.content': 4 }],
    adoring: [{ 'emotions.adoring': 2 }, { 'emotions.adoring': 4 }],
    sad: [{ 'emotions.sad': 3 }, { 'emotions.sad': 6 }],
    happy: [{ 'emotions.happy': 2 }, null],
    cute: [{ 'emotions.cute': 2 }, null],
    embarrassed: [{ 'emotions.embarrassed': 2 }, null],
    surprised: [{ 'emotions.surprised': 2 }, null],
    interested: [{ 'emotions.interested': 2 }, null],
    sleepy: [{ 'mood.arousal': -4, 'delivery.tempo': -1 }, null],
    // 第三輪：響度 -18／-16 讓聲音變大，音高最多 +33%（上限約 +40%）
    excited: [{ 'cond.loudness': -18, 'mood.arousal': 3, 'delivery.tempo': 1 }, { 'cond.loudness': -16, 'mood.arousal': 4, 'delivery.tempo': 1 }],
  },
  span: { 'delivery.whisper': 3 },
  scale: 0.7,
};

export interface Tone {
  voice: Voice;
  emotion?: Emotion;
  strength?: Strength;
  speed?: Speed;
}

/** 囁き與吐息：不疊情緒（小声可以疊強度 1） */
export const whisperLike = (v: Voice) => v === 'whisper' || v === 'breath';

/**
 * 一句的 controls。疊加上限（Z-02、第三輪）：囁き／吐息不疊情緒；小声的情緒最多強度 1；耳語類都不疊速度、響度由音量那一格決定
 * （whisper 1.5＋cute／adoring 4 出空音；whisper 3＋serene 2 三個 seed 有一個 500）。舊台本沒有 emotion／speed＝不加
 */
export function zonosControls(t: Tone, table: ZonosToneTable = DEFAULT_ZONOS_TONE): Controls {
  const quiet = t.voice !== 'normal';
  const out: Controls = { ...table.voice[t.voice] };
  if (!quiet) Object.assign(out, table.speed[t.speed ?? 'normal']);
  const e = t.emotion ?? 'none';
  // 囁き／吐息（whisper 3）再疊任何情緒都不穩：三個 seed 常出空音或 500（第三輪實測 adoring／serene／sad／sleepy 都是），只用耳語
  if (e !== 'none' && !whisperLike(t.voice)) {
    const [one, two] = table.emotion[e];
    const pick = { ...(t.strength === 2 && two && !quiet ? two : one) };
    if (quiet) {
      delete pick['delivery.tempo'];
      delete pick['cond.loudness']; // 耳語類由音量那一格決定響度
    }
    Object.assign(out, pick);
  }
  const k = Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], table.scale ?? 1));
  for (const key of Object.keys(out)) if (key.startsWith('emotions.') || key.startsWith('mood.')) out[key] = Math.round(out[key]! * k * 100) / 100;
  return out;
}

/** controls 的固定字串（語音庫 key 用：同樣的語氣＝同一個 key） */
export const controlsKey = (c: Controls) =>
  Object.keys(c)
    .sort()
    .map((k) => `${k}=${c[k]}`)
    .join(',');

/** 會大聲、激動的情緒：貼耳距離也不自動壓低 */
const LOUD: ReadonlySet<Emotion> = new Set(['excited', 'surprised', 'happy']);
export const NEAR_CM = 10;

/** 位置連動（Z-06）：距離 10 公分內、模型標 normal、又不是激動的情緒 → 小聲（ASMR 貼耳說話不會用一般音量） */
export function nearVoice(voice: Voice, distanceCm: number, emotion: Emotion = 'none'): Voice {
  return voice === 'normal' && distanceCm <= NEAR_CM && !LOUD.has(emotion) ? 'soft' : voice;
}

// ---- 句中範圍：一句裡只耳語一段（ZONOS control_spans；TASKS Z-04 的後半） ----
// 模型在台詞裡用全形《》括住要耳語的那段；送給 ZONOS 時拿掉括號，範圍換成「念的文字」（{漢字|よみ} 換成よみ之後）的字元位置。
// 其他引擎與畫面都不顯示括號（audio text.py 的 to_reading／to_surface 也會拿掉）
export const SPAN_OPEN = '《';
export const SPAN_CLOSE = '》';
export const MAX_SPANS = 3;
/** 日文約 3 格音框／字（Z-01 第二輪：預設 1 會落到前半句） */
export const SPAN_RATE = 3;

export class SpanFormatError extends Error {}

/** 台詞 → 念的文字（よみ、沒有《》）與耳語範圍（code point 位置，左閉右開）；括號沒成對、巢狀、空的、超過 3 段就丟錯（不猜） */
export function whisperSpans(ja: string): { reading: string; spans: { start: number; end: number }[] } {
  let reading: string[] = [];
  const spans: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const m of ja.matchAll(/\{([^{}|]+)\|([^{}|]+)\}|[\s\S]/gu)) {
    if (m[2] !== undefined) {
      reading = reading.concat([...m[2]]);
      continue;
    }
    const ch = m[0];
    if (ch === SPAN_OPEN) {
      if (open !== null) throw new SpanFormatError(`《》不能巢狀：${ja.slice(0, 40)}`);
      open = reading.length;
    } else if (ch === SPAN_CLOSE) {
      if (open === null) throw new SpanFormatError(`《》沒有成對：${ja.slice(0, 40)}`);
      if (reading.length === open) throw new SpanFormatError(`《》裡沒有字：${ja.slice(0, 40)}`);
      spans.push({ start: open, end: reading.length });
      open = null;
    } else reading.push(ch);
  }
  if (open !== null) throw new SpanFormatError(`《》沒有成對：${ja.slice(0, 40)}`);
  if (spans.length > MAX_SPANS) throw new SpanFormatError(`《》最多 ${MAX_SPANS} 段：${ja.slice(0, 40)}`);
  return { reading: reading.join(''), spans };
}

/** 這句要給 ZONOS 的句中範圍：整句已經是耳語類就不用（整句的 voice 已經壓低） */
export function zonosSpans(t: Tone & { ja: string }, table: ZonosToneTable = DEFAULT_ZONOS_TONE): { start: number; end: number; controls: Controls }[] {
  if (t.voice !== 'normal') return [];
  // 響度、頻寬、語速（cond.*）是整句的條件，不能只套在一段上
  const steer = Object.fromEntries(Object.entries(table.span).filter(([k]) => !k.startsWith(COND)));
  return whisperSpans(t.ja).spans.map((s) => ({ ...s, controls: { ...steer } }));
}

// ---- 系統核心可調的對照表（Z-05）：每格寫成「類別.方向=強度, …」 ----
export class ToneTableError extends Error {}
const CONTROL_KEY = /^[a-z_]+\.[a-z_]+$/;
/** ZONOS 的條件（condition_values）：整句的響度、頻寬上限、語速；表上寫成 cond.<名稱>，範圍照 /v2/capabilities 的 edges */
export const COND = 'cond.';
export const CONDITION_RANGE: Record<string, [number, number, string]> = {
  'cond.loudness': [-40, 0, 'LUFS'],
  'cond.fmax': [4000, 24000, 'Hz'],
  'cond.speaking_rate': [4, 35, 'bytes/秒'],
};

/** 合併的 controls 拆成 ZONOS 的兩個欄位：steer（controls）與條件（condition_values） */
export function splitControls(c: Controls): { controls: Controls; conditionValues: Controls } {
  const controls: Controls = {};
  const conditionValues: Controls = {};
  for (const [k, v] of Object.entries(c)) {
    if (k.startsWith(COND)) conditionValues[k.slice(COND.length)] = v;
    else controls[k] = v;
  }
  return { controls, conditionValues };
}

export const formatControls = (c: Controls) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

/** 「delivery.whisper=3, emotions.adoring=2」→ controls；空字串＝不加。鍵要是「類別.方向」、強度 ±20 以內、最多 8 個（和音訊服務的檢查一致） */
export function parseControls(text: string): Controls {
  const out: Controls = {};
  for (const part of text.split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^=＝\s]+)\s*[=＝]\s*(-?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new ToneTableError(`「${part}」看不懂：寫成「類別.方向=強度」，例 delivery.whisper=3`);
    if (!CONTROL_KEY.test(m[1]!)) throw new ToneTableError(`「${m[1]}」不是 ZONOS 的控制名稱（格式：類別.方向，例 emotions.serene）`);
    const v = Number(m[2]);
    if (m[1]!.startsWith(COND)) {
      const r = CONDITION_RANGE[m[1]!];
      if (!r) throw new ToneTableError(`「${m[1]}」不是 ZONOS 的條件（只有 ${Object.keys(CONDITION_RANGE).join('、')}）`);
      if (v < r[0] || v > r[1]) throw new ToneTableError(`「${m[1]}」要在 ${r[0]}～${r[1]} ${r[2]} 之間`);
    } else if (Math.abs(v) > 20) throw new ToneTableError(`「${m[1]}」的強度 ${v} 超過 ±20`);
    out[m[1]!] = v;
  }
  if (Object.keys(out).length > 8) throw new ToneTableError('一格最多 8 個控制');
  return out;
}

/** 存檔裡的對照表補上新版本才有的格（舊存檔、匯入的備份）；使用者改過的格不動 */
export function withToneDefaults(t: Partial<ZonosToneTable> | undefined): ZonosToneTable {
  const d = DEFAULT_ZONOS_TONE;
  return {
    voice: { ...d.voice, ...(t?.voice ?? {}) },
    speed: { ...d.speed, ...(t?.speed ?? {}) },
    emotion: { ...d.emotion, ...(t?.emotion ?? {}) },
    span: t?.span ?? d.span,
    scale: typeof t?.scale === 'number' ? t.scale : d.scale,
  };
}
