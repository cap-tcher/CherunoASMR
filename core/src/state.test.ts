import { describe, expect, it } from 'vitest';
import { StateRejectedError, StateTimeline, applySnapshot, compileSnapshotSchema, initialSnapshot, type SecretFormat } from './state.ts';

const format: SecretFormat = {
  fields: [
    { key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 },
    { key: 'mood', label: '心情', type: 'enum', options: ['平靜', '開心', '害羞', '想睡'], initial: '平靜' },
    { key: 'note', label: '心聲', type: 'text', maxLength: 20, initial: '' },
    { key: 'tags', label: '狀態 tag', type: 'tags', maxItems: 4, maxLength: 8, initial: [] },
  ],
};

/** 對抗式假 LLM：每段都想讓好感 +20、塞 3 個全新 tag、2 個未知欄位。 */
function greedyLlm(prev: Record<string, unknown>, n: number) {
  const tags = [...((prev.tags as string[]) ?? []), `新tag${n}a`, `新tag${n}b`, `新tag${n}c`];
  return { affection: (prev.affection as number) + 20, mood: '開心', note: '好喜歡'.repeat(10), tags, hack1: 999, hack2: ['x'] };
}

describe('StateTimeline：不會無限增值', () => {
  it('1,000 段對抗式輸入：數值在範圍內、每段變化 ≤ 上限、tag ≤ 上限、欄位 ⊆ schema', () => {
    const t = new StateTimeline(format, ['mio']);
    let prevAff = 10;
    for (let i = 0; i < 1000; i++) {
      const prev = t.current().mio!;
      const { snapshots, clamps } = t.append(`s${i}`, { mio: greedyLlm(prev, i) });
      const s = snapshots.mio!;
      const aff = s.affection as number;
      expect(aff).toBeGreaterThanOrEqual(0);
      expect(aff).toBeLessThanOrEqual(100);
      expect(Math.abs(aff - prevAff)).toBeLessThanOrEqual(5);
      expect((s.tags as string[]).length).toBeLessThanOrEqual(4);
      expect(Object.keys(s).sort()).toEqual(['affection', 'mood', 'note', 'tags']);
      expect((s.note as string).length).toBeLessThanOrEqual(20);
      expect(clamps.some((c) => c.kind === 'unknown_field' && c.key === 'hack1')).toBe(true);
      prevAff = aff;
    }
    expect(t.current().mio!.affection).toBe(100);
  });

  it('重生 100 次：結果與第一次相同，不跨重生累積', () => {
    const t = new StateTimeline(format, ['mio']);
    t.append('s0', { mio: { affection: 14, mood: '開心', note: '', tags: ['耳かき'] } });
    const raw = { mio: { affection: 99, mood: '害羞', note: 'ドキドキ', tags: ['耳かき', '添い寝'] } };
    const first = t.append('s1', raw).snapshots;
    for (let i = 0; i < 100; i++) expect(t.regenerate('s1', raw).snapshots).toEqual(first);
    expect(first.mio!.affection).toBe(19); // 14 + 上限 5
    expect(t.before('s1').mio!.affection).toBe(14);
  });

  it('刪除中間一段：後續從前一段快照重算', () => {
    const t = new StateTimeline(format, ['mio']);
    const up = (a: number) => ({ mio: { affection: a, mood: '平靜', note: '', tags: [] } });
    t.append('a', up(15)); // 10 → 15
    t.append('b', up(20)); // 15 → 20
    t.append('c', up(25)); // 20 → 25
    t.remove('b');
    // c 的前一段變成 a（15），想到 25 被限在 20
    expect(t.get('c').snapshots.mio!.affection).toBe(20);
    expect(t.length).toBe(2);
  });

  it('角色 id 互為子字串（mio／mioka）：只更新 id 相符的那個', () => {
    const t = new StateTimeline(format, ['mio', 'mioka']);
    const base = initialSnapshot(format);
    t.append('s0', { mio: { ...base, affection: 15 }, mioka: { ...base } });
    expect(t.current().mio!.affection).toBe(15);
    expect(t.current().mioka!.affection).toBe(10);
  });

  it('tag 沒列出＝不再成立（整份替換，不累加）', () => {
    const t = new StateTimeline(format, ['mio']);
    t.append('a', { mio: { affection: 10, mood: '平靜', note: '', tags: ['A', 'B'] } });
    t.append('b', { mio: { affection: 10, mood: '平靜', note: '', tags: ['C'] } });
    expect(t.current().mio!.tags).toEqual(['C']);
  });
});

