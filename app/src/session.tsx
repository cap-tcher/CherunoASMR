// 聆聽 session：生成、TTS 佇列、播放、狀態時間軸。放在最上層（App），換頁時聲音不停（V4：底部播放列跨頁常駐）。
import { appLog } from './appLog.ts';
import {
  SE_IDS,
  StateRejectedError,
  StateTimeline,
  LlmIdleError,
  generateSegment,
  organizeGlossary,
  pickChapters,
  scanText,
  type ChatMessage,
  type ContextTurn,
  type ClampEvent,
  type LineEvent,
  type SeEvent,
  type Snapshot,
  type TimelineData,
  buildRagQuery,
  fitReferences,
  type RagReference,
  controlsKey,
  zonosControls,
  zonosSpans,
  splitControls,
  SPAN_RATE,
} from '@cheruno/core';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { endpointOf, type AppData, type Character } from './store.ts';
import { fetchAsset, putVoice, voiceKey, type VoiceParams } from './library.ts';
import { traced } from './requestLog.ts';
import { pauseSfx, playSe, resumeSfx, setSfxVolume } from './sfx.ts';
import { synthesize } from './tts.ts';
import { isLocalLms } from './services.ts';

export type Status = 'queued' | 'synth' | 'ready' | 'playing' | 'done' | 'error';
export interface LineItem {
  kind: 'line';
  key: string;
  ev: LineEvent;
  status: Status;
  at: number; // session 開始後幾毫秒收到
  url?: string;
  /** 語音庫的 key（存檔裡只存這個；重新整理後從語音庫取，不重新合成） */
  voiceKey?: string;
  error?: string;
  se: SeEvent[]; // 和這句同時開始播的音效（LLM 寫在這句的 se[]）
}
export interface AiMsg {
  kind: 'ai';
  id: string;
  items: LineItem[];
  actions: string[];
  deleted: boolean;
  editing: boolean;
  time?: string; // 故事時鐘：這段結束時的時刻
  userTurn: string; // 這段實際送出的 user 內容（之後當上下文裡聽者那一則）；生成完成前是空字串
}
export interface UserMsg {
  kind: 'user';
  id: string;
  text: string;
  at: number;
}
export type Msg = AiMsg | UserMsg;
export interface PanelState {
  n: number;
  snap: Snapshot;
  prev: Snapshot | null;
  clamps: ClampEvent[];
}
export interface MemoryCandidate {
  segId: string;
  text: string;
}
export interface SessionInfo {
  segments: number;
  first: number | null;
  last: number | null;
}

/** 上一段實際送給 LLM 的內容與模型原始輸出（系統核心 › AI 流程） */
export interface SegmentTrace {
  segId: string;
  at: string; // ISO 時間
  model: string;
  baseUrl: string;
  intimacy: boolean;
  messages: ChatMessage[];
  schema: object;
  raw: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
  ms?: number; // 整段生成花的時間
  firstEventMs?: number | null; // 第一句出來的時間
  stateMs?: number | null; // 狀態就緒的時間
  /** 狀態另外問一次時的第二次請求 */
  state?: { messages: ChatMessage[]; schema: object; raw: string };
}

export interface Session {
  character: Character;
  trace: SegmentTrace | null;
  msgs: Msg[];
  generating: boolean;
  error: string;
  paused: boolean;
  playing: LineItem | undefined;
  buffered: number;
  elapsedMs: number;
  sleepLeftMs: number;
  faded: boolean;
  panel: PanelState;
  memory: MemoryCandidate[];
  latest: AiMsg | undefined;
  /** 故事時鐘的現在時刻；關閉時 null */
  clock: string | null;
  segNumber: (id: string) => number;
  send: (text: string) => void;
  retry: () => void;
  /** 參考範例（RAG）檢索失敗、停在錯誤列：可以重試，或這段不帶參考範例繼續（每次由使用者決定，[[TASKS_RAG]] Q-02） */
  ragFailed: boolean;
  continueWithoutRag: () => void;
  /** 停掉正在生成的這段；reason 會顯示在錯誤列（沒給就是「已停止生成」） */
  stop: (reason?: string) => void;
  togglePause: () => void;
  /** 每句左邊的播放鍵：播放／暫停這一句；錯誤時重新合成 */
  playLine: (key: string) => void;
  solo: string | null;
  /** 正在播這句的 audio 元素（循序或單獨播）；沒在播就是 null。卡片用來畫播放進度 */
  audioOf: (key: string) => HTMLAudioElement | null;
  replay: (id: string) => void;
  regenerate: (id: string) => void;
  setEditing: (id: string, on: boolean) => void;
  saveEdit: (id: string, lines: { key: string; ja: string; zh: string }[]) => void;
  remove: (id: string) => void;
  /** 改自己說的話（ADV3.0 F-72）：刪掉這則之後的所有段落（狀態回到那時），用新文字重新生成 */
  editUser: (userMsgId: string, text: string) => void;
  /** 整理進名詞圖鑑（ADV3.0 F-73）：這段的台詞交給 LLM 建立或更新條目 */
  glossarize: (segId: string) => Promise<void>;
  glossaryBusy: string | null;
  /** 改那則會刪掉幾段 */
  segmentsAfter: (userMsgId: string) => number;
  editState: (snap: Snapshot) => string | null;
  resetState: () => void;
  acceptMemory: (c: MemoryCandidate) => void;
  dismissMemory: (c: MemoryCandidate) => void;
  info: () => SessionInfo;
}

