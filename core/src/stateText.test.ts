import { describe, expect, it } from 'vitest';
import type { PanelBlock } from './rules.ts';
import type { SecretFormat } from './state.ts';
import { formatStateText, tierLabel } from './stateText.ts';

const format: SecretFormat = {
  fields: [
    { key: 'heart', label: '心跳', type: 'number', min: 40, max: 200, maxDelta: 30, initial: 75, unit: 'bpm' },
    { key: 'breath', label: '呼吸', type: 'enum', options: ['平穩', '急促'], initial: '平穩' },
    { key: 'kiss', label: '親吻次數', type: 'number', min: 0, max: 9999, maxDelta: 5, initial: 0 },
    { key: 'hand', label: '牽手次數', type: 'number', min: 0, max: 9999, maxDelta: 5, initial: 0 },
    { key: 'blush', label: '臉紅狀態', type: 'text', maxLength: 10, initial: '' },
    { key: 'intimacy', label: '親密度', type: 'number', min: 0, max: 99999, maxDelta: 50, initial: 20, tiers: [{ min: 100, label: '熟人' }, { min: 0, label: '初識' }, { min: 1000, label: '戀人以上' }, { min: 500, label: '戀人' }] },
    { key: 'zones', label: '性感帶地圖', type: 'zones', levelMin: 0, levelMax: 100, maxDelta: 10, nameMaxLength: 20, stateMaxLength: 40, levelLabel: '開發度', initial: [] },
  ],
};
const layout: PanelBlock[] = [
  { type: 'rows', title: '生理數值', fields: ['heart', 'breath'] },
  { type: 'rows', title: '親密記數', fields: ['kiss', 'hand', 'blush'] },
  { type: 'bars', title: '關係', fields: ['intimacy'] },
  { type: 'zones', title: '性感帶地圖', fields: ['zones'] },
];

describe('tierLabel', () => {
  const f = format.fields[5] as Extract<SecretFormat['fields'][number], { type: 'number' }>;
  it('取下限 ≤ 值的最後一個（tiers 不必照順序寫）', () => {
    expect([20, 99, 158, 500, 999, 1000, 5000].map((v) => tierLabel(f, v))).toEqual(['初識', '初識', '熟人', '戀人', '戀人', '戀人以上', '戀人以上']);
  });
});

describe('formatStateText', () => {
  const now = { heart: 80, breath: '急促', kiss: 3, hand: 5, blush: '蘋果紅', intimacy: 158, zones: [{ name: '耳朵', level: 12, state: '一碰就縮' }, { name: '頸側', level: 3, state: '' }] };
  const prev = { heart: 75, breath: '平穩', kiss: 2, hand: 5, blush: '蘋果紅', intimacy: 150, zones: [{ name: '耳朵', level: 9, state: '有點敏感' }] };
  it('照使用者的例子：分段、值(±變化) 單位、舊 → 新、區間標籤、部位行', () => {
    expect(formatStateText(format, layout, now, prev).split('\n')).toEqual([
      '# 生理數值',
      '心跳: 80(+5) bpm',
      '呼吸: 平穩 → 急促',
      '# 親密記數',
      '親吻次數: 3(+1)',
      '牽手次數: 5(+0)',
      '臉紅狀態: 蘋果紅',
      '# 關係',
      '親密度: 158(+8) 熟人',
      '# 性感帶地圖',
      '* 耳朵: 開發度 12 (Ref: +3) - 一碰就縮',
      '* 頸側: 開發度 3 (Ref: +3)',
    ]);
  });
  it('第一段（沒有再前一段）：變化 +0、不寫舊 → 新；部位沒有紀錄寫（無紀錄）', () => {
    const t = formatStateText(format, layout, { ...now, zones: [] }, null);
    expect(t).toContain('心跳: 80(+0) bpm');
    expect(t).toContain('呼吸: 急促');
    expect(t).toContain('# 性感帶地圖\n（無紀錄）');
  });
});
