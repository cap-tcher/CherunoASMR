// 萬物之書（V4：頁面＋左側子導覽）。回憶的「AI 整理」＝Chapter Manager（ADV3.0 handleAutoGenerateChapters）。
import { CardRegen } from '../components/CardRegen.tsx';
import { initialSnapshot, latestChapter, organizeChapters, unprocessed, validateManual, type CardTextField, type Chapter, type GlossaryEntry } from '@cheruno/core';
import { useRef, useState } from 'react';
import { humanStateError, useSession } from '../session.tsx';
import { Grip, useDragSort } from '../components/DragSort.tsx';
import { Field, Outline, Sec, type OutlineCat } from '../components/Outline.tsx';
import { download, importCharacter, toCCv3, uid, type AppData, type Character, type OptKey, endpointOf } from '../store.ts';
import { traced } from '../requestLog.ts';
import { fetchAsset } from '../library.ts';
import { registerVoice } from '../tts.ts';

export type BookTab = 'user' | 'char' | 'scene' | 'glossary' | 'memory' | 'history' | 'world';

const TABS: { k: BookTab; label: string; title: string; desc: string; opt: boolean }[] = [
  { k: 'user', label: '主角', title: '主角', desc: '她怎麼叫你、字幕怎麼顯示你', opt: false },
  { k: 'char', label: '角色', title: '角色', desc: '每個角色＝角色卡＋鎖定的聲音；可匯出 SillyTavern 角色卡（CCv3）', opt: false },
  { k: 'scene', label: '情境', title: '情境', desc: '音床、空間與常用音效；停用時由 LLM 從音效庫自由挑', opt: true },
  { k: 'glossary', label: '圖鑑', title: '名詞圖鑑', desc: '常駐的每段都帶；其餘在最近 3 則或你這次說的話裡出現表記、讀み、譯名或同義詞才帶，並一起帶一層關聯條目', opt: true },
  { k: 'memory', label: '回憶', title: '回憶', desc: '最新一章、釘選、沒有關鍵字的章每段都帶；其餘看最近 3 則或你的話裡有沒有出現關鍵字', opt: true },
  { k: 'history', label: '歷史', title: '聆聽紀錄', desc: '重新開始時記一筆；啟用後最近 3 筆會帶進 prompt', opt: true },
  { k: 'world', label: '世界觀', title: '世界觀', desc: '需要特殊設定時才寫', opt: true },
];

// 角色卡欄位依用途分組，展開後由上往下排（[[SCR-03_設定頁版面]]）
const CARD_GROUPS: { title: string; fields: [CardTextField, string, 'line' | 'text'][] }[] = [
  { title: '基本', fields: [['name', '名字', 'line'], ['reading', '讀み', 'line'], ['subName', '字幕名', 'line'], ['ageSex', '年齡與性別', 'line'], ['relation', '與你的關係', 'line']] },
  { title: '外觀與背景', fields: [['appearance', '外觀', 'text'], ['bio', '背景', 'text']] },
  { title: '個性與說話', fields: [['personality', '性格', 'text'], ['behavior', '說話方式', 'text'], ['catchphrase', '口頭禪', 'text']] },
];

const ENGINE_LABEL: Record<string, string> = { zonos: 'ZONOS', irodori: 'Irodori', 'qwen-comfy': 'Qwen 聲音設計' };

