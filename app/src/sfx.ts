// 音效：WebAudio 程序合成（之後換成錄音素材時只改這支），依 side 左右定位，由 session 在台詞開始播放的同時觸發。
import type { Side } from '@cheruno/core';

const PAN: Record<Side, number> = { left: -0.85, center: 0, right: 0.85 };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function graph() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return { c: ctx, out: master! };
}

function noise(c: AudioContext, seconds: number, color: 'white' | 'brown' | 'pink'): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'white') d[i] = w;
    else if (color === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else {
      b0 = 0.997 * b0 + w * 0.029591;
      b1 = 0.985 * b1 + w * 0.032534;
      b2 = 0.95 * b2 + w * 0.048056;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 1.6;
    }
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

/** gain 包絡：points 是 [秒, 音量]，從 t0 起算 */
function env(c: AudioContext, t0: number, points: [number, number][]): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  for (const [t, v] of points) g.gain.linearRampToValueAtTime(v, t0 + t);
  return g;
}

function filter(c: AudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function chain(...nodes: AudioNode[]) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
}

type Synth = (c: AudioContext, dest: AudioNode, t0: number) => void;

const SYNTH: Record<string, Synth> = {
  // 耳ふー：帶通白噪音，起音慢、尾巴長
  breath_blow(c, dest, t0) {
    const n = noise(c, 1.3, 'white');
    const f = filter(c, 'bandpass', 900, 0.8);
    f.frequency.setValueAtTime(1300, t0);
    f.frequency.linearRampToValueAtTime(700, t0 + 1.1);
    chain(n, f, env(c, t0, [[0.18, 0.5], [0.7, 0.35], [1.2, 0]]), dest);
    n.start(t0);
  },
  // 耳朵輕敲：三下短促的悶響
  ear_tap(c, dest, t0) {
    for (const dt of [0, 0.22, 0.44]) {
      const n = noise(c, 0.06, 'white');
      chain(n, filter(c, 'lowpass', 1800), env(c, t0 + dt, [[0.003, 0.9], [0.05, 0]]), dest);
      n.start(t0 + dt);
      const o = c.createOscillator();
      o.frequency.value = 170;
      chain(o, env(c, t0 + dt, [[0.004, 0.5], [0.06, 0]]), dest);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.08);
    }
  },
  // 雨聲：粉紅噪音，淡入淡出
  rain(c, dest, t0) {
    const n = noise(c, 6, 'pink');
    chain(n, filter(c, 'highpass', 400), filter(c, 'lowpass', 5000), env(c, t0, [[0.9, 0.35], [5, 0.35], [6, 0]]), dest);
    n.start(t0);
  },
  // 被子摩擦：褐噪音，幾段不規則起伏
  blanket(c, dest, t0) {
    const n = noise(c, 1.5, 'brown');
    const g = c.createGain();
    const curve = new Float32Array(64).map((_, i) => Math.max(0, Math.sin((i / 63) * Math.PI)) * (0.45 + 0.55 * Math.abs(Math.sin(i * 0.7))));
    g.gain.setValueCurveAtTime(curve, t0, 1.4);
    chain(n, filter(c, 'bandpass', 650, 0.5), g, dest);
    n.start(t0);
  },
  // 杯子放到桌上：一聲叩＋短的瓷器共鳴
  cup_on_table(c, dest, t0) {
    const n = noise(c, 0.03, 'white');
    chain(n, filter(c, 'highpass', 2000), env(c, t0, [[0.002, 0.6], [0.02, 0]]), dest);
    n.start(t0);
    for (const [hz, v] of [[2300, 0.12], [3450, 0.07], [120, 0.4]] as const) {
      const o = c.createOscillator();
      o.frequency.value = hz;
      chain(o, env(c, t0, [[0.004, v], [hz < 200 ? 0.07 : 0.4, 0]]), dest);
      o.start(t0);
      o.stop(t0 + 0.45);
    }
  },
  // 翻頁：頻率往上掃的噪音
  page_turn(c, dest, t0) {
    const n = noise(c, 0.6, 'white');
    const f = filter(c, 'bandpass', 1500, 1.2);
    f.frequency.setValueAtTime(1500, t0);
    f.frequency.exponentialRampToValueAtTime(5000, t0 + 0.45);
    chain(n, f, env(c, t0, [[0.08, 0.45], [0.3, 0.3], [0.55, 0]]), dest);
    n.start(t0);
  },
};