const Ctx = createContext<Session | null>(null);

// 台本與狀態時間軸存進存檔的 session（ADV3.0 F-80：對話自動存檔）。換角色或欄位表改過就不還原（那是新的一次對話）。
export interface SavedSession {
  charId: string;
  format: string;
  msgs: Msg[];
  timeline: TimelineData;
  segCounter: number;
}

interface Boot {
  timeline: StateTimeline;
  msgs: Msg[];
  seg: number;
  restored: boolean;
  err: string; // 有值＝不能生成，等使用者處理（重新開始或重置狀態）
}
function boot(format: AppData['secretFormat'], ch: Character, sv: SavedSession | null): Boot {
  const fmtKey = JSON.stringify(format);
  if (sv && sv.charId) {
    try {
      if (sv.charId === ch.id && sv.format === fmtKey) {
        const timeline = StateTimeline.restore(format, [ch.id], sv.timeline);
        const msgs = sv.msgs.filter((m) => !(m.kind === 'ai' && m.deleted));
        for (const m of sv.msgs) if (m.kind === 'ai' && m.deleted && timeline.has(m.id)) timeline.remove(m.id);
        return { timeline, msgs, seg: sv.segCounter, restored: msgs.length > 0, err: '' };
      }
    } catch (e) {
      return { timeline: new StateTimeline(format, [ch.id]), msgs: [], seg: 0, restored: false, err: `上次的台本讀不回來（${e instanceof Error ? e.message : String(e)}）。按頂列「重新開始」清掉它再繼續。` };
    }
  }
  const timeline = new StateTimeline(format, [ch.id]);
  if (ch.state) {
    try {
      timeline.setBase(ch.id, ch.state);
    } catch (e) {
      return { timeline, msgs: [], seg: 0, restored: false, err: `${ch.subName || ch.name}存的狀態和目前的欄位表對不上（${e instanceof Error ? e.message : String(e)}）。到右側面板按「編輯數值」›「重置成初始值」，或把欄位表改回來。` };
    }
  }
  return { timeline, msgs: [], seg: 0, restored: false, err: '' };
}
export const useSession = () => useContext(Ctx);

/** 狀態錯誤訊息給人看：拿掉內部角色 id、欄位 key 換成名稱、開頭改成「沒有存：」 */
export function humanStateError(msg: string, fields: { key: string; label: string }[], charId: string): string {
  const m = msg.split(`${charId}.`).join('').replace('秘密狀態格式錯誤，這段的狀態未套用：', '沒有存：');
  return fields.reduce((x, f) => x.split(`${f.key} `).join(`${f.label} `), m);
}

export const fmtClock = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
};

