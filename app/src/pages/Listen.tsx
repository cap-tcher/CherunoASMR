// 聆聽（V4）：中央台本＋右側檢視面板；互動模式時台本下方是回話區。
import { estimateLineMs, layoutSeBlocks, rubyParts, type LineEvent, type SeBlock, EMOTION_LABEL, SPEED_LABEL, whisperLike } from '@cheruno/core';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Panel } from '../components/Panel.tsx';
import { fmtClock, useSession, type AiMsg, type LineItem } from '../session.tsx';
import { BGM_IDS, SE_DUR_MS, bgmPlaying, playSe, startBgm, stopBgm, subscribeBgm } from '../sfx.ts';
import { SE_LABEL, type AppData } from '../store.ts';

const PAGE = 50; // ADV3.0 visibleCount（L1210）

const VOICE = { normal: '一般', soft: '小声', whisper: '囁き', breath: '吐息' } as const;
const SIDE = { left: '左耳', center: '正面', right: '右耳' } as const;
const SIDE1 = { left: '左', center: '中', right: '右' } as const;

function Ruby({ ja, show }: { ja: string; show: boolean }) {
  return (
    <>
      {rubyParts(ja).map((p, i) =>
        p.reading && show ? (
          <ruby key={i} className={p.whisper ? 'wsp' : undefined}>
            {p.text}
            <rt>{p.reading}</rt>
          </ruby>
        ) : (
          <span key={i} className={p.whisper ? 'wsp' : undefined}>
            {p.text}
          </span>
        ),
      )}
    </>
  );
}

/** 位置條：左耳 0%～右耳 100%；越近越靠耳朵 */
function dotLeft(ev: LineEvent) {
  if (ev.pos.side === 'center') return 50;
  const far = Math.min(ev.pos.distance_cm, 100) / 100; // 0＝貼耳
  const off = 46 - far * 30;
  return ev.pos.side === 'left' ? 50 - off : 50 + off;
}

function SegActions({ m, latest, busy }: { m: AiMsg; latest: boolean; busy: boolean }) {
  const s = useSession()!;
  const [open, setOpen] = useState(false);
  if (!latest && !open)
    return (
      <div role="group" aria-label="這一段的操作" className="seg-acts">
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          更多操作
        </button>
      </div>
    );
  return (
    // 齊右排：最常用的「重播」放最右邊（使用者 2026-11-20：順序倒過來）
    <div role="group" aria-label="這一段的操作" className="seg-acts">
      <button type="button" className="btn sm" onClick={() => s.remove(m.id)}>
        刪除
      </button>
      <button type="button" className="btn sm" disabled={!!s.glossaryBusy} onClick={() => void s.glossarize(m.id)}>
        {s.glossaryBusy === m.id ? '整理中' : '整理進圖鑑'}
      </button>
      <button type="button" className="btn sm" onClick={() => s.setEditing(m.id, true)}>
        編輯
      </button>
      <button type="button" className="btn sm" disabled={busy} onClick={() => s.regenerate(m.id)}>
        重生
      </button>
      <button type="button" className="btn sm" onClick={() => s.replay(m.id)}>
        重播
      </button>
    </div>
  );
}

function EditSegment({ m }: { m: AiMsg }) {
  const s = useSession()!;
  const lines = m.items.filter((i): i is LineItem => i.kind === 'line');
  const [draft, setDraft] = useState(() => lines.map((l) => ({ key: l.key, ja: l.ev.ja, zh: l.ev.zh })));
  return (
    <div className="edit-seg">
      {draft.map((l, i) => (
        <div key={l.key} className="grid-text">
          <label className="field">
            <span>日文台詞 {i + 1}</span>
            <textarea lang="ja" className="textarea" rows={2} value={l.ja} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, ja: e.target.value } : x)))} />
          </label>
          <label className="field">
            <span>字幕 {i + 1}</span>
            <textarea className="textarea" rows={2} value={l.zh} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, zh: e.target.value } : x)))} />
          </label>
        </div>
      ))}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn ghost" onClick={() => s.setEditing(m.id, false)}>
          取消
        </button>
        <button type="button" className="btn" onClick={() => s.saveEdit(m.id, draft)}>
          儲存
        </button>
      </div>
    </div>
  );
}

