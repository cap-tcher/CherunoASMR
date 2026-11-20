import { describe, expect, it } from 'vitest';
import { SegmentFormatError, SegmentStreamParser, parseLine, rubyParts, segmentSchema } from './segment.ts';

const SE = ['breath_blow', 'rain'] as const;

const sample = JSON.stringify(
  {
    lines: [
      { ja: 'おかえり……今日も{頑張|がんば}ったね', zh: '歡迎回來……今天也辛苦了', voice: 'whisper', emotion: 'adoring', strength: 1, speed: 'slow', pos: { side: 'left', distance_cm: 10 }, se: [] },
      // 字串裡放 } ] " \\ 與 key 形狀的文字，測解析器不會被騙
      {
        ja: '「}]」って書いてある……"}" "]" \\ {"lines":[',
        zh: '上面寫著「}]」……"呵呵"\\',
        voice: 'normal',
        emotion: 'none',
        strength: 1,
        speed: 'normal',
        pos: { side: 'right', distance_cm: 30 },
        se: [{ id: 'breath_blow', side: 'right' }],
      },
    ],
    state: { mio: { affection: 12, mood: '安心', tags: ['耳かき中'] } },
  },
  null,
  2,
);

function run(chunks: string[]) {
  const lines: unknown[] = [];
  const states: unknown[] = [];
  const p = new SegmentStreamParser({ onLine: (e) => lines.push(e), onState: (s) => states.push(s) });
  for (const c of chunks) p.feed(c);
  p.end();
  return { lines, states };
}

