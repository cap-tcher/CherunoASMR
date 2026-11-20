// 秘密狀態快照引擎（見 Obsidian [[狀態存快照]]、TASKS_本機串接 S-03）。
// 防無限增值的五條規則：
// 1. LLM 每段回完整快照，整份替換；tag 沒有 add／remove，沒列出＝不再成立
// 2. 秘密格式編譯成 JSON schema（只允許格式內欄位、數值範圍、長度、tag 上限）
// 3. 每段變化量上限：超過就限制在上限，並回傳限幅事件給 UI 明示
// 4. 每段存自己的快照；重生、刪除會從前一段重算
// 5. 以角色 id 為 key；prompt 只帶當下快照

/** 可疊加清單的一項（ADV3.0 zones：部位＋Lv.＋狀態） */
export interface Zone {
  name: string;
  level: number;
  state: string;
}
/** 開放數值表的一項（ADV3.0 stats：名稱→短文字，例：心跳 70bpm） */
export interface KvItem {
  name: string;
  value: string;
}

export type FieldValue = number | string | string[] | Zone[] | KvItem[];
export type Snapshot = Record<string, FieldValue>;

/**
 * hidden：只影響面板顯示（例：心裡話），不影響 schema。
 * zones／kv 照 ADV3.0 的 `<zone>`／`<stat>`（L2648–L2700）：LLM 只列這段有變化或新出現的項目，沒列出的維持原樣（不會被模型漏列刪掉）；刪除只能在面板手動做。
 */
export type StateField = { key: string; label: string; hidden?: boolean } & (
  | { type: 'number'; min: number; max: number; maxDelta: number; initial: number }
  | { type: 'text'; maxLength: number; initial: string }
  | { type: 'enum'; options: string[]; initial: string }
  | { type: 'tags'; maxItems: number; maxLength: number; initial: string[] }
  // names：允許的名稱清單；有設就只能用清單裡的名稱（schema 用 enum 鎖住），沒設＝自由命名（2026-11-19：小模型會自己編「部位3」「left」）
  | { type: 'zones'; levelMin: number; levelMax: number; maxDelta: number; nameMaxLength: number; stateMaxLength: number; names?: string[]; initial: Zone[] }
  | { type: 'kv'; nameMaxLength: number; valueMaxLength: number; names?: string[]; initial: KvItem[] }
);

export interface SecretFormat {
  fields: StateField[];
}

/** 依 PLAN 規格限幅（照常套用並回報）。 */
export type ClampKind = 'range' | 'delta' | 'too_long' | 'too_many_tags' | 'unknown_field';

export interface ClampEvent {
  characterId: string;
  key: string;
  kind: ClampKind;
  detail: string;
}

export class SecretFormatError extends Error {}

/** 一般模式（ADV3.0 非親密模式）不更新狀態：這段的 raw 記成 CARRY，重算時直接沿用前一段（不存舊快照，前面段落重生也會跟著變） */
export const CARRY = '__carry__';

/** 快照缺欄位、型別錯、不在選項內：json_schema 應該擋得住，出現就代表約束沒生效，整段拒收、不沿用舊值。 */
export class StateRejectedError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`秘密狀態格式錯誤，這段的狀態未套用：${problems.join('；')}`);
    this.problems = problems;
  }
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export function validateFormat(format: SecretFormat): void {
  const seen = new Set<string>();
  for (const f of format.fields) {
    if (!KEY_RE.test(f.key)) throw new SecretFormatError(`欄位 key 只能用英數與底線：${f.key}`);
    if (seen.has(f.key)) throw new SecretFormatError(`欄位 key 重複：${f.key}`);
    seen.add(f.key);
    if (f.type === 'number') {
      if (!(f.min <= f.initial && f.initial <= f.max)) throw new SecretFormatError(`${f.key} 的初始值不在 [min, max]`);
      if (!(f.maxDelta > 0)) throw new SecretFormatError(`${f.key} 的每段變化量上限要 > 0`);
    }
    if (f.type === 'enum' && !f.options.includes(f.initial)) throw new SecretFormatError(`${f.key} 的初始值不在選項內`);
    if (f.type === 'tags' && f.initial.length > f.maxItems) throw new SecretFormatError(`${f.key} 的初始 tag 超過上限`);
    if (f.type === 'zones') {
      if (!(f.levelMin <= f.levelMax)) throw new SecretFormatError(`${f.key} 的 Lv. 下限要 ≤ 上限`);
      if (!(f.maxDelta > 0)) throw new SecretFormatError(`${f.key} 的每段變化量上限要 > 0`);
      if (f.initial.some((z) => z.level < f.levelMin || z.level > f.levelMax)) throw new SecretFormatError(`${f.key} 的初始 Lv. 不在範圍內`);
    }
    if ((f.type === 'zones' || f.type === 'kv') && new Set(f.initial.map((x) => x.name)).size !== f.initial.length) throw new SecretFormatError(`${f.key} 的初始項目名稱重複`);
    if ((f.type === 'zones' || f.type === 'kv') && f.names?.length) {
      if (f.names.some((n) => !n.trim())) throw new SecretFormatError(`${f.key} 的允許名稱有空白項目`);
      if (new Set(f.names).size !== f.names.length) throw new SecretFormatError(`${f.key} 的允許名稱重複`);
      const out = f.initial.find((x) => !f.names!.includes(x.name));
      if (out) throw new SecretFormatError(`${f.key} 的初始項目「${out.name}」不在允許名稱裡`);
    }
  }
}