/** 聽者那則：可以改，改完刪掉之後的段落重新生成（ADV3.0 F-72） */
function UserRow({ id, text }: { id: string; text: string }) {
  const s = useSession()!;
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <div className="user-row">
        <span>你</span>
        <span>{text}</span>
        <button type="button" className="btn sm ghost user-edit" onClick={() => setDraft(text)}>
          改這句
        </button>
      </div>
    );
  const n = s.segmentsAfter(id);
  return (
    <div className="user-row editing">
      <span>你</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <textarea className="textarea" rows={2} value={draft} aria-label="改你說的話" onChange={(e) => setDraft(e.target.value)} />
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn sm" disabled={!draft.trim()} onClick={() => s.editUser(id, draft)}>
            送出並重寫
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setDraft(null)}>
            取消
          </button>
          <span className="hint">送出後，這句之後的 {n} 段會刪掉，從這裡重寫。</span>
        </div>
      </div>
    </div>
  );
}

/** 卡片狀態（使用者的 penpot 草圖 2026-11-20）：生成中＝不能播、右上角一個點；播放中＝已播的部分蓋上「播完」的顏色；播完或可播 */
function cardState(it: LineItem, lit: boolean) {
  if (lit) return 'playing';
  if (it.status === 'queued' || it.status === 'synth') return 'gen';
  return it.status === 'error' ? 'error' : 'ready';
}

/** 一句台詞＝一個訊息元件：整張卡按了就播（播放中再按＝暫停）；左上角的尖角指著時間線上這句開始的位置 */
function Line({ it, ui }: { it: LineItem; ui: AppData['ui'] }) {
  const s = useSession()!;
  const ref = useRef<HTMLDivElement>(null);
  // 單獨播放進行中：只有那句亮（循序播放被暫停的那句不顯示播放中，不然進度條會卡在那；使用者 2026-11-20）
  const lit = s.solo ? s.solo === it.key : s.playing?.key === it.key;
  const active = lit && (s.solo === it.key || !s.paused);
  const state = cardState(it, lit);
  const sub = ui.sub === 'off' ? null : ui.sub === 'zh' ? it.ev.zh : (it.ev.en ?? '這句生成時沒有英文字幕；切到 EN 後，下一段起才會有。');
  // 播放進度：直接寫進 CSS 變數，不讓整張卡每幀重畫
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!lit) {
      el.style.removeProperty('--p');
      return;
    }
    let raf = 0;
    const tick = () => {
      const a = s.audioOf(it.key);
      if (a && a.duration > 0) el.style.setProperty('--p', String(Math.min(1, a.currentTime / a.duration)));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [lit, it.key, s.audioOf]);
  const label = active ? '暫停這一句' : state === 'gen' ? (it.status === 'synth' ? '語音合成中，還不能播' : '排隊等合成，還不能播') : state === 'error' ? '重新合成這一句' : lit ? '繼續播這一句' : '播放這一句';
  const play = () => {
    if (state !== 'gen') s.playLine(it.key);
  };
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={state === 'gen' ? -1 : 0}
      aria-disabled={state === 'gen'}
      aria-pressed={active}
      aria-label={`${label}：${it.ev.ja.replace(/[《》]/g, '')}`}
      title={it.error ?? label}
      className="line"
      data-key={it.key}
      data-state={state}
      onClick={play}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        play();
      }}
    >
      {state === 'gen' && <span className={`gen-dot${it.status === 'synth' ? ' busy' : ''}`} aria-hidden="true" />}
      <div className="body">
        <p lang="ja" className="jp">
          「<Ruby ja={it.ev.ja} show={ui.ruby} />」
        </p>
        {sub !== null && <p className="sub">{sub}</p>}
      </div>
      <div className="tag">
        <span className={lit ? 'v accent' : 'v'}>
          {VOICE[it.ev.voice]}
          {/* 囁き／吐息不疊情緒（tone.ts whisperLike）：念出來沒有這個效果就不寫 */}
          {it.ev.emotion && it.ev.emotion !== 'none' && !whisperLike(it.ev.voice) ? `・${EMOTION_LABEL[it.ev.emotion]}` : ''}
          {/* 耳語類（小声／囁き／吐息）不疊速度（tone.ts 疊加上限），念出來沒有這個效果就不寫 */}
          {it.ev.speed && it.ev.speed !== 'normal' && it.ev.voice === 'normal' ? `・${SPEED_LABEL[it.ev.speed]}` : ''}
        </span>
        <span role="img" aria-label={`聲音位置：${SIDE[it.ev.pos.side]} ${it.ev.pos.distance_cm} 公分`} className="posbar">
          <span>左</span>
          <span className="track">
            <span className="dot" style={{ left: `${dotLeft(it.ev)}%` }} />
          </span>
          <span>右</span>
        </span>
        {it.status === 'error' ? (
          <span className="bad-t" title={it.error}>
            {it.error?.startsWith('無法播放') ? '播放失敗，按一下重試' : '合成失敗，按一下重試'}
          </span>
        ) : (
          <span className="num">
            {SIDE[it.ev.pos.side]} {it.ev.pos.distance_cm} 公分
          </span>
        )}
      </div>
    </div>
  );
}

