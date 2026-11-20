// 建立角色（V4／SCR-02）：依據（角色圖、方向提示、快速標籤）→ 角色卡（保留已填欄位；秘密照秘密生成格式）→ 聲音 3 候選 → 鎖定 → 開始聆聽。
import { useSession } from '../session.tsx';
import { CARD_TEXT_FIELDS, buildVoiceInstruct, generateCharacter, type CardTextField } from '@cheruno/core';
import { useEffect, useRef, useState } from 'react';
import { EMPTY_CHARACTER, makeCharId, shrinkImage, type AppData, type Character, type LockedVoice, endpointOf } from '../store.ts';
import { Field, Outline, Sec, type OutlineCat } from '../components/Outline.tsx';
import { imageToDataUrl, isKey, putAsset } from '../library.ts';
import { DIR, creationExtras } from '../components/CardRegen.tsx';
import { traced } from '../requestLog.ts';
import { READY_TIMEOUT, SERVICE_LABEL, serviceStatus, startTts, stopTts, unloadLms, waitTtsReady, type ServiceStatus, type TtsService } from '../services.ts';
import { registerVoice, synthesize } from '../tts.ts';

// 快速標籤一律是明確的成年人關係與情境
const ID_DEFS: [CardTextField, string, string][] = [
  ['reading', '讀み', 'みお'],
  ['subName', '字幕名', '澪'],
  ['ageSex', '年齡與性別', '20 歲，女'],
  ['relation', '與你的關係', '隔壁的大學學姊'],
  ['callName', '她怎麼叫你', 'テツくん'],
];
const TEXT_DEFS: [CardTextField, string, string][] = [
  ['appearance', '外觀', '外貌特徵、穿著打扮'],
  ['bio', '背景', '身世、動機'],
  ['personality', '性格', '性格關鍵字'],
  ['behavior', '說話方式', '說話習慣、動作特徵'],
  ['catchphrase', '口頭禪', '常掛在嘴邊的話'],
];

interface Candidate {
  id: 'A' | 'B' | 'C';
  seed: number;
  state: 'queued' | 'busy' | 'ready' | 'error' | 'cancelled';
  instruct: string; // 產生這個候選時送給 Qwen 的完整指示（鎖定時存這份，之後改表單也不影響這個聲音）
  ms?: number; // 合成花了多久
  url?: string;
  blob?: Blob;
  seconds?: number;
  error?: string;
}
type Form = Record<CardTextField, string>;