export function initialSnapshot(format: SecretFormat): Snapshot {
  const s: Snapshot = {};
  for (const f of format.fields) s[f.key] = structuredClone(f.initial);
  return s;
}

/** 單一角色快照的 JSON schema。 */
export function compileSnapshotSchema(format: SecretFormat): object {
  const properties: Record<string, object> = {};
  for (const f of format.fields) {
    if (f.type === 'number') properties[f.key] = { type: 'number', minimum: f.min, maximum: f.max, description: f.label };
    else if (f.type === 'text') properties[f.key] = { type: 'string', maxLength: f.maxLength, description: f.label };
    else if (f.type === 'enum') properties[f.key] = { enum: f.options, description: f.label };
    else if (f.type === 'tags') properties[f.key] = { type: 'array', items: { type: 'string', maxLength: f.maxLength }, maxItems: f.maxItems, uniqueItems: true, description: f.label };
    else if (f.type === 'zones')
      properties[f.key] = {
        type: 'array',
        description: `${f.label}（只列這段有變化或新出現的；沒列出的維持原樣）`,
        items: { type: 'object', properties: { name: f.names?.length ? { enum: f.names } : { type: 'string', maxLength: f.nameMaxLength }, level: { type: 'integer', minimum: f.levelMin, maximum: f.levelMax }, state: { type: 'string', maxLength: f.stateMaxLength } }, required: ['name', 'level', 'state'], additionalProperties: false },
      };
    else
      properties[f.key] = {
        type: 'array',
        description: `${f.label}（只列這段有變化或新增的；沒列出的維持原樣）`,
        items: { type: 'object', properties: { name: f.names?.length ? { enum: f.names } : { type: 'string', maxLength: f.nameMaxLength }, value: { type: 'string', maxLength: f.valueMaxLength } }, required: ['name', 'value'], additionalProperties: false },
      };
  }
  return { type: 'object', properties, required: format.fields.map((f) => f.key), additionalProperties: false };
}