export function hasSfx(id: string) {
  return id in SYNTH;
}

export function playSe(id: string, side: Side) {
  const synth = SYNTH[id];
  if (!synth) throw new Error(`沒有這個音效：${id}`);
  const { c, out } = graph();
  void c.resume();
  const pan = c.createStereoPanner();
  pan.pan.value = PAN[side];
  pan.connect(out);
  synth(c, pan, c.currentTime + 0.01);
  if (import.meta.env.DEV) ((window as unknown as { __sfxLog?: unknown[] }).__sfxLog ??= []).push({ id, side, t: performance.now() });
}

export function pauseSfx() {
  void ctx?.suspend();
}
export function resumeSfx() {
  void ctx?.resume();
}
export function setSfxVolume(v: number) {
  if (master) master.gain.value = v;
}

/** 各音效的長度（毫秒）：照上面合成的實際長度，給台本兩軌的時間軸用（[[SCR-04_台本兩軌]]） */
export const SE_DUR_MS: Record<string, number> = { breath_blow: 1200, ear_tap: 500, rain: 6000, blanket: 1400, cup_on_table: 450, page_turn: 550 };

// 背景音：循環播放、聽者自己開關，不進時間軸（使用者 2026-11-20）。用獨立的 AudioContext，台本暫停不影響
export const BGM_IDS = ['rain'] as const;
export type BgmId = (typeof BGM_IDS)[number];
const BGM_SYNTH: Record<BgmId, (c: AudioContext, dest: AudioNode) => AudioScheduledSourceNode> = {
  // 雨聲：8 秒粉紅噪音循環（噪音沒有週期，循環接縫聽不出來）
  rain(c, dest) {
    const n = noise(c, 8, 'pink');
    n.loop = true;
    chain(n, filter(c, 'highpass', 400), filter(c, 'lowpass', 5000), dest);
    return n;
  },
};
let bgmCtx: AudioContext | null = null;
const bgmOn = new Map<BgmId, { src: AudioScheduledSourceNode; gain: GainNode }>();
const bgmListeners = new Set<() => void>();
let bgmSnapshot: readonly BgmId[] = [];
const BGM_LEVEL = 0.35;
const FADE_S = 1;

function bgmChanged() {
  bgmSnapshot = [...bgmOn.keys()];
  bgmListeners.forEach((f) => f());
}
export function subscribeBgm(f: () => void) {
  bgmListeners.add(f);
  return () => bgmListeners.delete(f);
}
export const bgmPlaying = () => bgmSnapshot;

export function startBgm(id: BgmId) {
  if (bgmOn.has(id)) return;
  bgmCtx ??= new AudioContext();
  const c = bgmCtx;
  void c.resume();
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(BGM_LEVEL, c.currentTime + FADE_S);
  gain.connect(c.destination);
  const src = BGM_SYNTH[id](c, gain);
  src.start();
  bgmOn.set(id, { src, gain });
  bgmChanged();
}
export function stopBgm(id: BgmId) {
  const b = bgmOn.get(id);
  if (!b || !bgmCtx) return;
  const t = bgmCtx.currentTime;
  b.gain.gain.cancelScheduledValues(t);
  b.gain.gain.setValueAtTime(b.gain.gain.value, t);
  b.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
  b.src.stop(t + FADE_S);
  bgmOn.delete(id);
  bgmChanged();
}