describe('格式錯誤：拒收，不沿用舊值', () => {
  it('缺欄位、型別錯、不在選項內 → StateRejectedError，時間軸不變', () => {
    const t = new StateTimeline(format, ['mio']);
    t.append('a', { mio: { affection: 12, mood: '平靜', note: '', tags: [] } });
    const bads = [
      { mio: { affection: 12, mood: '平靜', note: '' } },
      { mio: { affection: '12', mood: '平靜', note: '', tags: [] } },
      { mio: { affection: 12, mood: '生氣', note: '', tags: [] } },
      { other: {} },
      'not an object',
    ];
    for (const b of bads) expect(() => t.append('b', b)).toThrow(StateRejectedError);
    expect(t.length).toBe(1);
    expect(() => t.regenerate('a', { mio: { affection: 12 } })).toThrow(StateRejectedError);
    expect(t.current().mio!.affection).toBe(12);
  });

  it('applySnapshot 列出所有問題', () => {
    try {
      applySnapshot(format, 'mio', initialSnapshot(format), { affection: 'x', mood: '生氣' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StateRejectedError);
      expect((e as StateRejectedError).problems).toHaveLength(4); // affection、mood、note、tags
    }
  });
});

describe('compileSnapshotSchema', () => {
  it('所有欄位 required、不接受額外欄位、tag 有上限', () => {
    const s = compileSnapshotSchema(format) as { required: string[]; additionalProperties: boolean; properties: Record<string, { maxItems?: number }> };
    expect(s.required).toEqual(['affection', 'mood', 'note', 'tags']);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.tags!.maxItems).toBe(4);
  });
});

describe('面板手動編輯', () => {
  const full = { affection: 50, mood: '平靜', note: '', tags: [] as string[] };
  it('不套每段變化上限；後面段落從手改的值重算', () => {
    const t = new StateTimeline(format, ['mio']);
    t.append('a', { mio: { ...full, affection: 15 } });
    t.editCurrent('mio', { ...full, affection: 90 }); // 15 → 90 一次跳 75，手動允許
    expect(t.current().mio!.affection).toBe(90);
    t.append('b', { mio: { ...full, affection: 100 } }); // LLM 想再 +10 → 限為 +5
    expect(t.current().mio!.affection).toBe(95);
  });
  it('超出範圍、不在選項內、tag 太多 → 拒收，狀態不變', () => {
    const t = new StateTimeline(format, ['mio']);
    t.append('a', { mio: full });
    for (const bad of [{ ...full, affection: 101 }, { ...full, mood: '生氣' }, { ...full, tags: ['a', 'b', 'c', 'd', 'e'] }, { ...full, hack: 1 }]) {
      expect(() => t.editCurrent('mio', bad as never)).toThrow(StateRejectedError);
    }
    expect(t.current().mio!.affection).toBe(15); // 10 → 50 被限為 +5
  });
  it('還沒有段落時改的是初始值；重置回到格式初始值', () => {
    const t = new StateTimeline(format, ['mio']);
    t.editCurrent('mio', { ...full, affection: 70 });
    t.append('a', { mio: { ...full, affection: 100 } });
    expect(t.current().mio!.affection).toBe(75);
    t.reset('mio');
    expect(t.current().mio).toEqual(initialSnapshot(format));
  });
  it('重生那段會清掉手改', () => {
    const t = new StateTimeline(format, ['mio']);
    t.append('a', { mio: { ...full, affection: 15 } });
    t.editCurrent('mio', { ...full, affection: 90 });
    t.regenerate('a', { mio: { ...full, affection: 15 } });
    expect(t.current().mio!.affection).toBe(15);
  });
});


describe('可疊加清單 zones（ADV3.0 <zone>）', () => {
  const zf: SecretFormat = { fields: [{ key: 'zones', label: '部位', type: 'zones', levelMin: 0, levelMax: 10, maxDelta: 2, nameMaxLength: 10, stateMaxLength: 12, initial: [{ name: '耳朵', level: 1, state: '' }] }] };
  it('沒列出的維持原樣、新名稱新增、單項超過每段上限被限幅', () => {
    const t = new StateTimeline(zf, ['c']);
    const r = t.append('s1', { c: { zones: [{ name: '肩膀', level: 5, state: '放鬆' }] } });
    expect(r.snapshots.c!.zones).toEqual([
      { name: '耳朵', level: 1, state: '' },
      { name: '肩膀', level: 2, state: '放鬆' },
    ]);
    expect(r.clamps.map((x) => x.detail)).toEqual(['「肩膀」模型想從 Lv.0 改成 Lv.5，超過每段最多 ±2，已改成 Lv.2']);
    const r2 = t.append('s2', { c: { zones: [{ name: '耳朵', level: 3, state: '熱' }] } });
    expect(r2.snapshots.c!.zones).toEqual([
      { name: '耳朵', level: 3, state: '熱' },
      { name: '肩膀', level: 2, state: '放鬆' },
    ]);
  });
  it('手動編輯：改名後舊名消失；名稱重複或 Lv. 超出範圍拒收', () => {
    const t = new StateTimeline(zf, ['c']);
    t.editCurrent('c', { zones: [{ name: '耳後', level: 1, state: '' }] });
    expect(t.current().c!.zones).toEqual([{ name: '耳後', level: 1, state: '' }]);
    expect(() => t.editCurrent('c', { zones: [{ name: 'a', level: 1, state: '' }, { name: 'a', level: 2, state: '' }] })).toThrow(StateRejectedError);
    expect(() => t.editCurrent('c', { zones: [{ name: 'a', level: 11, state: '' }] })).toThrow(StateRejectedError);
  });
  it('型別錯誤整段拒收', () => {
    expect(() => new StateTimeline(zf, ['c']).append('s1', { c: { zones: [{ name: 'x', level: '高' }] } })).toThrow(StateRejectedError);
  });
});