export function SessionRoot(props: {
  data: AppData;
  update: (f: (d: AppData) => AppData) => void;
  character: Character;
  toast: (msg: string, bad?: boolean, undo?: () => void) => void;
  infoRef: { current: () => SessionInfo };
  /** 存檔裡的台本（沒有＝null） */
  saved: SavedSession | null;
  /** 台本變動時交給存檔區防抖寫回 */
  onPersist: (s: SavedSession) => void;
  children: React.ReactNode;
}) {
  const { data, update, character: ch, toast } = props;
  const s = data.settings;
  const [b0] = useState(() => boot(data.secretFormat, ch, props.saved));
  const timeline = b0.timeline;
  const [loadErr, setLoadErr] = useState(b0.err);
  const [msgs, setMsgs] = useState<Msg[]>(b0.msgs);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(b0.err);
  const [ragFail, setRagFail] = useState<{ opts: { userText?: string; regenerateId?: string } } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [paused, setPaused] = useState(b0.restored); // 重新整理後先暫停，不自己播也不自己續寫
  const [panel, setPanel] = useState<PanelState>(() => {
    const last = [...b0.msgs].reverse().find((m): m is AiMsg => m.kind === 'ai' && timeline.has(m.id));
    if (!last) return { n: 0, snap: timeline.current()[ch.id]!, prev: null, clamps: [] };
    const n = b0.msgs.filter((m) => m.kind === 'ai').length;
    return { n, snap: timeline.get(last.id).snapshots[ch.id]!, prev: timeline.before(last.id)[ch.id]!, clamps: [] };
  });
  const [memory, setMemory] = useState<MemoryCandidate[]>([]);
  const [startedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [faded, setFaded] = useState(false);
  const segCounter = useRef(b0.seg);
  const abortRef = useRef<AbortController | null>(null);
  const stopReason = useRef('');
  // 換了 LLM 端點或模型：正在生成的這段停掉（不然斷線重連會連回舊的端點，例如把剛卸載的本機模型又載回來）
  const llmKey = `${s.llmBase}|${s.model}`;
  const llmKeyRef = useRef(llmKey);
  useEffect(() => {
    if (llmKeyRef.current === llmKey) return;
    llmKeyRef.current = llmKey;
    if (abortRef.current) {
      stopReason.current = 'LLM 換了（端點或模型），這段已停止；按重試用新的設定生成';
      abortRef.current.abort();
    }
  }, [llmKey]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const soloRef = useRef<HTMLAudioElement>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const [glossaryBusy, setGlossaryBusy] = useState<string | null>(null);
  const [trace, setTrace] = useState<SegmentTrace | null>(null);
  const synthBusy = useRef(false);
  const deleteTimers = useRef<Record<string, number>>({});
  const firstValue = useRef<number | null>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;

  const numField = data.secretFormat.fields.find((f) => f.type === 'number');
  const aiOrder = () => msgsRef.current.filter((m): m is AiMsg => m.kind === 'ai' && !m.deleted).map((m) => m.id);
  const segNumber = (id: string) => aiOrder().indexOf(id) + 1;
  const aiMsgs = msgs.filter((m): m is AiMsg => m.kind === 'ai');
  const liveLines = aiMsgs.filter((m) => !m.deleted).flatMap((m) => m.items.filter((i): i is LineItem => i.kind === 'line'));
  const playing = liveLines.find((l) => l.status === 'playing');
  const unplayed = liveLines.filter((l) => l.status !== 'done' && l.status !== 'error').length;
  const latest = [...aiMsgs].reverse().find((m) => !m.deleted);
  const buffered = aiMsgs.filter((m) => !m.deleted && m.items.some((i) => i.kind === 'line' && (i.status === 'queued' || i.status === 'synth' || i.status === 'ready'))).length;
  const sleepLeftMs = s.sleepMinutes * 60_000 - (now - startedAt);

  const patchLine = (key: string, p: Partial<LineItem>) => {
    if (p.status) appLog('line.status', { line: key, to: p.status, ...(p.error ? { error: p.error } : {}) });
    setMsgs((ms) => ms.map((m) => (m.kind === 'ai' ? { ...m, items: m.items.map((it) => (it.kind === 'line' && it.key === key ? { ...it, ...p } : it)) } : m)));
  };
  const patchMsg = (id: string, p: Partial<AiMsg>) => setMsgs((ms) => ms.map((m) => (m.kind === 'ai' && m.id === id ? { ...m, ...p } : m)));

  /** 面板顯示「到這段為止最近一段有狀態的」：狀態請求失敗或被停掉的段落有台詞、沒有狀態（時間軸裡沒有它） */
  function showPanelFor(segId: string | null) {
    const order = aiOrder();
    const upto = segId ? order.slice(0, order.indexOf(segId) + 1) : [];
    const withState = [...upto].reverse().find((id) => timeline.has(id)) ?? null;
    if (!withState || !timeline.length) {
      setPanel({ n: 0, snap: timeline.current()[ch.id]!, prev: null, clamps: [] });
      return;
    }
    segId = withState;
    const cur = timeline.get(segId);
    setPanel({ n: segNumber(segId), snap: cur.snapshots[ch.id]!, prev: timeline.before(segId)[ch.id]!, clamps: cur.clamps });
  }

  function logSegment(segId: string, userText: string | undefined, items: LineItem[]) {
    const lines = items.filter((i): i is LineItem => i.kind === 'line').map((i) => `${i.ev.ja}／${i.ev.zh}`);
    const text = [userText ? `聽者：${userText}` : '', ...lines].filter(Boolean).join('\n');
    update((d) => {
      const existing = d.log.find((e) => e.segId === segId);
      if (existing) return { ...d, log: d.log.map((e) => (e.segId === segId ? { ...e, text } : e)) };
      return { ...d, log: [...d.log, { segId, n: d.logSeq + 1, text }], logSeq: d.logSeq + 1 };
    });
  }

  type GenOpts = { userText?: string; regenerateId?: string; skipRag?: boolean };

  /** 這次要不要帶參考範例、要的話去音訊服務檢索；失敗丟錯（由 generate 停下、讓使用者決定） */
  async function retrieveReferences(opts: GenOpts): Promise<RagReference[]> {
    const r = s.rag;
    const on = r.collection && (isLocalLms(s.llmBase) ? r.local : r.cloud);
    if (!on || opts.skipRag) return [];
    const scene = data.optOn.scene ? (data.scenes.find((x) => x.id === data.activeSceneId) ?? null) : null;
    const query = buildRagQuery({ userInput: opts.userText ?? '', scene: scene ? { name: scene.name, desc: scene.desc } : null, character: ch, tone: data.tone });
    if (!query) return [];
    const res = await traced('參考範例檢索')(`${s.audioBase.replace(/\/+$/, '')}/rag/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: r.collection, query, k: r.k }) });
    if (!res.ok) throw new Error(await res.json().then((j: { detail?: unknown }) => String(j.detail ?? res.statusText), () => `HTTP ${res.status}`));
    const hits = ((await res.json()) as { hits: RagReference[] }).hits;
    return fitReferences(hits.map((h) => ({ id: h.id, header: h.header, text: h.text })), r.maxChars);
  }

  async function generate(opts: GenOpts = {}) {
    if (loadErr) {
      setError(loadErr);
      return;
    }
    if (!s.model) {
      setError('還沒選模型：到系統核心的連線設定測試連線並選一個模型');
      return;
    }
    if (!ch.voice) {
      setError('這個角色還沒鎖定聲音：到萬物之書的角色分頁按「重新設計聲音」');
      return;
    }
    setError('');
    setRagFail(null);
    setGenerating(true);
    let references: RagReference[] = [];
    try {
      references = await retrieveReferences(opts);
    } catch (e) {
      // 檢索失敗：不自動略過（那是 fallback），停在錯誤列給「重試」與「這段不帶參考範例繼續」
      const msg = e instanceof Error ? e.message : String(e);
      appLog('rag.fail', { error: msg });
      setGenerating(false);
      setRagFail({ opts });
      setError(`參考範例檢索失敗：${msg}`);
      return;
    }
    if (references.length) appLog('rag.hits', { ids: references.map((r) => r.id) });
    appLog('gen.start', { mode: data.ui.mode, ...(opts.userText ? { user: opts.userText.slice(0, 40) } : {}), ...(opts.regenerateId ? { regenerate: opts.regenerateId } : {}) });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const regen = !!opts.regenerateId;
    const segId = opts.regenerateId ?? `seg-${++segCounter.current}`;
    const at = Date.now() - startedAt;
    if (regen) patchMsg(segId, { items: [], actions: [], editing: false });
    else {
      const add: Msg[] = [];
      if (opts.userText) add.push({ kind: 'user', id: `u-${segId}`, text: opts.userText, at });
      add.push({ kind: 'ai', id: segId, items: [], actions: [], deleted: false, editing: false, userTurn: '' });
      setMsgs((ms) => [...ms, ...add]);
    }
    setMemory((m) => m.filter((c) => c.segId !== segId));
    const all = msgsRef.current.filter((m): m is AiMsg => m.kind === 'ai' && !m.deleted);
    // 重生時只帶這段之前的對話；這段之後的不算
    const prior = regen ? all.slice(0, all.findIndex((m) => m.id === segId)) : all.filter((m) => m.id !== segId);
    const context: ContextTurn[] = prior
      .filter((m) => m.userTurn && m.items.length)
      .flatMap((m): ContextTurn[] => [
        { role: 'user', text: m.userTurn },
        { role: 'assistant', text: m.items.map((i) => `「${i.ev.ja}」`).join('\n') },
      ]);
    const scene = data.optOn.scene ? (data.scenes.find((x) => x.id === data.activeSceneId) ?? null) : null;
    const haystack = scanText(context, opts.userText ?? '');
    const clockNow = data.clock.on ? ([...prior].reverse().find((m) => m.time)?.time ?? data.clock.start) : null;
    const collected: LineItem[] = [];
    let pendingSe: SeEvent[] = [];
    const t0 = Date.now();
    try {
      const r = await generateSegment({
        endpoint: endpointOf(s),
        fetchFn: traced('台詞'),
        model: s.model,
        temperature: s.temperature,
        maxTokens: s.maxTokens,
        templates: data.templates.segment,
        timeline,
        segmentId: segId,
        regenerate: regen,
        signal: ctrl.signal,
        prompt: {
          systemPrompt: data.prompts.system,
          opening: data.prompts.opening,
          sleepInstruction: data.prompts.sleep,
          statDefs: data.statDefs,
          character: ch,
          protagonist: data.protagonist,
          scene: scene ? { name: scene.name, desc: scene.desc } : null,
          glossary: data.optOn.glossary ? data.glossary : null,
          world: data.optOn.world && data.world.trim() ? data.world : null,
          memories: data.optOn.memory ? pickChapters(data.chapters, haystack).map((c) => `${c.title}${c.summary ? `：${c.summary}` : ''}`) : null,
          history: data.optOn.history ? data.history.slice(0, 3).map((h) => `${h.title}：${h.body}`) : null,
          tone: data.tone,
          secretFormat: data.secretFormat,
          layout: data.layout,
          mode: opts.userText ? 'interactive' : data.ui.mode,
          userInput: opts.userText ?? '',
          intimacy: data.ui.intimacy,
          intimacySystem: data.intimacy.system,
          intimacyScript: data.intimacy.script,
          secretTemplate: data.secretTemplate,
          clock: clockNow,
          context,
          contextLimit: data.ui.intimacy ? s.contextIntimacy : s.contextNormal,
          stateSeparately: s.stateSeparately,
          lineRange: { min: s.linesMin, max: s.linesMax },
          isFirstSegment: prior.length === 0,
          withEn: data.ui.sub === 'en',
          references,
        },
        onEvent: (ev, i) => {
          // core 先送這句的 se 再送台詞：音效收起來掛到這句上，播放時一起開始
          if (ev.type === 'se') {
            pendingSe.push(ev);
            return;
          }
          const item: LineItem = { kind: 'line', key: `${segId}-${Date.now()}-${i}`, ev, status: 'queued', at: Date.now() - startedAt, se: pendingSe };
          pendingSe = [];
          collected.push(item);
          setMsgs((ms) => ms.map((m) => (m.kind === 'ai' && m.id === segId ? { ...m, items: [...m.items, item] } : m)));
        },
        onActions: (a) => patchMsg(segId, { actions: a }),
        // 斷線重連（[[PLAN_斷線重連與重新開始]]）：等端點恢復再重送；台詞請求整段重來前清掉這段已出現的台詞
        reconnect: {
          attempts: 3,
          onRetry: (n, pass, err) => {
            appLog('gen.retry', { seg: segId, attempt: n, pass, error: err });
            toast(`LLM 斷線，等它恢復後重新${pass === 'lines' ? '生成這段' : '問狀態（台詞不動）'}（第 ${n}／3 次）`, true);
          },
        },
        onReset: () => {
          appLog('gen.reset', { seg: segId, cleared: collected.length, why: '台詞請求斷線重來：清掉這段已出現的台詞' });
          collected.length = 0;
          pendingSe = [];
          patchMsg(segId, { items: [], actions: [] });
        },
        onRequest: (q) =>
          q.pass === 'lines'
            ? setTrace({ segId, at: new Date().toISOString(), model: s.model, baseUrl: s.llmBase, intimacy: data.ui.intimacy, messages: q.messages, schema: q.schema, raw: '', status: 'streaming' })
            : setTrace((t) => (t && t.segId === segId ? { ...t, state: { messages: q.messages, schema: q.schema, raw: '' } } : t)),
      });
      setTrace((t) => (t && t.segId === segId ? { ...t, raw: r.raw, status: 'done', ms: Date.now() - t0, firstEventMs: r.firstEventMs, stateMs: r.stateMs, ...(t.state && r.stateRaw ? { state: { ...t.state, raw: r.stateRaw } } : {}) } : t));
      patchMsg(segId, { userTurn: r.userContent, ...(r.time ? { time: r.time } : {}) });
      if (r.timeNote) toast(r.timeNote, true);
      if (r.secret) {
        const secret = r.secret;
        update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === ch.id ? { ...c, secret } : c)) }));
        toast(`${ch.subName || ch.name}還沒有秘密，這段依秘密生成格式寫好了（萬物之書的角色卡可以改）`);
      }
      const snap = r.snapshots[ch.id]!;
      if (numField && firstValue.current === null) firstValue.current = timeline.before(segId)[ch.id]![numField.key] as number;
      setPanel({ n: segNumber(segId), snap, prev: timeline.before(segId)[ch.id]!, clamps: r.clamps });
      if (data.optOn.memory) setMemory((m) => [...m, ...r.memory.map((text) => ({ segId, text }))]);
      logSegment(segId, opts.userText, collected);
      appLog('gen.done', { seg: segId, lines: collected.length, ms: Date.now() - t0 });
    } catch (e) {
      appLog('gen.fail', { seg: segId, aborted: ctrl.signal.aborted, error: e instanceof Error ? e.message : String(e) });
      setTrace((t) => (t && t.segId === segId ? { ...t, status: 'error', error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 } : t));
      if (e instanceof LlmIdleError) setError(e.message);
      else if (ctrl.signal.aborted) {
        setError(stopReason.current || '已停止生成');
        stopReason.current = '';
      }
      else if (e instanceof StateRejectedError) setError(e.message);
      else setError(`連線失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  // 她正在說話時送出的話：排在這段之後
  useEffect(() => {
    if (!generating && pending !== null) {
      const t = pending;
      setPending(null);
      void generate({ userText: t });
    }
  });

  // TTS：一次合成一句（引擎端也是單一併發）
  useEffect(() => {
    if (synthBusy.current || !ch.voice) return;
    const next = liveLines.find((l) => l.status === 'queued');
    if (!next) return;
    synthBusy.current = true;
    patchLine(next.key, { status: 'synth' });
    const v = ch.voice;
    const vt = data.templates.voice;
    const style = next.ev.voice === 'whisper' || next.ev.voice === 'soft' ? vt.qwenWhisper : next.ev.voice === 'breath' ? vt.qwenBreath : vt.qwenNormal;
    // ZONOS：語氣換成 controls（[[PLAN_ZONOS語氣控制]]）；語音庫 key 的語氣欄一併帶上，換語氣就是另一個檔
    const controls = v.engine === 'zonos' ? zonosControls(next.ev, data.zonosTone) : {};
    const spans = v.engine === 'zonos' ? zonosSpans(next.ev, data.zonosTone) : []; // 句中耳語《》
    const ck = controlsKey(controls) + (spans.length ? `|spans:${spans.map((x) => `${x.start}-${x.end}:${controlsKey(x.controls)}`).join(';')}` : '');
    // 語音庫：同一組參數（含 Qwen 的語氣後綴）＝同一個 key；庫裡有就直接用，沒有才合成，合成完存進庫
    const params: VoiceParams = { engine: v.engine, speaker: v.engine === 'qwen-comfy' ? `${v.speaker}｜${style}` : v.speaker, seed: v.seed, steps: v.engine === 'irodori' ? s.irodoriSteps : null, voice: ck ? `${next.ev.voice}#${ck}` : next.ev.voice, text: next.ev.ja };
    (async () => {
      const key = await voiceKey(params);
      const cached = await fetchAsset('voice', key);
      if (cached) return patchLine(next.key, { status: 'ready', url: URL.createObjectURL(cached), voiceKey: key });
      const r = await synthesize(s.audioBase, { engine: v.engine, text: next.ev.ja, voice: next.ev.voice, speaker: v.speaker, seed: v.seed, ...(() => {
        const sc = splitControls(controls);
        return { ...(Object.keys(sc.controls).length ? { controls: sc.controls } : {}), ...(Object.keys(sc.conditionValues).length ? { condition_values: sc.conditionValues } : {}) };
      })(), ...(spans.length ? { control_spans: spans, control_span_rate: SPAN_RATE } : {}), ...(v.engine === 'qwen-comfy' ? { style } : {}), ...(v.engine === 'irodori' ? { num_steps: s.irodoriSteps } : {}) });
      patchLine(next.key, { status: 'ready', url: r.url, voiceKey: key });
      await putVoice(key, params, r.blob).catch((e: unknown) => toast(`這句的語音沒存進語音庫（重新整理後要重新合成）：${e instanceof Error ? e.message : String(e)}`, true));
    })()
      .catch((e: unknown) => patchLine(next.key, { status: 'error', error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        synthBusy.current = false;
        setMsgs((ms) => [...ms]);
      });
  });

  // 播放：照順序；前一句沒合成好就等；暫停時不往下播
  useEffect(() => {
    if (playing || faded || paused) return;
    const next = liveLines.find((l) => l.status !== 'done' && l.status !== 'error');
    if (!next || next.status !== 'ready' || !audioRef.current) return;
    appLog('play.seq', { line: next.key });
    patchLine(next.key, { status: 'playing' });
    const a = audioRef.current;
    a.src = next.url!;
    a.onended = () => patchLine(next.key, { status: 'done' });
    a.play()
      .then(() => next.se.forEach((x) => playSe(x.id, x.side)))
      .catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return; // 被重播、刪除中斷：預期行為
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        // 瀏覽器的自動播放規則：重新整理後還沒點過頁面就不准出聲。這句合成好了，停在可播，等使用者按播放
        appLog('play.blocked', { line: next.key, why: '瀏覽器的自動播放規則' });
        patchLine(next.key, { status: 'ready' });
        setPaused(true);
        toast('瀏覽器擋住了自動播放：按左下角的播放鍵就會開始', true);
        return;
      }
      patchLine(next.key, { status: 'error', error: `無法播放：${String(e)}` });
    });
  });

  // 無限／睡眠：緩衝不到 3 句就寫下一段
  useEffect(() => {
    if (data.ui.mode === 'interactive' || paused || generating || error || faded || pending !== null) return;
    if (data.ui.mode === 'sleep' && sleepLeftMs <= 0) return;
    if (unplayed < 3) {
      appLog('gen.auto', { mode: data.ui.mode, unplayed });
      void generate();
    }
  });

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // 睡眠計時到：停止續寫並淡出
  useEffect(() => {
    if (data.ui.mode !== 'sleep' || faded || sleepLeftMs > 0 || !audioRef.current) return;
    setFaded(true);
    const a = audioRef.current;
    const iv = window.setInterval(() => {
      a.volume = Math.max(0, a.volume - 0.05);
      setSfxVolume(a.volume);
      if (a.volume === 0) {
        window.clearInterval(iv);
        a.pause();
      }
    }, 500);
  });

  // 自動存檔：台本（語音只存語音庫的 key，不存 blob URL）＋時間軸；角色身上存最新狀態（重新整理後接著用；重新開始會清掉）
  useEffect(() => {
    if (loadErr) return; // 讀檔失敗時不覆蓋舊存檔，等使用者處理
    const saved: SavedSession = {
      charId: ch.id,
      format: JSON.stringify(data.secretFormat),
      msgs: msgs.map((m) => (m.kind === 'ai' ? { ...m, editing: false, items: m.items.map((i) => ({ ...i, url: undefined, status: i.status === 'error' ? 'error' : 'done' })) } : m)),
      timeline: timeline.toJSON(),
      segCounter: segCounter.current,
    };
    props.onPersist(saved);
    const cur = timeline.current()[ch.id]!;
    if (JSON.stringify(cur) !== JSON.stringify(ch.state)) update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === ch.id ? { ...c, state: cur } : c)) }));
  }, [msgs, panel, loadErr]);

  const pausedBySolo = useRef(false);
  /** 單獨播放開始：循序播放還在播就先暫停，記下是單獨播放造成的 */
  function pauseForSolo() {
    audioRef.current?.pause();
    if (!paused) pausedBySolo.current = true;
    setPaused(true);
    resumeSfx();
  }
  /** 單獨播放結束（播完或停掉）：如果是它把循序播放暫停的，就接著播 */
  function endSolo(why: string) {
    soloRef.current?.pause();
    setSolo(null);
    appLog('play.solo.end', { why, resumeSequence: pausedBySolo.current });
    if (!pausedBySolo.current) return;
    pausedBySolo.current = false;
    setPaused(false);
    const a = audioRef.current;
    if (a && playing) void a.play();
  }
  function stopSolo() {
    soloRef.current?.pause();
    setSolo(null);
  }

  const info = (): SessionInfo => ({ segments: timeline.length, first: firstValue.current, last: numField ? (panel.snap[numField.key] as number) : null });
  props.infoRef.current = info;

  const session: Session = {
    character: ch,
    trace,
    msgs,
    generating,
    error,
    paused,
    playing,
    buffered,
    elapsedMs: now - startedAt,
    sleepLeftMs,
    faded,
    panel,
    memory,
    latest,
    clock: data.clock.on ? ([...aiMsgs].reverse().find((m) => !m.deleted && m.time)?.time ?? data.clock.start) : null,
    segNumber,
    send: (text) => {
      const t = text.trim();
      if (!t) return;
      if (data.ui.mode !== 'interactive') update((d) => ({ ...d, ui: { ...d.ui, mode: 'interactive' } }));
      // 送出＝想聽回覆：播放列是暫停的（重新整理後預設暫停、或之前按了暫停）就恢復，不然生成好的語音會一直等（使用者 2026-11-20）
      if (paused) {
        appLog('play.resume', { by: '送出' });
        pausedBySolo.current = false;
        stopSolo();
        setPaused(false);
        resumeSfx();
      }
      if (generating) {
        setPending(t);
        toast('已排在這段之後');
      } else void generate({ userText: t });
    },
    retry: () => void (ragFail ? generate(ragFail.opts) : generate(latest && !latest.items.length ? { regenerateId: latest.id } : {})),
    ragFailed: !!ragFail,
    continueWithoutRag: () => void (ragFail && generate({ ...ragFail.opts, skipRag: true })),
    stop: (reason) => {
      if (!abortRef.current) return;
      stopReason.current = reason ?? '';
      abortRef.current.abort();
    },
    togglePause: () => {
      const a = audioRef.current;
      appLog(paused ? 'play.resume' : 'play.pause', { by: '播放列' });
      pausedBySolo.current = false;
      if (paused) {
        stopSolo();
        setPaused(false);
        resumeSfx();
        if (a && playing) void a.play();
      } else {
        setPaused(true);
        a?.pause();
        pauseSfx();
      }
    },
    playLine: (key) => {
      const it = liveLines.find((l) => l.key === key);
      if (!it) return;
      if (playing?.key === key) return session.togglePause();
      if (solo === key) return endSolo('再按一次同一句');
      if (it.status !== 'error' && !it.url && it.voiceKey) {
        // 存檔還原的台詞：從語音庫取出來單獨播
        const vk = it.voiceKey;
        void fetchAsset('voice', vk).then(
          (b) => {
            if (!b) return patchLine(key, { status: 'queued', voiceKey: undefined }); // 庫裡被清掉了：重新合成
            const url = URL.createObjectURL(b);
            patchLine(key, { url });
            pauseForSolo();
            const a = soloRef.current!;
            a.src = url;
            a.onended = () => endSolo('播完');
            setSolo(key);
            appLog('play.solo', { line: key, from: '語音庫' });
            void a.play().then(
              () => it.se.forEach((x) => playSe(x.id, x.side)),
              (e: unknown) => {
                setSolo(null);
                toast(`無法播放：${String(e)}`, true);
              },
            );
          },
          (e: unknown) => toast(`讀語音庫失敗：${e instanceof Error ? e.message : String(e)}`, true),
        );
        return;
      }
      if (it.status === 'error' || !it.url) {
        patchLine(key, { status: 'queued', error: undefined }); // 重新合成（庫裡有同 key 就直接取），輪到時照順序播
        return;
      }
      // 單獨播這一句：循序播放先暫停，這句播完（或再按一次停掉）就接著循序播
      pauseForSolo();
      const a = soloRef.current!;
      a.src = it.url;
      a.onended = () => endSolo('播完');
      setSolo(key);
      appLog('play.solo', { line: key });
      a.play()
        .then(() => it.se.forEach((x) => playSe(x.id, x.side)))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setSolo(null);
          toast(`無法播放：${String(e)}`, true);
        });
    },
    solo,
    audioOf: (key) => (solo === key ? soloRef.current : playing?.key === key ? audioRef.current : null),
    replay: (id) => {
      audioRef.current?.pause();
      setPaused(false);
      setMsgs((ms) =>
        ms.map((x) =>
          x.kind === 'ai'
            ? {
                ...x,
                items: x.items.map((it) => {
                  if (it.kind !== 'line') return it;
                  if (x.id === id) return { ...it, status: it.url ? 'ready' : 'queued', error: undefined } as LineItem;
                  return it.status === 'playing' ? { ...it, status: 'done' } : it;
                }),
              }
            : x,
        ),
      );
    },
    regenerate: (id) => void generate({ regenerateId: id }),
    setEditing: (id, on) => patchMsg(id, { editing: on }),
    saveEdit: (id, lines) => {
      setMsgs((ms) =>
        ms.map((x) =>
          x.kind === 'ai' && x.id === id
            ? {
                ...x,
                editing: false,
                items: x.items.map((it) => {
                  const l = it.kind === 'line' ? lines.find((y) => y.key === it.key) : undefined;
                  return it.kind === 'line' && l ? { ...it, ev: { ...it.ev, ja: l.ja, zh: l.zh }, status: 'done', url: undefined } : it;
                }),
              }
            : x,
        ),
      );
      toast('已修改；按「重播」會用新台詞重新合成');
    },
    glossaryBusy,
    glossarize: async (segId) => {
      const m = msgsRef.current.find((x): x is AiMsg => x.kind === 'ai' && x.id === segId);
      if (!m || glossaryBusy) return;
      if (!s.model) return toast('還沒選模型：到系統核心的連線設定測試連線並選一個模型', true);
      setGlossaryBusy(segId);
      try {
        const text = m.items.map((i) => `${i.ev.ja}／${i.ev.zh}`).join('\n');
        const r = await organizeGlossary({ endpoint: endpointOf(s), fetchFn: traced('圖鑑整理'), model: s.model, entries: data.glossary, text, templates: data.templates.glossary });
        update((d) => ({ ...d, glossary: r.entries }));
        toast(r.created || r.updated ? `圖鑑：新增 ${r.created} 條、更新 ${r.updated} 條` : '這段沒有需要記進圖鑑的名詞');
      } catch (e) {
        toast(`整理失敗：${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        setGlossaryBusy(null);
      }
    },
    segmentsAfter: (uid) => {
      const i = msgsRef.current.findIndex((x) => x.id === uid);
      return i < 0 ? 0 : msgsRef.current.slice(i).filter((x) => x.kind === 'ai' && !x.deleted).length;
    },
    editUser: (uid, text) => {
      const t = text.trim();
      const i = msgsRef.current.findIndex((x) => x.id === uid);
      if (!t || i < 0) return;
      abortRef.current?.abort();
      audioRef.current?.pause();
      stopSolo();
      const drop = msgsRef.current.slice(i);
      const dropIds = new Set(drop.map((x) => x.id));
      // 時間軸從後面刪回來，狀態回到這則之前那段結束時
      for (const m of [...drop].reverse()) if (m.kind === 'ai' && timeline.has(m.id)) timeline.remove(m.id);
      for (const m of drop) if (m.kind === 'ai' && deleteTimers.current[m.id]) window.clearTimeout(deleteTimers.current[m.id]);
      setMsgs((ms) => ms.filter((x) => !dropIds.has(x.id)));
      msgsRef.current = msgsRef.current.filter((x) => !dropIds.has(x.id));
      update((d) => ({ ...d, log: d.log.filter((e) => !dropIds.has(e.segId)) }));
      setMemory((mm) => mm.filter((c) => !dropIds.has(c.segId)));
      const rest = msgsRef.current.filter((x): x is AiMsg => x.kind === 'ai' && !x.deleted);
      showPanelFor(rest[rest.length - 1]?.id ?? null);
      setPaused(false);
      void generate({ userText: t });
    },
    remove: (id) => {
      const m = msgsRef.current.find((x): x is AiMsg => x.kind === 'ai' && x.id === id);
      if (!m) return;
      patchMsg(id, { deleted: true });
      if (playing && m.items.some((i) => i.key === playing.key)) audioRef.current?.pause();
      deleteTimers.current[id] = window.setTimeout(() => {
        delete deleteTimers.current[id];
        if (timeline.has(id)) timeline.remove(id); // 沒有狀態的段落（狀態請求失敗）不在時間軸裡
        setMsgs((ms) => ms.filter((x) => x.id !== id && x.id !== `u-${id}`));
        update((d) => ({ ...d, log: d.log.filter((e) => e.segId !== id) }));
        setMemory((mm) => mm.filter((c) => c.segId !== id));
        const rest = aiOrder().filter((x) => x !== id);
        showPanelFor(rest[rest.length - 1] ?? null);
      }, 5000);
      toast('已刪除這一段，5 秒內可復原', false, () => {
        window.clearTimeout(deleteTimers.current[id]);
        delete deleteTimers.current[id];
        patchMsg(id, { deleted: false });
      });
    },
    editState: (snap) => {
      try {
        timeline.editCurrent(ch.id, snap);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      const cur = timeline.current()[ch.id]!;
      setPanel((p) => ({ ...p, snap: cur, clamps: [] }));
      return null;
    },
    resetState: () => {
      timeline.reset(ch.id);
      setPanel((p) => ({ ...p, snap: timeline.current()[ch.id]!, clamps: [] }));
      if (loadErr && !msgs.length) {
        setLoadErr('');
        setError('');
      }
      toast('已重置成初始狀態');
    },
    acceptMemory: (c) => {
      update((d) => {
        const n = d.log.find((e) => e.segId === c.segId)?.n ?? d.logSeq;
        const id = d.chapters.reduce((mx, x) => Math.max(mx, x.id), 0) + 1;
        return { ...d, chapters: [...d.chapters, { id, title: c.text, summary: '', keywords: [], range: { start: n, end: n }, pinned: true }] };
      });
      setMemory((m) => m.filter((x) => x !== c));
      toast('已存進回憶（釘選，每段都會帶）');
    },
    dismissMemory: (c) => setMemory((m) => m.filter((x) => x !== c)),
    info,
  };

  return (
    <Ctx.Provider value={session}>
      <audio ref={audioRef} data-testid="player" />
      <audio ref={soloRef} data-testid="solo-player" />
      {props.children}
    </Ctx.Provider>
  );
}

export { SE_IDS };