function randomChunks(s: string, seed: number): string[] {
  const out: string[] = [];
  let x = seed;
  for (let i = 0; i < s.length; ) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const n = 1 + (x % 7);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

describe('SegmentStreamParser', () => {
  const expected = JSON.parse(sample) as { lines: unknown[]; state: unknown };

  it('整段、逐字元、隨機長度三種餵法吐出相同結果', () => {
    const whole = run([sample]);
    const perChar = run([...sample]);
    expect(whole.lines).toEqual(expected.lines);
    expect(whole.states).toEqual([expected.state]);
    expect(perChar).toEqual(whole);
    for (let seed = 1; seed <= 20; seed++) expect(run(randomChunks(sample, seed))).toEqual(whole);
  });

  it('每句台詞一閉合就回呼，不等整段結束', () => {
    const seen: number[] = [];
    const p = new SegmentStreamParser({ onLine: (_e, i) => seen.push(i), onState: () => {} });
    // 第一句的 se: [] 之後緊接著那句的 }；餵到那裡為止
    const cut = sample.indexOf('}', sample.indexOf('"se": []')) + 1;
    p.feed(sample.slice(0, cut));
    expect(seen).toEqual([0]);
    p.feed(sample.slice(cut));
    expect(seen).toEqual([0, 1]);
  });

  it('輸出被截斷時 end() 丟錯', () => {
    const p = new SegmentStreamParser({ onLine: () => {}, onState: () => {} });
    p.feed(sample.slice(0, sample.length - 3));
    expect(() => p.end()).toThrow(SegmentFormatError);
  });

  it('根物件結束後還有非空白內容時丟錯', () => {
    expect(() => run([sample + ' {}'])).toThrow(SegmentFormatError);
  });
});

describe('parseLine', () => {
  const ok = { ja: 'a', zh: 'b', voice: 'normal', emotion: 'none', strength: 1, speed: 'normal', pos: { side: 'left', distance_cm: 50 }, se: [{ id: 'rain', side: 'center' }] };
  it('展開成「音效…、台詞」', () => {
    expect(parseLine(ok, SE)).toEqual([
      { type: 'se', id: 'rain', side: 'center' },
      { type: 'line', ja: 'a', zh: 'b', voice: 'normal', emotion: 'none', strength: 1, speed: 'normal', pos: { side: 'left', distance_cm: 50 } },
    ]);
  });
  it('貼耳（10 公分內）的 normal 句改成小聲；激動的情緒不壓', () => {
    const near = { ...ok, pos: { side: 'left', distance_cm: 5 } };
    expect((parseLine(near, SE).at(-1) as { voice: string }).voice).toBe('soft');
    expect((parseLine({ ...near, emotion: 'excited' }, SE).at(-1) as { voice: string }).voice).toBe('normal');
    expect((parseLine({ ...near, voice: 'whisper' }, SE).at(-1) as { voice: string }).voice).toBe('whisper');
  });
  it('句中耳語《》沒成對時丟錯；成對的照常', () => {
    expect(() => parseLine({ ...ok, ja: 'ねえ、《ひみつ' }, SE)).toThrow('耳語標記不合法');
    expect(() => parseLine({ ...ok, ja: 'ねえ、《ひみつ》だよ' }, SE)).not.toThrow();
  });
  it('rubyParts：《》不顯示，裡面的字標成耳語', () => {
    expect(rubyParts('ねえ、《{今日|きょう}は》ね')).toEqual([{ text: 'ねえ、' }, { text: '今日', reading: 'きょう', whisper: true }, { text: 'は', whisper: true }, { text: 'ね' }]);
  });
  it('emotion／strength／speed 不合法時丟錯，不猜預設值', () => {
    expect(() => parseLine({ ...ok, emotion: 'angry' }, SE)).toThrow('line.emotion 不合法');
    expect(() => parseLine({ ...ok, strength: 3 }, SE)).toThrow('line.strength 不合法');
    expect(() => parseLine({ ...ok, speed: 'turbo' }, SE)).toThrow('line.speed 不合法');
  });
  it('voice 不合法時丟錯，不猜預設值', () => {
    expect(() => parseLine({ ...ok, voice: 'loud' }, SE)).toThrow(SegmentFormatError);
  });
  it('音效 id 不在清單內丟錯', () => {
    expect(() => parseLine({ ...ok, se: [{ id: 'evt1', side: 'left' }] }, SE)).toThrow(SegmentFormatError);
  });
  it('缺 se 陣列丟錯', () => {
    const { se: _drop, ...noSe } = ok;
    expect(() => parseLine(noSe, SE)).toThrow(SegmentFormatError);
  });
});

describe('rubyParts', () => {
  it('切出振假名片段', () => {
    expect(rubyParts('{明日|あした}も{澪|みお}と')).toEqual([{ text: '明日', reading: 'あした' }, { text: 'も' }, { text: '澪', reading: 'みお' }, { text: 'と' }]);
    expect(rubyParts('ふつうの文')).toEqual([{ text: 'ふつうの文' }]);
  });
});

describe('segmentSchema', () => {
  type S = {
    properties: Record<string, { minItems?: number; maxItems?: number; items: { required: string[]; properties: { se: { items: { properties: { id: { enum: string[] } } } } } } }>;
    required: string[];
  };
  const s = segmentSchema({ stateSchema: { type: 'object' }, seIds: SE, withEn: false, lineRange: { min: 3, max: 8 } }) as S;
  it('lines 最前面（串流時台詞先出來），且至少三句；actions 恰 3 個', () => {
    expect(Object.keys(s.properties)).toEqual(['lines', 'state', 'actions', 'memory']);
    expect(s.required).toEqual(['lines', 'state', 'actions', 'memory']);
    expect(s.properties.lines!.minItems).toBe(3);
    expect(s.properties.actions!.minItems).toBe(3);
    expect(s.properties.actions!.maxItems).toBe(3);
  });
  it('音效 id 限定為清單', () => {
    expect(s.properties.lines!.items.properties.se.items.properties.id.enum).toEqual(['breath_blow', 'rain']);
  });
  it('選 EN 時每句要求 en', () => {
    const en = segmentSchema({ stateSchema: {}, seIds: SE, withEn: true, lineRange: { min: 3, max: 8 } }) as S;
    expect(en.properties.lines!.items.required).toContain('en');
    expect(s.properties.lines!.items.required).not.toContain('en');
  });
});

describe('SegmentStreamParser：actions', () => {
  it('actions 閉合時回呼', () => {
    const got: unknown[] = [];
    const p = new SegmentStreamParser({ onLine: () => {}, onState: () => {}, onActions: (a) => got.push(a) });
    p.feed(JSON.stringify({ lines: [], state: {}, actions: ['幫我掏耳朵', '說想睡了', '問她為什麼'] }));
    p.end();
    expect(got).toEqual([['幫我掏耳朵', '說想睡了', '問她為什麼']]);
  });
});

describe('台詞混進程式碼標記（2026-11-19 實測小模型）', () => {
  const base = { zh: '譯', voice: 'normal', emotion: 'none', strength: 1, speed: 'normal', pos: { side: 'left', distance_cm: 10 }, se: [] };
  it('振假名的大括號合法；其他 ASCII 括號、角括號、雙引號拒收', () => {
    expect(() => parseLine({ ...base, ja: '{頑張|がんば}ったね' }, [])).not.toThrow();
    expect(() => parseLine({ ...base, ja: 'あなたも疲れちゃったね。」]   </lines>' }, [])).toThrow(SegmentFormatError);
    expect(() => parseLine({ ...base, ja: '話を聞くよ。」},【whisper】' }, [])).toThrow('程式碼標記');
    expect(() => parseLine({ ...base, ja: 'ねえ"こっち' }, [])).toThrow(SegmentFormatError);
  });
});

describe('每段台詞句數（系統核心可調）', () => {
  type L = { properties: { lines: { minItems: number; maxItems: number } } };
  it('schema 的 minItems／maxItems 照設定；不合法的範圍直接丟錯', () => {
    const s = segmentSchema({ stateSchema: null, seIds: SE, withEn: false, lineRange: { min: 5, max: 5 } }) as L;
    expect(s.properties.lines).toMatchObject({ minItems: 5, maxItems: 5 });
    expect(() => segmentSchema({ stateSchema: null, seIds: SE, withEn: false, lineRange: { min: 6, max: 4 } })).toThrow(/最少 ≤ 最多/);
    expect(() => segmentSchema({ stateSchema: null, seIds: SE, withEn: false, lineRange: { min: 0, max: 4 } })).toThrow(/1～20/);
    expect(() => segmentSchema({ stateSchema: null, seIds: SE, withEn: false, lineRange: { min: 3, max: 21 } })).toThrow(/1～20/);
  });
});