/** 整段 state 的 JSON schema：{ <角色 id>: 快照 }。 */
export function compileSegmentStateSchema(format: SecretFormat, characterIds: string[]): object {
  const snap = compileSnapshotSchema(format);
  return {
    type: 'object',
    properties: Object.fromEntries(characterIds.map((id) => [id, snap])),
    required: characterIds,
    additionalProperties: false,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 把 LLM 回的快照套到前一份上：整份替換，逐欄依格式限幅並回報。
 * 缺欄位、型別錯、不在選項內 → 丟 StateRejectedError（不沿用舊值）。
 */
export function applySnapshot(format: SecretFormat, characterId: string, prev: Snapshot, incoming: unknown): { snapshot: Snapshot; clamps: ClampEvent[] } {
  const clamps: ClampEvent[] = [];
  const problems: string[] = [];
  const note = (key: string, kind: ClampKind, detail: string) => clamps.push({ characterId, key, kind, detail });
  const bad = (key: string, detail: string) => problems.push(`${characterId}.${key} ${detail}`);
  if (!isObj(incoming)) throw new StateRejectedError([`${characterId} 的快照不是物件：${JSON.stringify(incoming)}`]);
  const src = incoming;
  const known = new Set(format.fields.map((f) => f.key));
  for (const k of Object.keys(src)) if (!known.has(k)) note(k, 'unknown_field', '格式裡沒有這個欄位，已忽略');

  const out: Snapshot = {};
  for (const f of format.fields) {
    if (!Object.hasOwn(prev, f.key)) throw new Error(`前一段快照缺 ${f.key}：時間軸應該都從 initialSnapshot 開始`);
    const before = prev[f.key]!;
    if (!Object.hasOwn(src, f.key)) {
      bad(f.key, '缺漏');
      continue;
    }
    const v = src[f.key];
    if (f.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        bad(f.key, `不是數字：${JSON.stringify(v)}`);
        continue;
      }
      let x = v;
      const p = before as number;
      if (x - p > f.maxDelta || p - x > f.maxDelta) {
        const lim = x > p ? p + f.maxDelta : p - f.maxDelta;
        note(f.key, 'delta', `模型想從 ${p} 改成 ${x}，超過每段最多 ±${f.maxDelta}，已改成 ${lim}`);
        x = lim;
      }
      if (x < f.min || x > f.max) {
        const lim = Math.min(f.max, Math.max(f.min, x));
        note(f.key, 'range', `${x} 超出範圍 ${f.min}～${f.max}，已改成 ${lim}`);
        x = lim;
      }
      out[f.key] = x;
    } else if (f.type === 'text') {
      if (typeof v !== 'string') {
        bad(f.key, `不是文字：${JSON.stringify(v)}`);
        continue;
      }
      if (v.length > f.maxLength) note(f.key, 'too_long', `長度 ${v.length} 超過 ${f.maxLength}，已截斷`);
      out[f.key] = v.slice(0, f.maxLength);
    } else if (f.type === 'enum') {
      if (typeof v !== 'string' || !f.options.includes(v)) {
        bad(f.key, `不在選項內：${JSON.stringify(v)}`);
        continue;
      }
      out[f.key] = v;
    } else if (f.type === 'tags') {
      if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) {
        bad(f.key, `不是文字陣列：${JSON.stringify(v)}`);
        continue;
      }
      const uniq = [...new Set(v.map((t) => t.trim()).filter(Boolean))];
      const cut = uniq.map((t) => t.slice(0, f.maxLength));
      if (cut.some((t, i) => t !== uniq[i])) note(f.key, 'too_long', `有 tag 超過 ${f.maxLength} 字，已截斷`);
      if (cut.length > f.maxItems) note(f.key, 'too_many_tags', `${cut.length} 個超過上限 ${f.maxItems}，只留前 ${f.maxItems} 個`);
      out[f.key] = cut.slice(0, f.maxItems);
    } else if (f.type === 'zones') {
      if (!Array.isArray(v) || !v.every((z) => isObj(z) && typeof z.name === 'string' && typeof z.level === 'number' && Number.isFinite(z.level) && typeof z.state === 'string')) {
        bad(f.key, `不是 {name, level, state} 清單：${JSON.stringify(v)}`);
        continue;
      }
      const strayZone = f.names?.length ? (v as Zone[]).map((z) => z.name.trim()).find((n) => n && !f.names!.includes(n)) : undefined;
      if (strayZone !== undefined) {
        bad(f.key, `名稱只能用：${f.names!.join('、')}（收到「${strayZone}」）`);
        continue;
      }
      const list = structuredClone(before as Zone[]);
      for (const z of v as Zone[]) {
        const name = z.name.trim().slice(0, f.nameMaxLength);
        if (!name) continue;
        const i = list.findIndex((x) => x.name === name);
        const p = i >= 0 ? list[i]!.level : f.levelMin; // 新項目從下限起算
        let lv = Math.round(z.level);
        if (lv - p > f.maxDelta || p - lv > f.maxDelta) {
          const lim = lv > p ? p + f.maxDelta : p - f.maxDelta;
          note(f.key, 'delta', `「${name}」模型想從 Lv.${p} 改成 Lv.${lv}，超過每段最多 ±${f.maxDelta}，已改成 Lv.${lim}`);
          lv = lim;
        }
        lv = Math.min(f.levelMax, Math.max(f.levelMin, lv));
        if (z.state.length > f.stateMaxLength) note(f.key, 'too_long', `「${name}」的狀態超過 ${f.stateMaxLength} 字，已截斷`);
        const item = { name, level: lv, state: z.state.slice(0, f.stateMaxLength) };
        if (i >= 0) list[i] = item;
        else list.push(item);
      }
      out[f.key] = list;
    } else {
      if (!Array.isArray(v) || !v.every((x) => isObj(x) && typeof x.name === 'string' && typeof x.value === 'string')) {
        bad(f.key, `不是 {name, value} 清單：${JSON.stringify(v)}`);
        continue;
      }
      const strayKv = f.names?.length ? (v as KvItem[]).map((x) => x.name.trim()).find((n) => n && !f.names!.includes(n)) : undefined;
      if (strayKv !== undefined) {
        bad(f.key, `名稱只能用：${f.names!.join('、')}（收到「${strayKv}」）`);
        continue;
      }
      const list = structuredClone(before as KvItem[]);
      for (const x of v as KvItem[]) {
        const name = x.name.trim().slice(0, f.nameMaxLength);
        if (!name) continue;
        if (x.value.length > f.valueMaxLength) note(f.key, 'too_long', `「${name}」的值超過 ${f.valueMaxLength} 字，已截斷`);
        const item = { name, value: x.value.slice(0, f.valueMaxLength) };
        const i = list.findIndex((y) => y.name === name);
        if (i >= 0) list[i] = item;
        else list.push(item);
      }
      out[f.key] = list;
    }
  }
  if (problems.length) throw new StateRejectedError(problems);
  return { snapshot: out, clamps };
}

