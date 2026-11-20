import { describe, expect, it } from 'vitest';
import { controlsKey, DEFAULT_ZONOS_TONE as DEFAULT_TABLE, formatControls, splitControls, nearVoice, parseControls, SpanFormatError, whisperSpans, withToneDefaults, zonosControls, zonosSpans } from './tone.ts';

const DEFAULT_ZONOS_TONE = { ...DEFAULT_TABLE, scale: 1 }; // 對照值本身（不乘強度比例）
const Z = (t: Parameters<typeof zonosControls>[0]) => zonosControls(t, DEFAULT_ZONOS_TONE);

describe('語氣 → ZONOS controls（Z-02 的範圍）', () => {
  it('音量、速度、情緒照對照表', () => {
    expect(Z({ voice: 'normal' })).toEqual({});
    expect(Z({ voice: 'whisper' })).toEqual({ 'delivery.whisper': 3, 'cond.loudness': -29 });
    expect(Z({ voice: 'soft' })).toEqual({ 'delivery.whisper': 1.5, 'cond.loudness': -26 });
    expect(Z({ voice: 'normal', speed: 'slow', emotion: 'adoring', strength: 2 })).toEqual({ 'delivery.tempo': -1, 'emotions.adoring': 4 });
    expect(Z({ voice: 'normal', emotion: 'excited', strength: 2 })).toEqual({ 'cond.loudness': -16, 'mood.arousal': 4, 'delivery.tempo': 1 });
  });
  it('強度 2 沒有收（音高超上限）的情緒用強度 1', () => {
    expect(Z({ voice: 'normal', emotion: 'happy', strength: 2 })).toEqual({ 'emotions.happy': 2 });
  });
  it('疊加上限：耳語類開著時情緒最多強度 1、不疊速度', () => {
    // 囁き／吐息不疊情緒（第三輪：疊了常出空音或 500）；小声可以疊強度 1
    expect(Z({ voice: 'whisper', emotion: 'adoring', strength: 2, speed: 'slow' })).toEqual({ 'delivery.whisper': 3, 'cond.loudness': -29 });
    expect(Z({ voice: 'soft', emotion: 'adoring', strength: 2, speed: 'slow' })).toEqual({ 'delivery.whisper': 1.5, 'cond.loudness': -26, 'emotions.adoring': 2 });
    expect(Z({ voice: 'soft', emotion: 'sleepy', strength: 1 })).toEqual({ 'delivery.whisper': 1.5, 'cond.loudness': -26, 'mood.arousal': -4 });
    // 耳語類的響度由音量決定：激動情緒帶的響度不覆蓋
    expect(Z({ voice: 'soft', emotion: 'excited', strength: 1 })).toEqual({ 'delivery.whisper': 1.5, 'cond.loudness': -26, 'mood.arousal': 3 });
  });
  it('情緒的音高不超過基準約 +40%：強度 2 只收量測時沒超過的', () => {
    const two = Object.entries(DEFAULT_ZONOS_TONE.emotion).filter(([, v]) => v[1]).map(([k]) => k).sort();
    expect(two).toEqual(['adoring', 'content', 'excited', 'relieved', 'sad', 'serene']);
  });
  it('條件（cond.*）拆成 condition_values；範圍照 ZONOS 的 edges', () => {
    expect(splitControls({ 'delivery.whisper': 3, 'cond.loudness': -29 })).toEqual({ controls: { 'delivery.whisper': 3 }, conditionValues: { loudness: -29 } });
    expect(parseControls('cond.loudness=-29')).toEqual({ 'cond.loudness': -29 });
    expect(() => parseControls('cond.loudness=-50')).toThrow('-40～0');
    expect(() => parseControls('cond.pitch=3')).toThrow('不是 ZONOS 的條件');
    expect(zonosSpans({ voice: 'normal', ja: '《ひみつ》' }, { ...DEFAULT_ZONOS_TONE, span: { 'delivery.whisper': 3, 'cond.loudness': -29 } })[0]!.controls).toEqual({ 'delivery.whisper': 3 });
  });
  it('情緒與起伏強度：只縮情緒與激動，耳語、速度、響度不動；預設 0.7、範圍 0.3～1', () => {
    expect(DEFAULT_TABLE.scale).toBe(0.7);
    expect(zonosControls({ voice: 'normal', emotion: 'excited', strength: 2 })).toEqual({ 'cond.loudness': -16, 'mood.arousal': 2.8, 'delivery.tempo': 1 });
    expect(zonosControls({ voice: 'soft', emotion: 'adoring', strength: 1 })).toEqual({ 'delivery.whisper': 1.5, 'cond.loudness': -26, 'emotions.adoring': 1.4 });
    expect(zonosControls({ voice: 'normal', emotion: 'sad', strength: 2 }, { ...DEFAULT_TABLE, scale: 0.1 })['emotions.sad']).toBe(1.8); // 低於 0.3 當 0.3
    expect(withToneDefaults({ voice: DEFAULT_TABLE.voice } as never).scale).toBe(0.7);
  });
  it('controlsKey 跟鍵的順序無關', () => {
    expect(controlsKey({ b: 1, a: 2 })).toBe(controlsKey({ a: 2, b: 1 }));
    expect(controlsKey({})).toBe('');
  });
  it('nearVoice：10 公分內才壓、11 公分不壓', () => {
    expect(nearVoice('normal', 10)).toBe('soft');
    expect(nearVoice('normal', 11)).toBe('normal');
    expect(nearVoice('normal', 3, 'surprised')).toBe('normal');
  });
});