describe('開放數值表 kv（ADV3.0 <stat>）', () => {
  const kf: SecretFormat = { fields: [{ key: 'stats', label: '身體數值', type: 'kv', nameMaxLength: 10, valueMaxLength: 8, initial: [{ name: '心跳', value: '70bpm' }] }] };
  it('只更新列出的項目、可新增項目、值太長截斷', () => {
    const t = new StateTimeline(kf, ['c']);
    const r = t.append('s1', { c: { stats: [{ name: '呼吸', value: '有點急促而且很長很長' }] } });
    expect(r.snapshots.c!.stats).toEqual([
      { name: '心跳', value: '70bpm' },
      { name: '呼吸', value: '有點急促而且很長' },
    ]);
    expect(r.clamps[0]!.kind).toBe('too_long');
    expect(t.append('s2', { c: { stats: [{ name: '心跳', value: '90bpm' }] } }).snapshots.c!.stats).toEqual([
      { name: '心跳', value: '90bpm' },
      { name: '呼吸', value: '有點急促而且很長' },
    ]);
  });
});

describe('時間軸存檔與還原（A-04）', () => {
  const f2: SecretFormat = { fields: [{ key: 'a', label: 'A', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 }] };
  it('存檔後還原，快照與重算結果相同；手動修改保留', () => {
    const t = new StateTimeline(f2, ['c']);
    t.append('s1', { c: { a: 30 } }); // 限幅成 15
    t.editCurrent('c', { a: 50 });
    t.append('s2', { c: { a: 99 } }); // 50 → 55
    const r = StateTimeline.restore(f2, ['c'], JSON.parse(JSON.stringify(t.toJSON())));
    expect(r.current()).toEqual({ c: { a: 55 } });
    expect(r.before('s2')).toEqual({ c: { a: 50 } });
    expect(r.length).toBe(2);
  });
  it('起始快照從角色身上的狀態開始；不合格式就丟錯', () => {
    const t = new StateTimeline(f2, ['c']);
    t.setBase('c', { a: 80 });
    expect(t.current()).toEqual({ c: { a: 80 } });
    expect(() => t.setBase('c', { a: 200 })).toThrow(StateRejectedError);
    expect(() => t.setBase('c', { b: 1 } as never)).toThrow(StateRejectedError);
  });
});

describe('允許的名稱清單（2026-11-19：小模型會自己編「部位3」「left」）', () => {
  const nf: SecretFormat = {
    fields: [
      { key: 'zones', label: '部位', type: 'zones', levelMin: 0, levelMax: 10, maxDelta: 2, nameMaxLength: 10, stateMaxLength: 12, names: ['耳朵', '首筋'], initial: [{ name: '耳朵', level: 1, state: '' }] },
      { key: 'body', label: '身體數值', type: 'kv', nameMaxLength: 10, valueMaxLength: 10, names: ['呼吸', '體溫'], initial: [] },
    ],
  };
  it('有設名稱時 schema 的 name 是 enum；沒設是自由字串', () => {
    const p = (compileSnapshotSchema(nf) as { properties: Record<string, { items: { properties: { name: unknown } } }> }).properties;
    expect(p.zones!.items.properties.name).toEqual({ enum: ['耳朵', '首筋'] });
    expect(p.body!.items.properties.name).toEqual({ enum: ['呼吸', '體溫'] });
    const free = compileSnapshotSchema({ fields: [{ ...nf.fields[0]!, names: undefined } as SecretFormat['fields'][number]] }) as { properties: Record<string, { items: { properties: { name: unknown } } }> };
    expect(free.properties.zones!.items.properties.name).toEqual({ type: 'string', maxLength: 10 });
  });
  it('清單外的名稱整段拒收（不偷偷丟掉）', () => {
    const t = new StateTimeline(nf, ['c']);
    expect(() => t.append('s1', { c: { zones: [{ name: '部位3', level: 1, state: '' }], body: [] } })).toThrow(/名稱只能用：耳朵、首筋（收到「部位3」）/);
    expect(() => t.append('s1', { c: { zones: [], body: [{ name: '心跳', value: '85bpm' }] } })).toThrow(/名稱只能用：呼吸、體溫/);
    expect(t.append('s1', { c: { zones: [{ name: '首筋', level: 1, state: '熱' }], body: [{ name: '呼吸', value: '急促' }] } }).snapshots.c!.zones).toHaveLength(2);
  });
  it('欄位表：初始項目不在清單、清單重複或空白都擋下', () => {
    expect(() => new StateTimeline({ fields: [{ ...nf.fields[0]!, initial: [{ name: '唇', level: 0, state: '' }] } as SecretFormat['fields'][number]] }, ['c'])).toThrow(/初始項目「唇」不在允許名稱裡/);
    expect(() => new StateTimeline({ fields: [{ ...nf.fields[1]!, names: ['呼吸', '呼吸'] } as SecretFormat['fields'][number]] }, ['c'])).toThrow(/允許名稱重複/);
  });
});