interface SegmentRecord {
  segmentId: string;
  raw: Record<string, unknown>; // LLM 原始回傳（依角色 id），重算用
  manual: Record<string, Snapshot>; // 使用者在面板手動改過的快照：重算時直接採用，不套每段變化上限
  snapshots: Record<string, Snapshot>;
  clamps: ClampEvent[];
}

/**
 * 面板「編輯數值」：使用者手動改的快照。範圍、選項、長度、tag 數量一律檢查（超出就拒收），
 * 但不套每段變化上限（那是限制 LLM 的，不限制使用者）。
 */
export function validateManual(format: SecretFormat, characterId: string, snapshot: Snapshot): Snapshot {
  const problems: string[] = [];
  const bad = (k: string, d: string) => problems.push(`${characterId}.${k} ${d}`);
  const known = new Set(format.fields.map((f) => f.key));
  for (const k of Object.keys(snapshot)) if (!known.has(k)) bad(k, '格式裡沒有這個欄位');
  const out: Snapshot = {};
  for (const f of format.fields) {
    if (!Object.hasOwn(snapshot, f.key)) {
      bad(f.key, '缺漏');
      continue;
    }
    const v = snapshot[f.key];
    if (f.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) bad(f.key, `不是數字：${JSON.stringify(v)}`);
      else if (v < f.min || v > f.max) bad(f.key, `${v} 超出 [${f.min}, ${f.max}]`);
      else out[f.key] = v;
    } else if (f.type === 'enum') {
      if (typeof v !== 'string' || !f.options.includes(v)) bad(f.key, `不在選項內：${JSON.stringify(v)}`);
      else out[f.key] = v;
    } else if (f.type === 'text') {
      if (typeof v !== 'string') bad(f.key, '不是文字');
      else if (v.length > f.maxLength) bad(f.key, `超過 ${f.maxLength} 字`);
      else out[f.key] = v;
    } else if (f.type === 'tags') {
      if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) bad(f.key, '不是文字陣列');
      else {
        const tags = [...new Set(v.map((t) => t.trim()).filter(Boolean))];
        if (tags.length > f.maxItems) bad(f.key, `${tags.length} 個超過上限 ${f.maxItems}`);
        else if (tags.some((t) => t.length > f.maxLength)) bad(f.key, `有標籤超過 ${f.maxLength} 字`);
        else out[f.key] = tags;
      }
    } else if (f.type === 'zones') {
      const list = Array.isArray(v) ? (v as Zone[]) : null;
      if (!list || !list.every((z) => isObj(z) && typeof z.name === 'string' && typeof z.level === 'number' && typeof z.state === 'string')) bad(f.key, '不是部位清單');
      else {
        const items = list.map((z) => ({ name: z.name.trim(), level: z.level, state: z.state }));
        const names = items.map((z) => z.name);
        if (names.some((n) => !n)) bad(f.key, '有項目沒有名稱');
        else if (new Set(names).size !== names.length) bad(f.key, '項目名稱重複');
        else if (f.names?.length && items.some((z) => !f.names!.includes(z.name))) bad(f.key, `名稱只能用：${f.names.join('、')}（收到「${items.find((z) => !f.names!.includes(z.name))!.name}」）`);
        else if (items.some((z) => !Number.isInteger(z.level) || z.level < f.levelMin || z.level > f.levelMax)) bad(f.key, `Lv. 要是 ${f.levelMin}～${f.levelMax} 的整數`);
        else if (items.some((z) => z.name.length > f.nameMaxLength || z.state.length > f.stateMaxLength)) bad(f.key, `名稱最多 ${f.nameMaxLength} 字、狀態最多 ${f.stateMaxLength} 字`);
        else out[f.key] = items;
      }
    } else {
      const list = Array.isArray(v) ? (v as KvItem[]) : null;
      if (!list || !list.every((x) => isObj(x) && typeof x.name === 'string' && typeof x.value === 'string')) bad(f.key, '不是數值表');
      else {
        const items = list.map((x) => ({ name: x.name.trim(), value: x.value }));
        const names = items.map((x) => x.name);
        if (names.some((n) => !n)) bad(f.key, '有項目沒有名稱');
        else if (new Set(names).size !== names.length) bad(f.key, '項目名稱重複');
        else if (f.names?.length && items.some((x) => !f.names!.includes(x.name))) bad(f.key, `名稱只能用：${f.names.join('、')}（收到「${items.find((x) => !f.names!.includes(x.name))!.name}」）`);
        else if (items.some((x) => x.name.length > f.nameMaxLength || x.value.length > f.valueMaxLength)) bad(f.key, `名稱最多 ${f.nameMaxLength} 字、值最多 ${f.valueMaxLength} 字`);
        else out[f.key] = items;
      }
    }
  }
  if (problems.length) throw new StateRejectedError(problems);
  return out;
}