describe('句中耳語《》', () => {
  it('範圍是念的文字（よみ）上的位置；括號不進念的文字', () => {
    const r = whisperSpans('ねえ、《{今日|きょう}はここまで》ね');
    expect(r.reading).toBe('ねえ、きょうはここまでね');
    expect(r.spans).toEqual([{ start: 3, end: 11 }]);
    expect([...r.reading].slice(3, 11).join('')).toBe('きょうはここまで');
  });
  it('沒成對、巢狀、空的、超過 3 段丟錯', () => {
    expect(() => whisperSpans('《ねえ')).toThrow(SpanFormatError);
    expect(() => whisperSpans('ねえ》')).toThrow(SpanFormatError);
    expect(() => whisperSpans('《ね《え》》')).toThrow('巢狀');
    expect(() => whisperSpans('ね《》え')).toThrow('沒有字');
    expect(() => whisperSpans('《a》《b》《c》《d》')).toThrow('最多 3 段');
    expect(whisperSpans('ふつう').spans).toEqual([]);
  });
  it('zonosSpans：一般音量的句子才加；整句耳語類就不加', () => {
    expect(zonosSpans({ voice: 'normal', ja: 'ねえ、《ひみつ》' })).toEqual([{ start: 3, end: 6, controls: { 'delivery.whisper': 3 } }]);
    expect(zonosSpans({ voice: 'whisper', ja: 'ねえ、《ひみつ》' })).toEqual([]);
  });
});

describe('對照表的文字格式（系統核心可調）', () => {
  it('來回轉換；空白＝不加', () => {
    expect(parseControls('delivery.whisper=3, emotions.adoring=2')).toEqual({ 'delivery.whisper': 3, 'emotions.adoring': 2 });
    expect(parseControls(formatControls({ 'mood.arousal': -4, 'delivery.tempo': -1 }))).toEqual({ 'mood.arousal': -4, 'delivery.tempo': -1 });
    expect(parseControls('  ')).toEqual({});
  });
  it('寫錯就說哪裡錯', () => {
    expect(() => parseControls('whisper=3')).toThrow('不是 ZONOS 的控制名稱');
    expect(() => parseControls('delivery.whisper')).toThrow('看不懂');
    expect(() => parseControls('delivery.whisper=30')).toThrow('超過 ±20');
  });
  it('舊存檔補上新格，改過的保留', () => {
    const t = withToneDefaults({ voice: { ...DEFAULT_ZONOS_TONE.voice, whisper: { 'delivery.whisper': 2.5 } } });
    expect(t.voice.whisper).toEqual({ 'delivery.whisper': 2.5 });
    expect(t.emotion.adoring).toEqual(DEFAULT_ZONOS_TONE.emotion.adoring);
    expect(t.span).toEqual(DEFAULT_ZONOS_TONE.span);
  });
});
