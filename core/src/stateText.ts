// 秘密狀態寫進提示詞的可讀格式（[[PLAN_角色與狀態修正]] C-06～C-08；照 ADV3.0 L1851–L1885 的親密狀態注入）：
// 依面板版面分段（# 標題），數值「值(±變化) 單位 區間標籤」、選項與文字有變化時「舊 → 新」、
// 部位清單「* 部位: 開發度 N (Ref: ±M) - 狀態」、沒有紀錄寫（無紀錄）。變化量跟上一段之前的狀態比。
import { resolveLayout, type PanelBlock } from './rules.ts';
import type { KvItem, SecretFormat, Snapshot, StateField, Zone } from './state.ts';

/** 數值落在哪個區間標籤：tiers 依下限由小到大，取「下限 ≤ 值」的最後一個；比第一個下限還小就沒有標籤 */
export function tierLabel(f: Extract<StateField, { type: 'number' }>, v: number): string {
  let label = '';
  for (const t of [...(f.tiers ?? [])].sort((a, b) => a.min - b.min)) if (v >= t.min) label = t.label;
  return label;
}

const signed = (d: number) => (d >= 0 ? `+${d}` : String(d));
const round = (n: number) => Math.round(n * 100) / 100;

function fieldLines(f: StateField, now: Snapshot, prev: Snapshot | null): string[] {
  const v = now[f.key];
  const p = prev ? prev[f.key] : undefined;
  switch (f.type) {
    case 'number': {
      const n = Number(v);
      const d = round(n - (p === undefined ? n : Number(p)));
      const tier = tierLabel(f, n);
      return [`${f.label}: ${round(n)}(${signed(d)})${f.unit ? ` ${f.unit}` : ''}${tier ? ` ${tier}` : ''}`];
    }
    case 'enum':
    case 'text': {
      const s = String(v ?? '');
      const was = p === undefined ? s : String(p);
      return [`${f.label}: ${was !== s && was ? `${was} → ${s}` : s || '（空）'}`];
    }
    case 'tags': {
      const list = (v as string[] | undefined) ?? [];
      return [`${f.label}: ${list.length ? list.map((t) => `#${t}`).join(' ') : '（無）'}`];
    }
    case 'zones': {
      const list = (v as Zone[] | undefined) ?? [];
      if (!list.length) return ['（無紀錄）'];
      const before = new Map(((p as Zone[] | undefined) ?? []).map((z) => [z.name, z.level]));
      const word = f.levelLabel || 'Lv.';
      return list.map((z) => {
        const d = z.level - (before.get(z.name) ?? (prev ? f.levelMin : z.level));
        return `* ${z.name}: ${word} ${z.level} (Ref: ${signed(d)})${z.state ? ` - ${z.state}` : ''}`;
      });
    }
    case 'kv': {
      const list = (v as KvItem[] | undefined) ?? [];
      return list.length ? list.map((x) => `* ${x.name}: ${x.value}`) : ['（無紀錄）'];
    }
  }
}

/** 一個角色的目前狀態（分段）。prev＝上一段之前的快照；沒有（第一段）時變化一律 +0、不寫「舊 → 新」 */
export function formatStateText(format: SecretFormat, layout: PanelBlock[], now: Snapshot, prev: Snapshot | null): string {
  const blocks = resolveLayout(layout, format.fields);
  const used = new Set<string>();
  const out: string[] = [];
  for (const b of blocks) {
    const lines = b.fields.filter((f) => !used.has(f.key)).flatMap((f) => (used.add(f.key), b.fields.length > 1 && (f.type === 'zones' || f.type === 'kv') ? [`${f.label}:`, ...fieldLines(f, now, prev)] : fieldLines(f, now, prev)));
    if (lines.length) out.push(`# ${b.title}`, ...lines);
  }
  return out.join('\n');
}