/** 已合成的句子讀音檔長度（毫秒）；還沒有音檔的句子不在表裡，時間軸用字數估 */
function useLineDurations(items: LineItem[]) {
  const [dur, setDur] = useState<Record<string, number>>({});
  const urls = items.map((i) => i.url ?? '').join('|');
  useEffect(() => {
    const stop: (() => void)[] = [];
    for (const it of items) {
      if (!it.url || dur[it.key] !== undefined) continue;
      const a = new Audio();
      a.preload = 'metadata';
      const on = () => {
        if (Number.isFinite(a.duration) && a.duration > 0) setDur((d) => ({ ...d, [it.key]: Math.round(a.duration * 1000) }));
      };
      a.addEventListener('loadedmetadata', on);
      a.src = it.url;
      stop.push(() => a.removeEventListener('loadedmetadata', on));
    }
    return () => stop.forEach((f) => f());
  }, [urls]);
  return dur;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

function SeBlockView({ b }: { b: SeBlock }) {
  const names = b.items.map((x) => `${SE_LABEL[x.id] ?? x.id}（${SIDE[x.side]}）`).join('、');
  const notes = [b.clipped === 'next' ? '下一個音效開始時還在響' : '', b.clipped === 'end' ? `延續到這段結束後 ${sec(b.overMs)}` : '', b.estimated ? '有句子還沒合成，位置是估的' : ''].filter(Boolean);
  return (
    <button
      type="button"
      className={`se-block${b.estimated ? ' est' : ''}${b.clipped ? ' clip' : ''}`}
      style={{ top: b.top, height: b.height }}
      title={`${names}・${sec(b.durMs)}${notes.length ? `（${notes.join('；')}）` : ''}。點了試聽`}
      aria-label={`試聽音效：${names}`}
      onClick={() => b.items.forEach((x) => playSe(x.id, x.side))}
    >
      <span className="se-box">
        <span className="se-names">
          {b.items.map((x, i) => (
            <span key={i}>
              <span lang="ja">{SE_LABEL[x.id] ?? x.id}</span>
              <small>{SIDE1[x.side]}</small>
            </span>
          ))}
        </span>
        <span className="se-len" aria-hidden="true" />
      </span>
    </button>
  );
}

/** 一段的兩軌（[[SCR-04_台本兩軌]]）：左邊音效軌、右邊台詞卡；音效塊位置照非線性時間軸換算 */
function SegTracks({ m, ui, n, actions }: { m: AiMsg; ui: AppData['ui']; n: number; actions: React.ReactNode }) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<{ top: number; height: number }[]>([]);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const measure = () => {
      const next = [...el.children].filter((n): n is HTMLElement => n.classList.contains('line')).map((n) => ({ top: n.offsetTop, height: n.offsetHeight }));
      setBoxes((prev) => (prev.length === next.length && prev.every((b, i) => b.top === next[i]!.top && b.height === next[i]!.height) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [m.items.length]);
  const dur = useLineDurations(m.items);
  const blocks =
    boxes.length === m.items.length
      ? layoutSeBlocks(
          m.items.map((it, i) => {
            const d = dur[it.key];
            // se 的 id 在生成時已對 SE_IDS 驗過，SE_DUR_MS 涵蓋全部 SE_IDS
            return { durMs: d ?? estimateLineMs(it.ev.ja), estimated: d === undefined, ...boxes[i]!, se: it.se.map((x) => ({ ...x, durMs: SE_DUR_MS[x.id]! })) };
          }),
        )
      : [];
  return (
    <div className="tracks">
      <div className="se-track" aria-label="音效軌">
        {blocks.map((b) => (
          <SeBlockView key={b.line} b={b} />
        ))}
      </div>
      <span className="timebar" aria-hidden="true" />
      <div className="main-track" ref={mainRef}>
        {m.items.map((it) => (
          <Line key={it.key} it={it} ui={ui} />
        ))}
        <div className="seg-foot">
          <span>第 {n} 段</span>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** 背景音開關：循環播放，不進時間軸（使用者 2026-11-20） */
function BgmToggle() {
  const on = useSyncExternalStore(subscribeBgm, bgmPlaying);
  return (
    <span role="group" aria-label="背景音" className="bgm">
      <span className="hint">背景音</span>
      {BGM_IDS.map((id) => (
        <button key={id} type="button" className="chip" aria-pressed={on.includes(id)} title={on.includes(id) ? '關掉（淡出 1 秒）' : '循環播放，台本暫停也會繼續'} onClick={() => (on.includes(id) ? stopBgm(id) : startBgm(id))}>
          <span lang="ja">{SE_LABEL[id]}</span>
        </button>
      ))}
    </span>
  );
}

export function ListenPage({ data, goCreate, goSystem }: { data: AppData; goCreate: () => void; goSystem: () => void }) {
  const s = useSession();
  const [input, setInput] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  // ADV3.0 F-75／F-76：只畫最近 PAGE 則，捲到頂再多 PAGE 則（畫面不跳）；新內容進來時，本來就在底部就貼底
  const [shown, setShown] = useState(PAGE);
  const nearBottom = useRef(true);
  const growFrom = useRef<number | null>(null);
  const ui = data.ui;
  const playingKey = s?.solo ?? s?.playing?.key;

  // 跟著正在念的那句捲動；使用者自己捲過的 6 秒內不搶
  useEffect(() => {
    if (!playingKey || Date.now() - userScrolledAt.current < 6000) return;
    scrollRef.current?.querySelector(`[data-key="${CSS.escape(playingKey)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [playingKey]);

  function send() {
    // ADV3.0 handleSend（L2763–L2769）：選了建議行動又打字時，兩者合併成「行動＋換行＋打的字」
    const typed = input.trim();
    const t = chip ? (typed ? `${chip}\n${typed}` : chip) : typed;
    if (!t || !s) return;
    s.send(t);
    setInput('');
    setChip(null);
  }

  const name = s ? s.character.subName || s.character.name : '';
  const all = s ? s.msgs.filter((m) => !(m.kind === 'ai' && m.deleted)) : [];
  const visible = all.slice(-shown);
  const lastItems = s?.latest?.items.length ?? 0;

  // 往上載入：補回捲動位置，讓原本看著的那則不動
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && growFrom.current !== null) {
      el.scrollTop += el.scrollHeight - growFrom.current;
      growFrom.current = null;
    }
  }, [shown]);
  // 貼底：新段落、新台詞、生成中骨架出現時
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [all.length, lastItems, s?.generating]);
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop === 0 && shown < all.length) {
      growFrom.current = el.scrollHeight;
      setShown((n) => n + PAGE);
    }
  }
  const segCount = s ? s.msgs.filter((m): m is AiMsg => m.kind === 'ai' && !m.deleted).length : 0;
  const markScroll = () => {
    userScrolledAt.current = Date.now();
  };

  return (
    <div className="listen">
      <main aria-label="台本" className="script-col">
        <div className="script-scroll" ref={scrollRef} onWheel={markScroll} onTouchMove={markScroll} onScroll={onScroll} data-testid="script-scroll">
          <div className="script">
            <div className="script-head">
              <h1>今晚的台本</h1>
              {s && <BgmToggle />}
              {s && (
                <span className="num hint" style={{ fontSize: 14 }}>
                  {s.clock && <span className="story-clock" title="故事時鐘：故事裡現在幾點（系統核心 › 系統提示詞可關）">{s.clock}　</span>}
                  {segCount} 段，已聽 {fmtClock(s.elapsedMs)}
                </span>
              )}
            </div>

            {!s && (
              <div className="empty">
                <p>還沒有角色</p>
                <p>放一張角色圖或寫一句方向，建立第一個陪你的人。</p>
                <button type="button" className="btn primary" onClick={goCreate}>
                  建立角色
                </button>
              </div>
            )}

            {s?.character.voice?.engine === 'qwen-comfy' && data.settings.engine !== 'qwen-comfy' && (
              <div className="note caution" role="status" data-testid="qwen-voice-note">
                {name}的聲音是用 Qwen 聲音設計鎖定的：每句都要 Qwen 合成（一句十幾秒到一分鐘，Qwen 沒開就會合成失敗）。到 萬物之書 › 角色卡 按「聲音轉成 {data.settings.engine === 'zonos' ? 'ZONOS' : 'Irodori'}」，用鎖定時的候選音改成即時合成。
              </div>
            )}
            {all.length > visible.length && <p className="hint more-above">往上捲載入更早的 {Math.min(PAGE, all.length - visible.length)} 則（共 {all.length} 則）</p>}

            {s && visible.length === 0 && !s.generating && !s.error && (
              <div className="empty">
                <p>{ui.mode === 'interactive' ? `對${name}說點什麼` : `${name}正在想第一句`}</p>
                <p>{ui.mode === 'interactive' ? '在下面輸入，或切到播放列的「無限」讓她自己說。' : '台詞寫好一句就會開始念。'}</p>
              </div>
            )}

            {s &&
              visible.map((m) => {
                if (m.kind === 'user') return <UserRow key={m.id} id={m.id} text={m.text} />;
                const n = s.segNumber(m.id);
                return (
                  <section key={m.id} data-seg={m.id} className="seg-group" aria-label={`第 ${n} 段`}>
                    {m.editing ? <EditSegment m={m} /> : <SegTracks m={m} ui={ui} n={n} actions={m.items.length > 0 && <SegActions m={m} latest={m.id === s.latest?.id} busy={s.generating} />} />}
                  </section>
                );
              })}

            {s?.generating && !(s.latest && s.latest.items.length) && (
              <div aria-busy="true" aria-label="下一段生成中" className="skeleton">
                <span />
                <div>
                  <span />
                  <span />
                </div>
              </div>
            )}

            {s?.error && (
              <div role="alert" className="alert" data-testid="error">
                <span>{s.error}</span>
                <span className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn" onClick={s.retry} disabled={s.generating}>
                    重試
                  </button>
                  {s.ragFailed && (
                    <button type="button" className="btn" onClick={s.continueWithoutRag} disabled={s.generating}>
                      這段不帶參考範例繼續
                    </button>
                  )}
                  <button type="button" className="btn" onClick={goSystem}>
                    到系統核心檢查
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>

        {s && ui.mode === 'interactive' && (
          <div className="reply-dock">
          <div className="reply">
            {(s.latest?.actions.length ?? 0) > 0 && (
              <div role="group" aria-label="行動建議" className="row" style={{ gap: 6 }} data-testid="chips">
                {s.latest!.actions.map((c) => (
                  <button key={c} type="button" className="chip" aria-pressed={chip === c} onClick={() => setChip(chip === c ? null : c)}>
                    {c}
                  </button>
                ))}
              </div>
            )}
            <div className="bar">
              <label className="grow" style={{ display: 'flex' }}>
                <span className="sr-only">對{name}說</span>
                <textarea
                  className="textarea reply-input"
                  name="reply"
                  rows={1}
                  autoComplete="off"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    if (e.shiftKey) return; // Shift+Enter：原生換行
                    e.preventDefault();
                    if (e.ctrlKey || e.metaKey) setInput(input + '\n'); // Ctrl+Enter：在尾端換行（同 ADV3.0）
                    else send();
                  }}
                  placeholder={chip ? `會和「${chip}」一起送出；可以再補一句` : `對${name}說點什麼，中文或日文都行（Shift+Enter 換行）`}
                />
              </label>
              <button type="button" className="icon-btn" aria-label="按住說話（語音輸入還沒接上）" title="語音輸入還沒接上：之後用 Gemma 4 E4B 聽寫" disabled>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
                </svg>
              </button>
              <button type="button" className="btn" onClick={send} disabled={!input.trim() && !chip} style={{ minHeight: 40 }}>
                送出
              </button>
            </div>
          </div>
          </div>
        )}
      </main>
      <Panel data={data} />
    </div>
  );
}
