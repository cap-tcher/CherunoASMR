// V4 外框：頂列 4 個目的地＋角色選單＋已儲存＋重新開始；SessionRoot 包住頁面與播放列（換頁聲音不停）。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PlayBar } from './components/PlayBar.tsx';
import { BookPage, type BookTab } from './pages/Book.tsx';
import { CreatePage } from './pages/Create.tsx';
import { ListenPage } from './pages/Listen.tsx';
import { SystemPage, type SysTab } from './pages/System.tsx';
import { imageToKey } from './library.ts';
import type { SaveState } from './saveStore.ts';
import { SessionRoot, type SavedSession, type SessionInfo } from './session.tsx';
import { uid, useAppData, type AppData, type Character } from './store.ts';

type Page = 'listen' | 'create' | 'book' | 'system';
const NAV: [Page, string][] = [
  ['listen', '聆聽'],
  ['create', '建立角色'],
  ['book', '萬物之書'],
  ['system', '系統核心'],
];

interface Toast {
  msg: string;
  bad: boolean;
  undo?: () => void;
}

/** 一個打開的存檔（Root 讀好資料才掛上；資料變動交給 onData／onSession 寫回存檔區） */
export function App(props: {
  saveName: string;
  initial: AppData;
  session: SavedSession | null;
  saveState: SaveState;
  onData: (d: AppData) => void;
  onSession: (s: SavedSession) => void;
  onSaves: () => void;
  /** 備份與還原（Root 做：要先寫掉未存的、還原後重新開存檔） */
  backup: { download: () => Promise<void>; restore: (f: File) => Promise<void> };
}) {
  const [data, update] = useAppData(props.initial, props.onData);
  // 最新的台本（換角色、欄位表改過時 SessionRoot 會重掛，要拿最新的而不是開檔時那份）
  const sessionRef = useRef<SavedSession | null>(props.session);
  const active = data.characters.find((c) => c.id === data.activeId) ?? null;
  const ready = !!active?.voice;
  const [page, setPage] = useState<Page>(ready ? 'listen' : 'create');
  // 切頁不卸載（使用者 2026-11-20：在建立角色填到一半去系統核心連線，回來要還在）：看過的頁面一直掛著、只是藏起來；
  // 各頁共用同一個捲動容器，捲動位置每頁各記一份
  const [seen, setSeen] = useState<ReadonlySet<Page>>(() => new Set([page]));
  const [createKey, setCreateKey] = useState(0); // 角色建立完才換新的建立角色頁
  const viewRef = useRef<HTMLDivElement | null>(null);
  const scrollOf = useRef<Partial<Record<Page, number>>>({});
  const shownPage = useRef(page);
  useLayoutEffect(() => {
    if (!seen.has(page)) setSeen((x) => new Set([...x, page]));
    // 捲動位置在捲動當下記（切頁那一刻舊頁已藏起來、容器變短，瀏覽器已經把 scrollTop 夾成 0，來不及讀）
    shownPage.current = page;
    if (viewRef.current) viewRef.current.scrollTop = scrollOf.current[page] ?? 0;
  }, [page]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [bookTab, setBookTab] = useState<BookTab>('char');
  const [sysTab, setSysTab] = useState<SysTab>(data.settings.model ? 'intimacy' : 'conn');
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const infoRef = useRef<() => SessionInfo>(() => ({ segments: 0, first: null, last: null }));
  const toastTimer = useRef(0);

  const flash = (msg: string, bad = false, undo?: () => void) => {
    setToast({ msg, bad, ...(undo ? { undo } : {}) });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 5000 : 2600);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirm) setConfirm(false);
      else if (menu) setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, menu]);

  function restart() {
    setConfirm(false);
    const i = infoRef.current();
    if (i.segments > 0 && active) {
      const scene = data.optOn.scene ? (data.scenes.find((s) => s.id === data.activeSceneId)?.name ?? '') : '';
      const title = `${new Date().toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${scene ? `，${scene}` : ''}`;
      const mode = data.ui.mode === 'interactive' ? '互動' : data.ui.mode === 'infinite' ? '無限' : '睡眠';
      const num = data.secretFormat.fields.find((f) => f.type === 'number');
      const change = num && i.first !== null && i.last !== null ? `，${num.label} ${i.first} 到 ${i.last}` : '';
      update((d) => ({ ...d, history: [{ id: uid(), title, body: `${active.subName || active.name}，${mode}模式，${i.segments} 段${change}` }, ...d.history] }));
    }
    // 使用者決定（2026-11-19）：重新開始要重置狀態——清掉角色身上存的狀態，新對話從欄位表的初始值開始
    if (active) update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === active.id ? (({ state: _old, ...rest }) => rest)(c) : c)) }));
    sessionRef.current = null;
    setSessionKey((k) => k + 1);
    flash('已重新開始：台本與狀態都清空（狀態回到欄位表的初始值），角色、聲音、萬物之書保留');
  }

  function goCreate(c: Character | null) {
    setEditing(c);
    setPage('create');
    setMenu(false);
  }

  /** 看過的頁面才掛；不是目前這頁就藏起來（display: none，裡面的輸入、展開、候選都留著） */
  const keep = (k: Page, node: ReactNode) =>
    seen.has(k) || page === k ? (
      <div className="page-keep" style={{ display: page === k ? 'contents' : 'none' }}>
        {node}
      </div>
    ) : null;
  const sceneName = data.optOn.scene ? (data.scenes.find((s) => s.id === data.activeSceneId)?.name ?? '') : '';
  const pages = (
    <>
      {keep('listen', <ListenPage data={data} goCreate={() => goCreate(null)} goSystem={() => { setSysTab('conn'); setPage('system'); }} />)}
      {keep(
        'create',
        <CreatePage
          key={`${editing?.id ?? 'new'}-${createKey}`}
          data={data}
          editing={editing}
          toast={flash}
          onSave={(c0, then) => {
            // 角色圖存進共用庫，存檔裡只寫 key
            void (c0.image ? imageToKey(c0.image) : Promise.resolve(null)).then(
              (image) => {
                const c = { ...c0, image };
                // 沒有聲音的角色不設成聆聽中的角色（聆聽要聲音）；存完到萬物之書的角色分頁，之後在那裡設計聲音
                const go = then === 'listen' && c.voice ? 'listen' : 'book';
                update((d) => ({ ...d, characters: d.characters.some((x) => x.id === c.id) ? d.characters.map((x) => (x.id === c.id ? c : x)) : [...d.characters, c], ...(go === 'listen' ? { activeId: c.id } : {}) }));
                setEditing(null);
                setCreateKey((k) => k + 1);
                if (go === 'listen') {
                  setSessionKey((k) => k + 1);
                  setPage('listen');
                } else {
                  setBookTab('char');
                  setPage('book');
                }
                flash(go === 'listen' ? `已建立角色：${c.subName || c.name}` : `已儲存角色：${c.subName || c.name}${c.voice ? '' : '（聲音還沒設計：在角色分頁按「設計聲音」）'}`);
              },
              (e: unknown) => flash(`角色圖存不進共用庫，角色沒有存：${e instanceof Error ? e.message : String(e)}`, true),
            );
          }}
        />,
      )}
      {keep(
        'book',
        <BookPage
          data={data}
          update={update}
          tab={bookTab}
          setTab={setBookTab}
          onNewCharacter={() => goCreate(null)}
          onRedesign={(c) => goCreate(c)}
          onUse={(id) => {
            update((d) => ({ ...d, activeId: id }));
            setPage('listen');
            flash(`切換角色：${data.characters.find((c) => c.id === id)?.subName ?? ''}`);
          }}
          toast={flash}
        />,
      )}
      {keep('system', <SystemPage data={data} update={update} tab={sysTab} setTab={setSysTab} toast={flash} backup={props.backup} />)}
    </>
  );

  return (
    <div className="app">
      <header className="top">
        <div className="top-l">
          <button type="button" className="logo" aria-label="CherunoASMR，回到聆聽" onClick={() => setPage('listen')}>
            CherunoASMR
          </button>
          <nav aria-label="主要頁面" className="nav">
            {NAV.map(([k, label]) => (
              <button key={k} type="button" aria-current={page === k ? 'page' : undefined} onClick={() => (k === 'create' ? goCreate(null) : setPage(k))}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="top-r">
          {active && (
            <button type="button" className="char-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span lang="ja" className="ja">
                {active.subName || active.name}
              </span>
              {sceneName && <span className="scene">{sceneName}</span>}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="btn ghost heart"
            aria-pressed={data.ui.intimacy}
            title={data.ui.intimacy ? '親密模式：帶秘密與狀態、用親密模式提示詞（按一下切回一般模式）' : '一般模式：不帶秘密、不更新狀態（按一下切到親密模式）'}
            onClick={() => {
              update((d) => ({ ...d, ui: { ...d.ui, intimacy: !d.ui.intimacy } }));
              flash(data.ui.intimacy ? '一般模式：之後的段落不帶秘密、不更新狀態' : '親密模式：之後的段落帶秘密與狀態');
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill={data.ui.intimacy ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
            <span className="heart-label">{data.ui.intimacy ? '親密模式' : '一般模式'}</span>
          </button>
          <button type="button" className="btn ghost save-btn" title="切換或管理存檔" onClick={props.onSaves}>
            {props.saveName}
          </button>
          <span className={props.saveState.kind === 'error' ? 'saved bad-t' : 'saved'} role="status" title={props.saveState.kind === 'error' ? props.saveState.message : undefined}>
            {props.saveState.kind === 'saving' ? '儲存中…' : props.saveState.kind === 'saved' ? '已儲存' : '儲存失敗（滑過看原因）'}
          </span>
          <button type="button" className="btn ghost" disabled={!ready} onClick={() => setConfirm(true)}>
            重新開始
          </button>
        </div>
        {menu && (
          <div role="menu" aria-label="切換角色" className="menu">
            {data.characters.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                aria-current={c.id === data.activeId}
                disabled={!c.voice}
                onClick={() => {
                  update((d) => ({ ...d, activeId: c.id }));
                  setMenu(false);
                }}
              >
                <span lang="ja" className="ja">
                  {c.subName || c.name}
                </span>
                <span>{c.id === data.activeId ? '使用中' : c.voice ? '' : '聲音未鎖定'}</span>
              </button>
            ))}
            <button type="button" role="menuitem" onClick={() => goCreate(null)}>
              <span>新增角色</span>
              <span></span>
            </button>
          </div>
        )}
      </header>

      {ready ? (
        <SessionRoot key={`${sessionKey}-${active.id}-${JSON.stringify(data.secretFormat)}`} data={data} update={update} character={active} toast={flash} infoRef={infoRef} saved={sessionRef.current} onPersist={(s) => { sessionRef.current = s; props.onSession(s); }}>
          <div ref={viewRef} className={page === 'listen' ? 'view fixed' : 'view'} onScroll={(e) => (scrollOf.current[shownPage.current] = e.currentTarget.scrollTop)}>
            {pages}
          </div>
          <PlayBar data={data} update={update} onListen={page === 'listen'} goListen={() => setPage('listen')} toast={flash} />
        </SessionRoot>
      ) : (
        <div ref={viewRef} className={page === 'listen' ? 'view fixed' : 'view'} onScroll={(e) => (scrollOf.current[shownPage.current] = e.currentTarget.scrollTop)}>
            {pages}
          </div>
      )}

      {confirm && (
        <div className="scrim">
          <div role="alertdialog" aria-modal="true" aria-labelledby="restart-title" className="dialog">
            <h2 id="restart-title">重新開始這次對話？</h2>
            <p>會清掉這次的台本，角色的秘密狀態也回到欄位表的初始值；這次聆聽會記進萬物之書的歷史。角色卡、聲音、萬物之書都保留。</p>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                取消
              </button>
              <button type="button" className="btn danger" onClick={restart} autoFocus>
                重新開始
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div role="status" className={toast.bad ? 'toast bad' : 'toast'}>
          {toast.msg}
          {toast.undo && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                toast.undo!();
                setToast(null);
              }}
            >
              復原
            </button>
          )}
        </div>
      )}
    </div>
  );
}
