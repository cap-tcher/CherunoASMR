import { describe, expect, it } from 'vitest';
import { buildMessages } from './prompt.ts';
import { initialSnapshot, type SecretFormat } from './state.ts';
import { DEFAULT_TEMPLATES, TEMPLATE_META, TemplateError, checkTemplates, fill, templateVars } from './templates.ts';

describe('fill', () => {
  it('代入變數；某行的變數全空時整行省略', () => {
    expect(fill('名前：{{name}}\n背景：{{bio}}\n固定行', { name: '澪', bio: '' })).toBe('名前：澪\n固定行');
  });
  it('一行有多個變數，只要有一個非空就保留', () => {
    expect(fill('{{a}}（{{b}}）', { a: '', b: 'x' })).toBe('（x）');
  });
  it('用了不存在的變數 → 丟錯，不默默變空白', () => {
    expect(() => fill('{{nope}}', {})).toThrow(TemplateError);
  });
  it('templateVars 列出用到的變數', () => {
    expect(templateVars('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('每一欄只用該欄說明列出的變數；每一欄都有說明', () => {
    expect(checkTemplates(DEFAULT_TEMPLATES)).toEqual([]);
    for (const g of Object.keys(DEFAULT_TEMPLATES) as (keyof typeof DEFAULT_TEMPLATES)[]) {
      expect(Object.keys(TEMPLATE_META[g].items).sort()).toEqual(Object.keys(DEFAULT_TEMPLATES[g]).sort());
    }
  });
  it('checkTemplates 抓得到改壞的欄位', () => {
    const bad = { ...DEFAULT_TEMPLATES, segment: { ...DEFAULT_TEMPLATES.segment, modeInfinite: '{{userInput}}' } };
    expect(checkTemplates(bad)).toEqual(['每段生成 › 本段指令：無限：不能用 {{userInput}}']);
  });
});

describe('改模板會改到送出的 prompt', () => {
  const format: SecretFormat = { fields: [{ key: 'affection', label: '好感度', type: 'number', min: 0, max: 100, maxDelta: 5, initial: 10 }] };
  const base = {
    systemPrompt: 'S',
    opening: '',
    sleepInstruction: '',
    statDefs: '',
    character: { id: 'mio', name: '澪', reading: 'みお', subName: '澪', ageSex: '20 歲', relation: '', callName: '', appearance: '', bio: '', personality: '', behavior: '', catchphrase: '', secret: '', voiceDesc: '' },
    protagonist: { name: 'テツ', reading: '', subName: '', gender: '', appearance: '', bio: '' },
    scene: null,
    glossary: null,
    world: null,
    memories: null,
    history: null,
    tone: '',
    secretFormat: format,
    state: { mio: initialSnapshot(format) },
    mode: 'infinite' as const,
    userInput: '',
    intimacy: true,
    intimacySystem: "",
    intimacyScript: "",
    secretTemplate: "",
    clock: null,
    context: [],
    contextLimit: 70,
    isFirstSegment: false,
    withEn: false,
    lineRange: { min: 3, max: 8 },
    seIds: ['rain'],
  };
  it('段落標題、本段指令、角色卡都照模板', () => {
    const t = { ...DEFAULT_TEMPLATES.segment, secCharacter: '## キャラクター', modeInfinite: '続きを書いて。', card: 'Name: {{name}} / Age: {{ageSex}}' };
    const [sys, user] = buildMessages(base, t);
    expect(sys!.content).toContain('## キャラクター\nName: 澪 / Age: 20 歲');
    expect(user!.content).toBe('続きを書いて。');
  });
});