export function CreatePage(props: { data: AppData; editing: Character | null; onSave: (c: Character, then: 'listen' | 'book') => void; toast: (m: string, bad?: boolean) => void }) {
  const { data, editing } = props;
  const s = data.settings;
  const vt = data.templates.voice;
  const [form, setForm] = useState<Form>(() => Object.fromEntries(CARD_TEXT_FIELDS.map((k) => [k, (editing ?? EMPTY_CHARACTER)[k]])) as Form);
  const [image, setImage] = useState<string | null>(editing?.image && !isKey(editing.image) ? editing.image : null);
  // 存檔裡的角色圖是共用庫的 key：讀回 data URL（顯示、送 LLM 看圖都用它）
  useEffect(() => {
    if (editing?.image && isKey(editing.image)) imageToDataUrl(editing.image).then(setImage, (e: unknown) => props.toast(e instanceof Error ? e.message : String(e), true));
  }, []);
  const [drag, setDrag] = useState(false);
  const [direction, setDirection] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardErr, setCardErr] = useState('');
  const [generated, setGenerated] = useState(!!editing);
  const [trial, setTrial] = useState(`ねえ、今日もおつかれさま……目、閉じてみよっか。ふふ、いい子だね。`);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [locked, setLocked] = useState<LockedVoice | null>(null);
  const [lockedId, setLockedId] = useState<string | null>(null);
  const [voiceErr, setVoiceErr] = useState('');
  // 聲音候選要 ComfyUI（Qwen 聲音設計）；鎖定要播放用的引擎（Irodori／ZONOS）——按了才啟動（[[PLAN_服務按需啟動]]）
  const [svc, setSvc] = useState<ServiceStatus | null>(null);
  const [svcStep, setSvcStep] = useState('');
  const [svcErr, setSvcErr] = useState('');
  const refreshSvc = () => serviceStatus(s.audioBase).then(setSvc, (e: unknown) => setSvcErr(e instanceof Error ? e.message : String(e)));
  // 切頁不卸載（App 只把頁面藏起來）：每次聲音區重新出現在畫面上就重讀服務狀態，別處載入／卸載的模型才看得到
  const voiceRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = voiceRef.current;
    if (!el) return void refreshSvc();
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void refreshSvc());
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const [booting, setBooting] = useState<TtsService | ''>('');
  // Qwen 跟本機 LLM 搶顯存（使用者 2026-11-20 回報候選很慢：實測 LLM 載著時載入 78 秒、RTF 約 20；顯卡乾淨時 6.7 秒、RTF 6.7）
  const lmsLoaded = svc?.lmstudio.models.filter((m) => m.state === 'loaded').map((m) => m.id) ?? [];
  const [unloadingLms, setUnloadingLms] = useState(false);
  const session = useSession();
  async function unloadLmsForQwen() {
    setUnloadingLms(true);
    try {
      session?.stop('LM Studio 的模型卸載了（建立角色要騰顯存給 Qwen），這段已停止；要繼續就到 系統核心 › 連線 按「連線」，再按重試');
      await unloadLms(s.audioBase);
    } catch (e) {
      setSvcErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUnloadingLms(false);
      void refreshSvc();
      window.setTimeout(() => void refreshSvc(), 2000);
    }
  }
  const bootAbort = useRef<AbortController | null>(null);
  /** 啟動中＝取消啟動、就緒＝停止：都是停掉那個引擎（連啟動腳本一起停） */
  async function stopService(name: TtsService) {
    const wasBooting = booting === name;
    if (wasBooting) bootAbort.current?.abort();
    if (wasBooting) setSvcStep(`取消啟動 ${SERVICE_LABEL[name]}中…`);
    try {
      await stopTts(s.audioBase, name);
      setSvcStep(wasBooting ? `已取消啟動 ${SERVICE_LABEL[name]}` : `已停止 ${SERVICE_LABEL[name]}`);
    } catch (e) {
      setSvcErr(e instanceof Error ? e.message : String(e));
    } finally {
      void refreshSvc();
    }
  }
  async function bootService(name: TtsService) {
    setSvcErr('');
    const ctrl = new AbortController();
    bootAbort.current = ctrl;
    setBooting(name);
    try {
      const r = await startTts(s.audioBase, name);
      if (ctrl.signal.aborted) return; // 啟動請求回來前已按取消：不要蓋掉「取消中」
      const pre = r.stopped.length ? `先關掉 ${r.stopped.map((x) => SERVICE_LABEL[x as TtsService] ?? x).join('、')}；` : '';
      await waitTtsReady(s.audioBase, name, { timeoutMs: READY_TIMEOUT[name], signal: ctrl.signal, onTick: (sec) => setSvcStep(`${pre}啟動 ${SERVICE_LABEL[name]}…（${sec} 秒）`) });
      setSvcStep(`${SERVICE_LABEL[name]} 就緒`);
    } catch (e) {
      if (ctrl.signal.aborted) return; // 取消啟動：stopService 寫結果
      setSvcStep('');
      setSvcErr(e instanceof Error ? e.message : String(e));
    } finally {
      bootAbort.current = null;
      setBooting('');
      void refreshSvc();
    }
  }
  const playEngine: TtsService = s.engine === 'qwen-comfy' ? 'qwen' : s.engine;
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const charId = useRef(editing?.id ?? makeCharId(data.characters.map((c) => c.id)));

  const set = (k: CardTextField) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const hasInput = !!image || !!direction.trim() || tags.length > 0;
  const sendParts = [image ? '角色圖' : null, direction.trim() ? '方向提示' : null, tags.length ? `${tags.length} 個標籤` : null].filter(Boolean);
  const voiceBusy = cands.some((c) => c.state === 'busy' || c.state === 'queued');
  // 候選一律由 Qwen3-TTS VoiceDesign 依描述產生（[[Research_ASMR_TTS]]：Qwen 設計音色、播放引擎克隆）；描述留空用預設描述
  const voiceDesc = form.voiceDesc.trim() || vt.qwenDefault;
  // 送給 Qwen 的完整指示：聲音描述＋名字、年齡與性別、性格、說話方式（候選與鎖定用同一份）
  const voiceInstruct = buildVoiceInstruct(voiceDesc, form);
  const [busySince, setBusySince] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!busySince) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busySince]);
  const elapsed = busySince && now > busySince ? Math.floor((now - busySince) / 1000) : 0;
  const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  async function pickFile(f: File | undefined) {
    if (!f) return;
    try {
      setImage(await shrinkImage(f));
    } catch (e) {
      props.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function genCard() {
    if (!s.model) {
      setCardErr('還沒選模型：到系統核心的連線設定測試連線並選一個模型。');
      return;
    }
    setCardBusy(true);
    setCardErr('');
    try {
      const { merged, kept } = await generateCharacter({
        endpoint: endpointOf(s),
        fetchFn: traced('角色卡'),
        model: s.model,
        templates: data.templates.character,
        request: { direction, tags, imageDataUrl: image, current: form, secretTemplate: data.secretTemplate, ...creationExtras(data, { direction, tags, current: form }, null) },
      });
      setForm(merged);
      setGenerated(true);
      props.toast(kept ? `已生成角色卡，保留你填的 ${kept} 欄` : '已生成角色卡，可以直接修改');
    } catch (e) {
      setCardErr(`生成失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCardBusy(false);
    }
  }

  async function genVoice() {
    setVoiceErr('');
    setLocked(null);
    setLockedId(null);
    const list: Candidate[] = (['A', 'B', 'C'] as const).map((id) => ({ id, seed: Math.floor(Math.random() * 2 ** 31), state: 'queued', instruct: voiceInstruct }));
    setCands(list);
    setBusySince(Date.now());
    const ctrl = new AbortController();
    genAbort.current = ctrl;
    for (const [i, c] of list.entries()) {
      if (ctrl.signal.aborted) break;
      setCands((xs) => xs.map((x) => (x.id === c.id ? { ...x, state: 'busy' } : x)));
      const t0 = Date.now();
      try {
        const r = await synthesize(s.audioBase, {
          engine: 'qwen-comfy',
          text: trial,
          voice: 'normal',
          speaker: c.instruct,
          seed: c.seed,
          style: vt.qwenNormal,
          // 播放引擎不是 Qwen 時，最後一個候選產完就卸載 Qwen（約 7.9 GB），Irodori／ZONOS 才放得進 VRAM
          unload_after: s.engine !== 'qwen-comfy' && i === list.length - 1,
        }, ctrl.signal);
        setCands((xs) => xs.map((x) => (x.id === c.id ? { ...x, state: 'ready', url: r.url, blob: r.blob, seconds: r.seconds, ms: Date.now() - t0 } : x)));
      } catch (e) {
        if (ctrl.signal.aborted) break;
        const msg = e instanceof Error ? e.message : String(e);
        setCands((xs) => xs.map((x) => (x.id === c.id ? { ...x, state: 'error', error: msg } : x)));
        setVoiceErr(msg);
      }
    }
    // 中斷：還沒完成的候選標成「已中斷」（Qwen 伺服器上已開始的那一句會跑完，沒有中途停止的介面）
    if (ctrl.signal.aborted) setCands((xs) => xs.map((x) => (x.state === 'busy' || x.state === 'queued' ? { ...x, state: 'cancelled' } : x)));
    genAbort.current = null;
    setBusySince(0);
  }
  const genAbort = useRef<AbortController | null>(null);

  async function lock(c: Candidate) {
    try {
      // Qwen 播放：記描述＋seed（每句重新設計同一個聲音）；Irodori／ZONOS：把候選音登錄成參考音
      const speaker = s.engine === 'qwen-comfy' ? c.instruct : await registerVoice(s.audioBase, s.engine, charId.current, c.blob!);
      const ref = await putAsset('refvoice', 'wav', c.blob!, { desc: c.instruct, seed: c.seed, engine: 'qwen-comfy' });
      setLocked({ engine: s.engine, speaker, desc: form.voiceDesc, seed: c.seed, lockedAt: new Date().toISOString(), ref });
      setLockedId(c.id);
      props.toast(`已鎖定聲音：候選 ${c.id}`);
    } catch (e) {
      props.toast(`鎖定失敗：${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  function play(c: Candidate) {
    const a = audioRef.current!;
    a.src = c.url!;
    a.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return; // 換聽另一個候選：預期中斷
      props.toast(`無法播放：${e instanceof Error ? e.message : String(e)}`, true);
    });
  }

  const voice = locked ?? editing?.voice ?? null;
  const named = !!form.name.trim() && !!form.reading.trim();
  const ready = !!voice && named;
  const startHint = !named ? '名字與讀み要填' : !voice ? '可以先儲存角色，之後到萬物之書的角色分頁設計聲音；開始聆聽要先鎖定一個聲音' : '聲音已鎖定，可以開始';
  const draft = (): Character => ({ ...(editing ?? EMPTY_CHARACTER), ...form, id: charId.current, image, voice });

  // 三步由上往下（[[SCR-03_設定頁版面]]）：依據 → 角色卡 → 聲音；outline 是步驟
  const steps: OutlineCat<'create'>[] = [
    {
      k: 'create',
      label: '步驟',
      sections: [
        { id: 'create-basis', label: '1. 依據（圖、方向提示）' },
        { id: 'create-card', label: '2. 角色卡' },
        { id: 'create-voice', label: '3. 聲音' },
      ],
    },
  ];
  const textGroups: { title: string; keys: CardTextField[] }[] = [
    { title: '外觀與背景', keys: ['appearance', 'bio'] },
    { title: '個性與說話', keys: ['personality', 'behavior', 'catchphrase'] },
  ];

  return (
    <div className="book">
      <audio ref={audioRef} />
      <Outline title={editing ? `重新設計：${editing.subName || editing.name}` : '建立角色'} label="建立角色步驟" cats={steps} current="create" onSelect={() => {}} />
      <main className="lin-main">
        <div className="sub-head">
          <div>
            <h2>{editing ? `重新設計：${editing.subName || editing.name}` : '建立角色'}</h2>
            <p>角色圖、方向提示擇一或並用；LLM 寫好角色卡與聲音描述，你再修。</p>
          </div>
        </div>

        <Sec id="create-basis" title="1. 依據" desc="給 LLM 看的素材：一張角色圖、一句方向提示、幾個標籤，擇一或並用。">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void pickFile(e.target.files?.[0])} />
          <Field as="div" label="角色圖" hint="PNG、JPG、WebP；模型要會看圖。">
            {image ? (
              <figure className="portrait" style={{ maxWidth: 320 }}>
                <img src={image} alt="角色圖" />
                <button type="button" className="btn sm" onClick={() => setImage(null)}>
                  移除
                </button>
              </figure>
            ) : (
              <button
                type="button"
                className={drag ? 'drop drag' : 'drop'}
                style={{ maxWidth: 320 }}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  void pickFile(e.dataTransfer.files[0]);
                }}
              >
                <span>選擇或拖曳角色圖</span>
              </button>
            )}
          </Field>
          <Field label="方向提示">
            <textarea className="textarea" name="direction" rows={3} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="住隔壁的大學學姊，溫柔但有點愛捉弄人；想要很多耳邊囁き" />
          </Field>
          {DIR.map(([label, list]) => (
            <Field key={label} as="div" label={`標籤：${label}`}>
              <div className="lin-actions">
                {list.map((t) => (
                  <button key={t} type="button" className="chip" aria-pressed={tags.includes(t)} onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>
                    {t}
                  </button>
                ))}
              </div>
            </Field>
          ))}
          <div className="lin-actions">
            <button type="button" className="btn primary" disabled={!hasInput || cardBusy} onClick={() => void genCard()}>
              {cardBusy ? (image ? '正在看圖' : '正在構思') : generated ? '重新生成（保留已填欄位）' : '生成角色卡'}
            </button>
            <span className="hint">{!hasInput ? '放一張圖，或寫一句方向提示' : `送出：${sendParts.join('＋')}${generated ? '。你填過的欄位不會被覆蓋' : '。約 10 秒'}`}</span>
          </div>
          {cardErr && <div className="note danger">{cardErr}</div>}
        </Sec>

        <Sec id="create-card" title="2. 角色卡" desc="生成後在這裡修；也可以不生成直接填。名字與讀み一定要填。">
          <div className="lin-sub">
            <h4>基本</h4>
            <Field label="名字">
              <input lang="ja" className="input big" name="name" value={form.name} onChange={set('name')} placeholder="澪（みお）" />
            </Field>
            {ID_DEFS.map(([k, label, ph]) => (
              <Field key={k} label={label}>
                <input className="input" value={form[k]} onChange={set(k)} placeholder={ph} />
              </Field>
            ))}
          </div>
          {textGroups.map((g) => (
            <div key={g.title} className="lin-sub">
              <h4>{g.title}</h4>
              {g.keys.map((k) => {
                const def = TEXT_DEFS.find((x) => x[0] === k)!;
                return (
                  <Field key={k} label={def[1]}>
                    <textarea className="textarea" rows={3} value={form[k]} onChange={set(k)} placeholder={def[2]} />
                  </Field>
                );
              })}
            </div>
          ))}
          <div className="lin-sub">
            <h4>秘密</h4>
            <label className="field secret-field">
              <span>角色的秘密（只給 LLM，不會念出來）</span>
              <textarea className="textarea" rows={4} value={form.secret} onChange={set('secret')} placeholder={data.secretTemplate.trim() ? `依秘密生成格式：\n${data.secretTemplate}` : '只有她知道的事'} />
            </label>
          </div>
        </Sec>

        <Sec id="create-voice" title="3. 聲音" desc="依描述產生 3 個候選，試聽後鎖定一個；之後每句都用鎖定的聲音。">
          <span ref={voiceRef} aria-hidden="true" />
          <Field label="聲音描述（日文，可改）">
            <textarea lang="ja" className="textarea" rows={2} value={form.voiceDesc} onChange={set('voiceDesc')} placeholder={`留空時用：${vt.qwenDefault}`} />
          </Field>
          <Field label="試聽句">
            <textarea lang="ja" className="textarea" rows={2} value={trial} onChange={(e) => setTrial(e.target.value)} />
          </Field>
          {lmsLoaded.length > 0 && (
            <div className="note caution note-act" role="status" data-testid="qwen-vram-warn">
              <span>
                LM Studio 載著 {lmsLoaded.join('、')}：Qwen 產生候選要約 5.5 GB 顯存，兩個一起放不下 8 GB，會溢到主記憶體、慢 3 倍以上（實測載入 7 秒變 80 秒、生成慢 3 倍）。先卸載再產生候選，之後要寫台詞時到 系統核心 › 連線 再按「連線」。
              </span>
              <button type="button" className="btn sm" disabled={unloadingLms} onClick={() => void unloadLmsForQwen()}>
                {unloadingLms ? '卸載中' : '卸載 LLM'}
              </button>
            </div>
          )}
          <Field
            as="div"
            label="候選"
            hint={
              s.engine === 'qwen-comfy'
                ? '候選由 Qwen3 VoiceDesign 依描述產生（Qwen 聲音設計要開著）；鎖定後每句都用同一描述＋seed 合成。這台電腦顯卡沒被別的模型佔著時，每秒音長約 7 秒合成'
                : `候選由 Qwen3 VoiceDesign 依描述產生（Qwen 聲音設計要開著）。顯卡沒被別的模型佔著時：載入約 7 秒、每秒音長約 7 秒合成（預設試聽句約 10 秒音長 → 一個約 70 秒）；產完會卸載 Qwen，再開 ${s.engine === 'zonos' ? 'ZONOS' : 'Irodori'} 按鎖定，候選音會登錄成之後每句的聲音`
            }
          >
            <div className="lin-actions">
              <button type="button" className="btn" disabled={!voiceDesc || voiceBusy || !trial.trim()} onClick={() => void genVoice()}>
                {voiceBusy ? `生成中（${cands.filter((c) => c.state === 'ready' || c.state === 'error').length}/3，${mmss(elapsed)}）` : cands.length ? '再生成 3 個' : '生成 3 個候選'}
              </button>
              {voiceBusy && (
                <button type="button" className="btn" title="停掉還沒完成的候選（Qwen 正在合成的那一句會在背景跑完）" onClick={() => genAbort.current?.abort()}>
                  中斷
                </button>
              )}
            </div>
          </Field>
          <Field as="div" label="需要的服務" hint={playEngine === 'qwen' ? '候選與每句都由 Qwen 聲音設計產生。' : `候選要 Qwen 聲音設計；鎖定時候選音登錄到 ${SERVICE_LABEL[playEngine]}。Qwen 產生候選時整張卡約用到 5.5 GB：和 ${SERVICE_LABEL[playEngine]}（約 1.5 GB）一起放得下，本機 LLM 也載入著就放不下。`}>
            <div className="lin-actions">
              {(playEngine === 'qwen' ? (['qwen'] as const) : (['qwen', playEngine] as const)).map((n) =>
                booting === n || svc?.[n].running ? (
                  <button key={n} type="button" className="btn sm" title={booting === n ? `停掉正在啟動的 ${SERVICE_LABEL[n]}` : `${SERVICE_LABEL[n]} ${svc?.[n].ready ? '就緒' : '載入中'}；按了關掉，模型移出顯存`} onClick={() => void stopService(n)}>
                    {booting === n ? `取消啟動 ${SERVICE_LABEL[n]}` : `停止 ${SERVICE_LABEL[n]}`}
                  </button>
                ) : (
                  <button key={n} type="button" className="btn sm" disabled={!!booting} title={booting ? '另一個服務正在啟動' : undefined} onClick={() => void bootService(n)}>
                    啟動 {SERVICE_LABEL[n]}
                  </button>
                ),
              )}
              {svcStep && <span className="hint">{svcStep}</span>}
              {svcErr && <span className="hint bad-t">{svcErr}</span>}
            </div>
          </Field>
          {voiceErr && <div className="note danger">聲音生成失敗：{voiceErr}</div>}
          {cands.map((c) => (
            <div key={c.id} className="lin-sub">
              <div className="lin-sec-head">
                <h4>候選 {c.id}</h4>
                <div className="lin-actions">
                  <button type="button" className="btn sm" aria-label={`試聽候選 ${c.id}`} disabled={c.state !== 'ready'} onClick={() => play(c)}>
                    播放
                  </button>
                  <button type="button" className="btn sm" aria-pressed={lockedId === c.id} disabled={c.state !== 'ready'} onClick={() => void lock(c)}>
                    {lockedId === c.id ? '已鎖定' : '鎖定'}
                  </button>
                </div>
              </div>
              <span className="lin-hint num">
                {c.state === 'queued' ? '排隊中' : c.state === 'busy' ? '合成中' : c.state === 'cancelled' ? '已中斷' : c.state === 'error' ? <span className="bad-t">{c.error}</span> : `${c.seconds?.toFixed(1)} 秒音檔，seed ${c.seed}，合成 ${mmss(Math.round((c.ms ?? 0) / 1000))}`}
              </span>
            </div>
          ))}
          {editing?.voice && !locked && <p className="hint">目前的聲音：{editing.voice.engine}，seed {editing.voice.seed}。重新鎖定會取代。</p>}
          <div className="lin-actions" style={{ justifyContent: 'flex-end' }}>
            <span className="hint">{startHint}</span>
            <button type="button" className="btn" disabled={!named} title={named ? '存進萬物之書（不用先設計聲音）' : '名字與讀み要填'} onClick={() => props.onSave(draft(), 'book')}>
              儲存角色
            </button>
            <button type="button" className="btn primary" disabled={!ready} onClick={() => props.onSave(draft(), 'listen')}>
              開始聆聽
            </button>
          </div>
        </Sec>
      </main>
    </div>
  );
}