export function BookPage(props: {
  data: AppData;
  update: (f: (d: AppData) => AppData) => void;
  tab: BookTab;
  setTab: (t: BookTab) => void;
  onNewCharacter: () => void;
  onRedesign: (c: Character) => void;
  onUse: (id: string) => void;
  toast: (m: string, bad?: boolean, undo?: () => void) => void;
}) {
  const { data, update, tab } = props;
  const cur = TABS.find((t) => t.k === tab)!;
  // Qwen 鎖定的聲音轉成播放用的引擎（使用者 2026-11-20：鎖定時引擎還是 Qwen，每句都要 Qwen 合成、很慢；Qwen 沒開就全部合成失敗）。
  // 用鎖定時存進共用庫的候選音（voice.ref）登錄到系統核心選的引擎，描述與 seed 照舊
  const [converting, setConverting] = useState('');
  async function convertVoice(c: Character) {
    const v = c.voice;
    const target = data.settings.engine;
    if (!v?.ref || target === 'qwen-comfy') return;
    setConverting(c.id);
    try {
      const blob = await fetchAsset('refvoice', v.ref);
      if (!blob) throw new Error('共用庫裡找不到鎖定時的候選音，要重新設計聲音');
      const speaker = await registerVoice(data.settings.audioBase, target, c.id, blob);
      props.update((d) => ({ ...d, characters: d.characters.map((x) => (x.id === c.id ? { ...x, voice: { ...v, engine: target, speaker, lockedAt: new Date().toISOString() } } : x)) }));
      props.toast(`${c.subName || c.name} 的聲音改用 ${ENGINE_LABEL[target]}；聆聽頁合成失敗的句子按一下就會重新合成`);
    } catch (e) {
      props.toast(`轉換失敗：${e instanceof Error ? e.message : String(e)}（${ENGINE_LABEL[target]} 要先在 系統核心 › 連線 啟動）`, true);
    } finally {
      setConverting('');
    }
  }
  const [openChar, setOpenChar] = useState<string | null>(null);
  const [scribing, setScribing] = useState(false);
  const [scribeErr, setScribeErr] = useState('');
  const optKey = cur.opt ? (tab as OptKey) : null;
  const upd = <K extends keyof AppData>(k: K, v: AppData[K]) => update((d) => ({ ...d, [k]: v }));

  const charFile = useRef<HTMLInputElement>(null);
  const charSort = useDragSort(data.characters, (l) => upd('characters', l));
  const glossSort = useDragSort(data.glossary, (l) => upd('glossary', l));
  /** 刪除＋5 秒復原 */
  function removeWithUndo<K extends 'scenes' | 'glossary' | 'chapters' | 'history' | 'characters'>(k: K, keep: (x: AppData[K][number]) => boolean, label: string) {
    const before = data[k];
    update((d) => ({ ...d, [k]: (d[k] as AppData[K][number][]).filter(keep) }));
    props.toast(`已刪除${label}，5 秒內可復原`, false, () => update((d) => ({ ...d, [k]: before })));
  }

  async function aiScribe() {
    setScribeErr('');
    const s = data.settings;
    if (!s.model) {
      setScribeErr('還沒選模型：到系統核心的連線設定測試連線並選一個模型。');
      return;
    }
    const auto = data.chapters.filter((c) => !c.pinned);
    const pending = unprocessed(auto, data.log);
    if (!pending.length) {
      setScribeErr('還沒有可以整理的聆聽紀錄。聽幾段之後再按。');
      return;
    }
    setScribing(true);
    try {
      const next = await organizeChapters({ endpoint: endpointOf(s), fetchFn: traced('回憶整理'), model: s.model, chapters: auto, transcript: data.log, templates: data.templates.chapters });
      // 整理只看沒釘選的章節，新章節的 id 會從那批的最大值往上編；改成接在「所有章節」的最大 id 之後，避免撞到釘選記憶
      const autoIds = new Set(auto.map((c) => c.id));
      let nextId = data.chapters.reduce((m, c) => Math.max(m, c.id), 0) + 1;
      const renumbered = next.map((c) => (autoIds.has(c.id) ? c : { ...c, id: nextId++ }));
      update((d) => ({ ...d, chapters: [...d.chapters.filter((c) => c.pinned), ...renumbered] }));
      const latest = latestChapter(next);
      props.toast(`已整理到第 ${latest?.range.end ?? 0} 段，共 ${next.length} 章`);
    } catch (e) {
      setScribeErr(`整理失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScribing(false);
    }
  }

  const setChar = (id: string, k: CardTextField, v: string) => upd('characters', data.characters.map((c) => (c.id === id ? { ...c, [k]: v } : c)));
  const setGloss = (i: number, p: Partial<GlossaryEntry>) => upd('glossary', data.glossary.map((g, j) => (j === i ? { ...g, ...p } : g)));
  const setChapter = (id: number, p: Partial<Chapter>) => upd('chapters', data.chapters.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const notes: Partial<Record<BookTab, string>> = {
    char: `${data.characters.length} 位`,
    glossary: data.optOn.glossary ? `${data.glossary.length} 條` : '停用',
    memory: data.optOn.memory ? `${data.chapters.length} 則` : '停用',
    scene: data.optOn.scene ? '啟用' : '停用',
    history: data.optOn.history ? '啟用' : '停用',
    world: data.optOn.world ? '啟用' : '停用',
  };

  const cats: OutlineCat<BookTab>[] = TABS.map((t) => ({
    k: t.k,
    label: t.label,
    ...(notes[t.k] ? { note: notes[t.k] } : {}),
    sections: t.k === 'user' ? [{ id: 'user-name', label: '稱呼' }, { id: 'user-about', label: '外觀與介紹' }] : t.k === 'char' ? data.characters.map((c) => ({ id: `char-${c.id}`, label: c.subName || c.name || '未命名' })) : [],
  }));

  return (
    <div className="book">
      <Outline title="萬物之書" label="萬物之書分類" cats={cats} current={tab} onSelect={(k) => props.setTab(k)} />
      <section aria-label={cur.title} className="lin-main">
        <div className="sub-head">
          <div>
            <h2>{cur.title}</h2>
            <p>{cur.desc}</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {optKey && (
              <button
                type="button"
                className="btn"
                aria-pressed={data.optOn[optKey]}
                onClick={() => {
                  upd('optOn', { ...data.optOn, [optKey]: !data.optOn[optKey] });
                  props.toast(`${data.optOn[optKey] ? '已停用' : '已啟用'}${cur.title}`);
                }}
              >
                {data.optOn[optKey] ? '已啟用' : '已停用'}
              </button>
            )}
            {tab === 'char' && (
              <>
                <button type="button" className="btn" onClick={() => charFile.current?.click()}>
                  匯入角色
                </button>
                <button type="button" className="btn" onClick={props.onNewCharacter}>
                  新增角色
                </button>
                <input
                  ref={charFile}
                  type="file"
                  accept="application/json"
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                      const r = importCharacter(JSON.parse(await f.text()), data.characters.map((c) => c.id), data.secretFormat);
                      upd('characters', [...data.characters, r.character]);
                      props.toast(`已匯入 ${r.character.name}${r.note ? `：${r.note}` : ''}`);
                    } catch (err) {
                      props.toast(`匯入失敗：${err instanceof Error ? err.message : String(err)}`, true);
                    }
                  }}
                />
              </>
            )}
            {tab === 'scene' && (
              <button type="button" className="btn" onClick={() => upd('scenes', [...data.scenes, { id: uid(), name: '新情境', desc: '' }])}>
                新增情境
              </button>
            )}
            {tab === 'glossary' && (
              <button type="button" className="btn" onClick={() => upd('glossary', [...data.glossary, { term: '', reading: '', subName: '', synonyms: [], related: [], note: '', always: false }])}>
                新增條目
              </button>
            )}
            {tab === 'memory' && (
              <>
                <button type="button" className="btn" onClick={() => upd('chapters', [...data.chapters, { id: data.chapters.reduce((m, c) => Math.max(m, c.id), 0) + 1, title: '新的記憶', summary: '', keywords: [], range: { start: data.logSeq || 1, end: data.logSeq || 1 }, pinned: true }])}>
                  新增記憶
                </button>
                <button type="button" className="btn primary" disabled={scribing} onClick={() => void aiScribe()}>
                  {scribing ? '整理中' : 'AI 整理'}
                </button>
              </>
            )}
          </div>
        </div>

        {tab === 'user' && (
          <>
            <Sec id="user-name" title="稱呼" desc="她怎麼叫你、字幕怎麼顯示你。">
              <Field label="你的名字">
                <input lang="ja" className="input big" value={data.protagonist.name} onChange={(e) => upd('protagonist', { ...data.protagonist, name: e.target.value })} />
              </Field>
              {(
                [
                  ['reading', '讀み', '名字的平假名讀音（TTS 照這個念）'],
                  ['callName', '她怎麼叫你', '例：テツくん'],
                  ['subName', '字幕名', '字幕裡顯示的名字'],
                ] as const
              ).map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint}>
                  <input className="input" value={data.protagonist[k]} onChange={(e) => upd('protagonist', { ...data.protagonist, [k]: e.target.value })} />
                </Field>
              ))}
            </Sec>
            <Sec id="user-about" title="外觀與介紹" desc="她看得到、知道的你。">
              <Field label="性別">
                <input className="input" value={data.protagonist.gender} onChange={(e) => upd('protagonist', { ...data.protagonist, gender: e.target.value })} />
              </Field>
              <Field label="外觀" hint="身高、髮型、常穿的衣服……">
                <textarea className="textarea" rows={3} value={data.protagonist.appearance} onChange={(e) => upd('protagonist', { ...data.protagonist, appearance: e.target.value })} />
              </Field>
              <Field label="關於你">
                <textarea className="textarea" rows={4} value={data.protagonist.bio} onChange={(e) => upd('protagonist', { ...data.protagonist, bio: e.target.value })} />
              </Field>
            </Sec>
          </>
        )}

        {tab === 'char' &&
          (data.characters.length === 0 ? (
            <div className="empty">
              <p>還沒有角色</p>
              <p>按「新增角色」從角色圖或方向提示開始。</p>
            </div>
          ) : (
            data.characters.map((c, ci) => (
              <div key={c.id} id={`char-${c.id}`} className="card lin-sec" {...charSort.row(ci)}>
                <div className="card-head">
                  <span className="row" style={{ gap: 10 }}>
                    <Grip {...charSort.handle(ci)} />
                    <span lang="ja" className="ja" style={{ fontSize: 18 }}>
                      {c.name || '未命名'}
                    </span>
                    <span className="hint">{data.activeId === c.id ? '使用中' : ''}</span>
                    <span className={c.voice ? 'hint ok-t' : 'hint'}>{c.voice ? `聲音已鎖定（${ENGINE_LABEL[c.voice.engine] ?? c.voice.engine}）` : '聲音未鎖定'}</span>
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn sm" aria-expanded={openChar === c.id} onClick={() => setOpenChar(openChar === c.id ? null : c.id)}>
                      {openChar === c.id ? '收合' : '編輯'}
                    </button>
                    <button type="button" className="btn sm" onClick={() => props.onRedesign(c)}>
                      {c.voice ? '重新設計聲音' : '設計聲音'}
                    </button>
                    {c.voice?.engine === 'qwen-comfy' && c.voice.ref && data.settings.engine !== 'qwen-comfy' && (
                      <button type="button" className="btn sm" disabled={!!converting} title={`用鎖定時的候選音登錄到 ${ENGINE_LABEL[data.settings.engine]}，之後每句即時合成（現在每句都要 Qwen、很慢）`} onClick={() => void convertVoice(c)}>
                        {converting === c.id ? '轉換中' : `聲音轉成 ${ENGINE_LABEL[data.settings.engine]}`}
                      </button>
                    )}
                    <button type="button" className="btn sm" disabled={data.activeId === c.id || !c.voice} onClick={() => props.onUse(c.id)}>
                      {data.activeId === c.id ? '使用中' : '切換到這個角色'}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        download(`${c.subName || c.id}.ccv3.json`, JSON.stringify(toCCv3(c), null, 2));
                        props.toast(`已匯出 ${c.subName || c.name}.ccv3.json（不含回憶）`);
                      }}
                    >
                      匯出
                    </button>
                    <button type="button" className="btn sm ghost" onClick={() => removeWithUndo('characters', (x) => (x as Character).id !== c.id, ` ${c.subName || c.name}`)}>
                      刪除
                    </button>
                  </span>
                </div>
                {openChar === c.id && (
                  <>
                    {CARD_GROUPS.map((g) => (
                      <div key={g.title} className="lin-sub">
                        <h4>{g.title}</h4>
                        {g.fields.map(([k, label, kind]) => (
                          <Field key={k} label={label}>
                            {kind === 'line' ? (
                              <input className="input" lang={k === 'name' || k === 'reading' ? 'ja' : undefined} value={c[k]} onChange={(e) => setChar(c.id, k, e.target.value)} />
                            ) : (
                              <textarea className="textarea" rows={3} value={c[k]} onChange={(e) => setChar(c.id, k, e.target.value)} />
                            )}
                          </Field>
                        ))}
                      </div>
                    ))}
                    <div className="lin-sub">
                      <h4>秘密</h4>
                      <label className="field secret-field">
                        <span>角色的秘密（只給 LLM，不會念出來）</span>
                        <textarea className="textarea" rows={4} value={c.secret} onChange={(e) => setChar(c.id, 'secret', e.target.value)} />
                      </label>
                    </div>
                    <CardRegen data={data} c={c} toast={props.toast} onMerged={(f) => update((d) => ({ ...d, characters: d.characters.map((x) => (x.id === c.id ? { ...x, ...f } : x)) }))} />
                    <div className="lin-sub">
                      <h4>秘密狀態</h4>
                    <StateJson data={data} c={c} update={update} toast={props.toast} />
                    </div>
                  </>
                )}
              </div>
            ))
          ))}

        {tab === 'scene' && (
          <div className="table-wrap">
            <table className="table edit">
              <colgroup><col style={{ width: 180 }} /><col /><col style={{ width: 88 }} /><col style={{ width: 72 }} /></colgroup>
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>說明</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.scenes.map((sc) => (
                  <tr key={sc.id}>
                    <td>
                      <input className="input cell" aria-label="情境名稱" value={sc.name} onChange={(e) => upd('scenes', data.scenes.map((x) => (x.id === sc.id ? { ...x, name: e.target.value } : x)))} />
                    </td>
                    <td>
                      <textarea className="textarea cell" aria-label="說明" placeholder="音景、空間、常用音效" value={sc.desc} onChange={(e) => upd('scenes', data.scenes.map((x) => (x.id === sc.id ? { ...x, desc: e.target.value } : x)))} />
                    </td>
                    <td className="c">
                      {data.activeSceneId === sc.id ? (
                        <span className="ok-t">使用中</span>
                      ) : (
                        <button type="button" className="btn sm" onClick={() => upd('activeSceneId', sc.id)}>
                          使用
                        </button>
                      )}
                    </td>
                    <td className="act">
                      <button type="button" className="btn sm ghost" onClick={() => removeWithUndo('scenes', (x) => (x as { id: string }).id !== sc.id, `情境「${sc.name}」`)}>
                        刪除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'glossary' && (
          <div className="table-wrap">
            <table className="table edit" style={{ minWidth: 930 }}>
              <colgroup><col style={{ width: 32 }} /><col style={{ width: 110 }} /><col style={{ width: 120 }} /><col style={{ width: 100 }} /><col style={{ width: 130 }} /><col style={{ width: 130 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 64 }} /></colgroup>
              <thead>
                <tr>
                  <th aria-label="排序"></th>
                  <th>表記</th>
                  <th>讀み</th>
                  <th>字幕譯名</th>
                  <th>同義詞</th>
                  <th>關聯條目</th>
                  <th>說明</th>
                  <th>帶入</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.glossary.map((g, i) => (
                  <tr key={i} {...glossSort.row(i)}>
                    <td className="c">
                      <Grip {...glossSort.handle(i)} />
                    </td>
                    <td>
                      <input lang="ja" className="input cell" aria-label="表記" value={g.term} onChange={(e) => setGloss(i, { term: e.target.value })} />
                    </td>
                    <td>
                      <input lang="ja" className="input cell" aria-label="讀み" value={g.reading} onChange={(e) => setGloss(i, { reading: e.target.value })} />
                    </td>
                    <td>
                      <input className="input cell" aria-label="字幕譯名" value={g.subName} onChange={(e) => setGloss(i, { subName: e.target.value })} />
                    </td>
                    <td>
                      <ListCell label="同義詞" placeholder="用、分隔" value={g.synonyms} onChange={(v) => setGloss(i, { synonyms: v })} />
                    </td>
                    <td>
                      <ListCell label="關聯條目" placeholder="命中時一起帶" value={g.related} onChange={(v) => setGloss(i, { related: v })} />
                    </td>
                    <td>
                      <textarea className="textarea cell" aria-label="說明" placeholder="給 LLM 的說明" value={g.note} onChange={(e) => setGloss(i, { note: e.target.value })} />
                    </td>
                    <td className="c">
                      <button type="button" className="btn sm toggle" aria-pressed={g.always} title={g.always ? '每段都帶；再按一次改成關鍵字出現才帶' : '關鍵字出現才帶；再按一次改成每段都帶'} onClick={() => setGloss(i, { always: !g.always })}>
                        {g.always ? '常駐' : '關鍵字'}
                      </button>
                    </td>
                    <td className="act">
                      <button type="button" className="btn sm ghost" onClick={() => removeWithUndo('glossary', (x) => x !== g, `「${g.term}」`)}>
                        刪除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'memory' && (
          <>
            <p className="hint">
              AI 整理：把「最新一章起點之後」的聆聽紀錄交給 LLM，延續最新一章或開新章（標題、摘要、關鍵字、範圍）。目前記了 {data.log.length} 段，最新一章到第 {latestChapter(data.chapters.filter((c) => !c.pinned))?.range.end ?? 0} 段。釘選的記憶不會被整理覆蓋。
            </p>
            {scribeErr && <div className="note danger">{scribeErr}</div>}
            <div className="table-wrap">
              <table className="table edit">
                <colgroup><col style={{ width: 180 }} /><col /><col style={{ width: 170 }} /><col style={{ width: 112 }} /><col style={{ width: 104 }} /><col style={{ width: 72 }} /></colgroup>
                <thead>
                  <tr>
                    <th>標題</th>
                    <th>摘要</th>
                    <th>關鍵字</th>
                    <th>範圍</th>
                    <th>釘選</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.chapters]
                    .sort((a, b) => a.range.start - b.range.start)
                    .map((c) => (
                      <tr key={c.id}>
                        <td>
                          <textarea className="textarea cell" aria-label="標題" placeholder="標題" value={c.title} onChange={(e) => setChapter(c.id, { title: e.target.value.replace(/\n/g, '') })} />
                        </td>
                        <td>
                          <textarea className="textarea cell" aria-label="摘要" placeholder="還沒有摘要" value={c.summary} onChange={(e) => setChapter(c.id, { summary: e.target.value })} />
                        </td>
                        <td>
                          <input className="input cell" aria-label="關鍵字（用、分隔）" placeholder="空白＝每段都帶" value={c.keywords.join('、')} onChange={(e) => setChapter(c.id, { keywords: e.target.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) })} />
                        </td>
                        <td className="c num">
                          第 {c.range.start}～{c.range.end} 段
                        </td>
                        <td className="c">
                          <button type="button" className="btn sm toggle" aria-pressed={c.pinned} onClick={() => setChapter(c.id, { pinned: !c.pinned })}>
                            {c.pinned ? '釘選' : '不釘選'}
                          </button>
                        </td>
                        <td className="act">
                          <button type="button" className="btn sm ghost" onClick={() => removeWithUndo('chapters', (x) => (x as Chapter).id !== c.id, `「${c.title}」`)}>
                            刪除
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'history' &&
          (data.history.length === 0 ? (
            <div className="empty">
              <p>還沒有紀錄</p>
              <p>按頂列「重新開始」時，這次的聆聽會記在這裡。</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table edit">
                <colgroup><col style={{ width: 200 }} /><col /><col style={{ width: 72 }} /></colgroup>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id}>
                      <td className="txt">{h.title}</td>
                      <td className="txt" style={{ color: 'var(--color-ink-2)' }}>{h.body}</td>
                      <td className="act">
                        <button type="button" className="btn sm ghost" onClick={() => removeWithUndo('history', (x) => (x as { id: string }).id !== h.id, '這筆紀錄')}>
                          刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {tab === 'world' && <textarea className="textarea" rows={12} aria-label="世界觀" value={data.world} placeholder="需要時再寫；大多數 ASMR 用不到。" onChange={(e) => upd('world', e.target.value)} />}

        {tab !== 'user' && tab !== 'world' && <p className="hint">點欄位直接改；變更自動儲存。刪除 5 秒內可復原。</p>}
      </section>
    </div>
  );
}

/** 角色卡裡的秘密狀態 JSON（ADV3.0 F-38）：改完按「存狀態」；格式不合就顯示原因、不存。正在聆聽的角色直接改進這次的時間軸。 */
function StateJson({ data, c, update, toast }: { data: AppData; c: Character; update: (f: (d: AppData) => AppData) => void; toast: (m: string, bad?: boolean) => void }) {
  const s = useSession();
  const live = s && s.character.id === c.id;
  const current = live ? s.panel.snap : (c.state ?? initialSnapshot(data.secretFormat));
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const text = draft ?? JSON.stringify(current, null, 2);
  function save() {
    let snap: unknown;
    try {
      snap = JSON.parse(text);
    } catch (e) {
      setErr(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (live) {
      const e = s.editState(snap as never);
      if (e) return setErr(humanStateError(e, data.secretFormat.fields, c.id));
    } else {
      try {
        const ok = validateManual(data.secretFormat, c.id, snap as never);
        update((d) => ({ ...d, characters: d.characters.map((x) => (x.id === c.id ? { ...x, state: ok } : x)) }));
      } catch (e) {
        return setErr(humanStateError(e instanceof Error ? e.message : String(e), data.secretFormat.fields, c.id));
      }
    }
    setErr('');
    setDraft(null);
    toast('秘密狀態已存');
  }
  return (
    <div className="field">
      <span>秘密狀態（JSON；照秘密規則的欄位表）</span>
      <textarea className="textarea mono" rows={8} spellCheck={false} value={text} onChange={(e) => setDraft(e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" disabled={draft === null} onClick={save}>
          存狀態
        </button>
        {draft !== null && (
          <button type="button" className="btn sm ghost" onClick={() => { setDraft(null); setErr(''); }}>
            放棄修改
          </button>
        )}
        {err && <span className="bad-t" style={{ fontSize: 13 }}>{err}</span>}
      </div>
    </div>
  );
}

/** 用「、」分隔的清單欄位：打字時保留原文（含結尾的「、」），存成陣列 */
function ListCell({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      className="textarea cell"
      aria-label={label}
      placeholder={placeholder}
      value={draft ?? value.join('、')}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