/** 每段一份快照的時間軸。重生、刪除時從前一段重算，所以狀態不會跨重生累積。 */
export class StateTimeline {
  private segs: SegmentRecord[] = [];
  private readonly format: SecretFormat;
  private readonly characterIds: string[];

  constructor(format: SecretFormat, characterIds: string[]) {
    validateFormat(format);
    this.format = format;
    this.characterIds = characterIds;
  }

  private baseOverride: Record<string, Snapshot> = {};

  private base(): Record<string, Snapshot> {
    return Object.fromEntries(this.characterIds.map((id) => [id, this.baseOverride[id] ?? initialSnapshot(this.format)]));
  }

  private compute(prev: Record<string, Snapshot>, raw: Record<string, unknown>, manual: Record<string, Snapshot> = {}) {
    const snapshots: Record<string, Snapshot> = {};
    const clamps: ClampEvent[] = [];
    for (const id of this.characterIds) {
      const before = prev[id]!;
      if (manual[id]) {
        snapshots[id] = manual[id];
        continue;
      }
      if (raw[id] === CARRY) {
        snapshots[id] = before;
        continue;
      }
      if (!Object.hasOwn(raw, id)) throw new StateRejectedError([`缺少角色 ${id} 的快照`]);
      const r = applySnapshot(this.format, id, before, raw[id]);
      snapshots[id] = r.snapshot;
      clamps.push(...r.clamps);
    }
    for (const k of Object.keys(raw)) {
      if (!this.characterIds.includes(k)) clamps.push({ characterId: k, key: '*', kind: 'unknown_field', detail: '不是這個場景的角色 id，已忽略' });
    }
    return { snapshots, clamps };
  }

  private recomputeFrom(index: number): void {
    for (let i = index; i < this.segs.length; i++) {
      const prev = i === 0 ? this.base() : this.segs[i - 1]!.snapshots;
      const s = this.segs[i]!;
      Object.assign(s, this.compute(prev, s.raw, s.manual));
    }
  }

  private indexOf(segmentId: string): number {
    const i = this.segs.findIndex((s) => s.segmentId === segmentId);
    if (i < 0) throw new Error(`找不到段落 ${segmentId}`);
    return i;
  }

  /** 目前（最後一段之後）的快照，給下一段 prompt 用。 */
  current(): Record<string, Snapshot> {
    return this.segs.length ? this.segs[this.segs.length - 1]!.snapshots : this.base();
  }

  /** 某段開始前的快照（重生那段時給 prompt 用）。 */
  before(segmentId: string): Record<string, Snapshot> {
    const i = this.indexOf(segmentId);
    return i === 0 ? this.base() : this.segs[i - 1]!.snapshots;
  }

  get(segmentId: string): { snapshots: Record<string, Snapshot>; clamps: ClampEvent[] } {
    const s = this.segs[this.indexOf(segmentId)]!;
    return { snapshots: s.snapshots, clamps: s.clamps };
  }

  /** 接上新的一段。格式錯誤時丟 StateRejectedError，時間軸不變。 */
  append(segmentId: string, rawState: unknown): { snapshots: Record<string, Snapshot>; clamps: ClampEvent[] } {
    if (this.segs.some((s) => s.segmentId === segmentId)) throw new Error(`段落 ${segmentId} 已存在`);
    if (!isObj(rawState)) throw new StateRejectedError([`state 不是物件：${JSON.stringify(rawState)}`]);
    const rec: SegmentRecord = { segmentId, raw: rawState, manual: {}, ...this.compute(this.current(), rawState) };
    this.segs.push(rec);
    return { snapshots: rec.snapshots, clamps: rec.clamps };
  }

  /** 重生某段：換掉它的原始回傳，從那段開始重算。 */
  /** 重生某段：換掉它的原始回傳，從那段開始重算。格式錯誤時丟錯，時間軸不變。 */
  regenerate(segmentId: string, rawState: unknown): { snapshots: Record<string, Snapshot>; clamps: ClampEvent[] } {
    const i = this.indexOf(segmentId);
    if (!isObj(rawState)) throw new StateRejectedError([`state 不是物件：${JSON.stringify(rawState)}`]);
    const prev = i === 0 ? this.base() : this.segs[i - 1]!.snapshots;
    const computed = this.compute(prev, rawState); // 先算，失敗就不動時間軸
    Object.assign(this.segs[i]!, { raw: rawState, manual: {}, ...computed });
    this.recomputeFrom(i + 1);
    return this.get(segmentId);
  }

  remove(segmentId: string): void {
    const i = this.indexOf(segmentId);
    this.segs.splice(i, 1);
    this.recomputeFrom(i);
  }

  /** 面板編輯：改目前（最後一段之後）的快照；還沒有段落時改初始值。後面段落會從這份重算。 */
  editCurrent(characterId: string, snapshot: Snapshot): Snapshot {
    if (!this.characterIds.includes(characterId)) throw new Error(`不是這個場景的角色：${characterId}`);
    const snap = validateManual(this.format, characterId, snapshot);
    if (!this.segs.length) {
      this.baseOverride[characterId] = snap;
      return snap;
    }
    const last = this.segs[this.segs.length - 1]!;
    last.manual = { ...last.manual, [characterId]: snap };
    this.recomputeFrom(this.segs.length - 1);
    return snap;
  }

  /** 面板的「重置」：回到秘密格式的初始值。 */
  reset(characterId: string): Snapshot {
    return this.editCurrent(characterId, initialSnapshot(this.format));
  }

  get length(): number {
    return this.segs.length;
  }

  has(segmentId: string): boolean {
    return this.segs.some((s) => s.segmentId === segmentId);
  }

  /** 存檔用：只存原始回傳與手動修改，快照載入時重算（所以存檔不會帶進過期的限幅結果） */
  toJSON(): TimelineData {
    return { base: this.baseOverride, segs: this.segs.map(({ segmentId, raw, manual }) => ({ segmentId, raw, manual })) };
  }

  /** 從存檔還原；格式不合（欄位表改過）會丟 StateRejectedError，由呼叫端讓使用者決定 */
  static restore(format: SecretFormat, characterIds: string[], d: TimelineData): StateTimeline {
    const t = new StateTimeline(format, characterIds);
    for (const [id, snap] of Object.entries(d.base)) t.setBase(id, snap);
    t.segs = d.segs.map((x) => ({ ...x, snapshots: {}, clamps: [] }));
    t.recomputeFrom(0);
    return t;
  }

  /** 起始快照（角色身上存的最新狀態）；同樣檢查範圍與選項 */
  setBase(characterId: string, snapshot: Snapshot): void {
    if (!this.characterIds.includes(characterId)) throw new Error(`不是這個場景的角色：${characterId}`);
    this.baseOverride[characterId] = validateManual(this.format, characterId, snapshot);
    this.recomputeFrom(0);
  }
}

export interface TimelineData {
  base: Record<string, Snapshot>;
  segs: { segmentId: string; raw: Record<string, unknown>; manual: Record<string, Snapshot> }[];
}
