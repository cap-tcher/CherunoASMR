// 系統核心（V4：頁面＋左側子導覽）。秘密規則可匯入匯出（ADV3.0 配置／存檔只取規則相關欄位）；提示詞分頁列出程式裡全部的提示詞。
import { ToneTable } from '../components/ToneTable.tsx';
import { useSession } from '../session.tsx';
import {
  DEFAULT_TEMPLATES,
  RulesImportError,
  SecretFormatError,
  TEMPLATE_META,
  checkInclude,
  checkTemplates,
  exportRules,
  fieldsFromDefinitions,
  importRules,
  resolveLayout,
  testConnection,
  GEMINI_BASE,
  OPENAI_BASE,
  chatModels,
  initialSnapshot,
  StateTimeline,
  type Snapshot,
  validateFormat,
  type ConnectionResult,
  type PanelBlock,
  type PromptTemplates,
  type SecretFormat,
  type StateField,
} from '@cheruno/core';
import { useEffect, useRef, useState } from 'react';
import { AiFlow } from '../components/AiFlow.tsx';
import { CodexHomePicker } from '../components/CodexHomePicker.tsx';
import { Check, Field, Outline, Sec, type OutlineCat } from '../components/Outline.tsx';
import { FieldRow, blankField } from '../components/FieldEditor.tsx';
import { RequestLog } from '../components/RequestLog.tsx';
import { AppLog } from '../components/AppLog.tsx';
import { traced } from '../requestLog.ts';
import { download, type AppData, type Engine, endpointOf, ZONE_MAP_FIELD } from '../store.ts';
import { READY_TIMEOUT, SERVICE_LABEL, isLocalLms, loadLmsModel, serviceStatus, startLms, startTts, stopTts, unloadLms, waitTtsReady, type ServiceStatus, type TtsService } from '../services.ts';

// 照功能地圖分類（[[SCR-03_設定頁版面]]）：每個分類是 outline 第一層，sections 是第二層（Sec 的 id）
export type SysTab = 'conn' | 'gen' | 'prompt' | 'intimacy' | 'templates' | 'flow' | 'log' | 'applog' | 'data';
const CAT_INFO: Record<SysTab, { label: string; desc: string; group: string }> = {
  conn: { label: '連線', desc: '一個 LLM（OpenAI 相容端點）＋一個 TTS 引擎', group: '設定' },
  gen: { label: '生成方式', desc: '每段寫多長、帶多少前文、狀態怎麼更新、時鐘與睡眠模式', group: '設定' },
  prompt: { label: '一般模式', desc: '一般模式（沒按愛心）每段都帶的規則與第一段的開場', group: '設定' },
  intimacy: { label: '親密模式', desc: '親密模式的提示詞，以及秘密狀態：定義、欄位表、面板怎麼顯示；整套可匯入匯出', group: '設定' },
  templates: { label: '提示詞模板', desc: '程式裡每一段送給 LLM 的文字，依用途分類；用 {{變數}} 代入，某行的變數全空時整行省略', group: '設定' },
  flow: { label: 'AI 流程', desc: '照目前設定：每段台詞從聽者輸入到播放，每一站收什麼、做什麼、交出什麼', group: '檢查' },
  log: { label: '請求紀錄', desc: '送給模型的每一個請求（這個存檔最近 100 筆）：送給誰、送了什麼、收到什麼；點一列展開，巢狀資料可以一層層打開', group: '檢查' },
  applog: { label: 'App 紀錄', desc: 'app 自己做了什麼的經過（這個存檔最近 500 筆）：送出、生成、重連、每句的合成與播放、暫停與繼續', group: '檢查' },
  data: { label: '資料', desc: '這個存檔的備份與還原', group: '資料' },
};
const TPL_SUB: { k: string; label: string; test: (key: string) => boolean }[] = [
  { k: 'sec', label: '段落標題', test: (k) => /^sec/.test(k) },
  { k: 'body', label: '內容格式', test: (k) => /^(card|listener|scene|glossaryItem|listItem|secretGenBody|clockBody)$/.test(k) },
  { k: 'field', label: '狀態欄位說明', test: (k) => /^(field|names)/.test(k) },
  { k: 'out', label: '輸出格式', test: (k) => /^(output|outputState|stateAsk|stateAskSecret|translation)/.test(k) },
  { k: 'mode', label: '模式指令', test: (k) => /^(mode|sleepDefault)/.test(k) },
];
const KIND: Record<ConnectionResult['kind'], string> = { ok: '已連線', invalid_key: 'API key 無效', rate_limited: '請求太頻繁', timeout: '逾時', network: '連不上', http_error: 'HTTP 錯誤' };
const ENGINES: Record<Engine, string> = { irodori: 'Irodori-TTS v4.1-Small（日文，囁き）', zonos: 'ZONOS3-Mini（快，每句即時合成）', 'qwen-comfy': 'Qwen3-TTS VoiceDesign（慢，適合設計聲音）' };
const ENGINE_SERVICE: Record<Engine, TtsService> = { irodori: 'irodori', zonos: 'zonos', 'qwen-comfy': 'qwen' };
const BLOCK_LABEL: Record<PanelBlock['type'], string> = { section: '分段（任何欄位）', bars: '數值條', rows: '欄位列', tags: '標籤', zones: '可疊加清單', kv: '數值表', text: '文字', secret: '遮住的文字' };

const UNLOAD_STOP = 'LM Studio 的模型卸載了，這段已停止（不然斷線重連會把模型載回來）；要繼續就到 系統核心 › 連線 按「連線」，再按重試';

export function SystemPage(props: { data: AppData; update: (f: (d: AppData) => AppData) => void; tab: SysTab; setTab: (t: SysTab) => void; toast: (m: string, bad?: boolean) => void; backup: { download: () => Promise<void>; restore: (f: File) => Promise<void> } }) {
  const { data, update, tab } = props;
  const s = data.settings;
  const [conn, setConn] = useState<ConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  // 按需啟動（[[PLAN_服務按需啟動]]）：每一步的進度與錯誤
  const [llmStep, setLlmStep] = useState('');
  const [llmErr, setLlmErr] = useState('');
  const [ttsStep, setTtsStep] = useState('');
  const [ttsErr, setTtsErr] = useState('');
  const [ttsBusy, setTtsBusy] = useState(false);
  const [svc, setSvc] = useState<ServiceStatus | null>(null);
  const [svcErr, setSvcErr] = useState('');
  const [fmt, setFmt] = useState<SecretFormat>(data.secretFormat);
  const [fmtErr, setFmtErr] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genLayout, setGenLayout] = useState<PanelBlock[] | null>(null); // 由狀態定義產生的分段，按「套用欄位表」時一起寫進面板版面
  const [importMsg, setImportMsg] = useState('');
  const [tpl, setTpl] = useState<PromptTemplates>(data.templates);
  const [incDraft, setIncDraft] = useState<Record<number, string>>({});
  const [incErr, setIncErr] = useState<Record<number, string>>({});
  const rulesFile = useRef<HTMLInputElement>(null);
  const backupFile = useRef<HTMLInputElement>(null);
  const setS = <K extends keyof AppData['settings']>(k: K, v: AppData['settings'][K]) => update((d) => ({ ...d, settings: { ...d.settings, [k]: v } }));
  const setRag = <K extends keyof AppData['settings']['rag']>(k: K, v: AppData['settings']['rag'][K]) => update((d) => ({ ...d, settings: { ...d.settings, rag: { ...d.settings.rag, [k]: v } } }));
  // RAG 索引清單（音訊服務 /rag/collections）：進「生成方式」分頁時讀
  const [ragCols, setRagCols] = useState<{ name: string; chunks: number; embed: { backend: string; model: string | null } }[] | null>(null);
  const [ragErr, setRagErr] = useState('');
  const [ragAbsent, setRagAbsent] = useState(false); // 音訊服務沒有 /rag（公開版目前不附 RAG）
  const [ragBusy, setRagBusy] = useState(''); // 匯入中的說明（空＝沒在匯入）
  const ragFile = useRef<HTMLInputElement>(null);
  const ragBase = () => s.audioBase.replace(/\/+$/, '');
  const detailOf = async (r: Response) => {
    const t = await r.text();
    try {
      return String((JSON.parse(t) as { detail?: unknown }).detail ?? t);
    } catch {
      return t || `HTTP ${r.status}`;
    }
  };
  /** 匯入索引（[[PLAN_RAG索引匯入]]）：zip 檔名＝索引名稱；音訊服務解壓、確認讀得起來才放進 data\rag\out */
  async function importRag(f: File | undefined) {
    if (!f) return;
    const name = f.name.replace(/\.zip$/i, '');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setRagErr(`zip 的檔名就是索引名稱，只能用英數字、- 和 _：「${f.name}」改個檔名再匯入`);
      return;
    }
    setRagErr('');
    setRagBusy(`正在匯入 ${name}（${(f.size / 1048576).toFixed(1)} MB）…`);
    try {
      const r = await fetch(`${ragBase()}/rag/import?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
      if (!r.ok) throw new Error(await detailOf(r));
      const j = (await r.json()) as { chunks: number };
      refreshRag();
      setRag('collection', name);
      props.toast(`已匯入索引 ${name}（${j.chunks} 個片段），已選用`);
    } catch (e) {
      setRagErr(`匯入失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRagBusy('');
    }
  }
  async function openRagFolder() {
    setRagErr('');
    try {
      const r = await fetch(`${ragBase()}/rag/open-folder`, { method: 'POST' });
      if (!r.ok) throw new Error(await detailOf(r));
      props.toast('已用檔案總管開啟索引資料夾；放好索引後按「重新整理」');
    } catch (e) {
      setRagErr(`開不了資料夾：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const refreshRag = () => {
    setRagErr('');
    fetch(`${s.audioBase.replace(/\/+$/, '')}/rag/collections`)
      .then((r) => {
        setRagAbsent(r.status === 404);
        return r.ok ? r.json() : r.status === 404 ? { collections: [] } : Promise.reject(new Error(`HTTP ${r.status}`));
      })
      .then((j: { collections: NonNullable<typeof ragCols> }) => setRagCols(j.collections))
      .catch((e: unknown) => setRagErr(`讀不到索引清單：${e instanceof Error ? e.message : String(e)}`));
  };
  useEffect(() => {
    if (tab === 'gen') refreshRag();
  }, [tab]);
  const tplProblems = checkTemplates(tpl);
  const tplDirty = JSON.stringify(tpl) !== JSON.stringify(data.templates);
  const fmtDirty = JSON.stringify(fmt) !== JSON.stringify(data.secretFormat);

  const refreshSvc = () =>
    serviceStatus(s.audioBase).then(
      (x) => {
        setSvc(x);
        setSvcErr('');
      },
      (e: unknown) => setSvcErr(e instanceof Error ? e.message : String(e)),
    );
  useEffect(() => {
    if (tab === 'conn') void refreshSvc();
  }, [tab, s.audioBase]);

  /** LLM 連線：本機 LM Studio → 開 server、讀清單、載入模型；雲端 → 測試連線並卸載 LM Studio 的模型（騰顯存） */
  async function connectLlm(model = s.model) {
    setTesting(true);
    setLlmErr('');
    const local = isLocalLms(s.llmBase);
    try {
      if (local) {
        setLlmStep('啟動 LM Studio server…');
        await startLms(s.audioBase);
      }
      setLlmStep('讀模型清單…');
      // 本機 LM Studio 剛啟動時第一次讀清單會超過 8 秒（2026-11-20 乾淨環境實測：第一次按連線就逾時），本機給 60 秒
      const r = await testConnection(endpointOf(s), { fetchFn: traced('連線測試'), ...(local ? { timeoutMs: 60_000 } : {}) });
      setConn(r);
      if (r.kind !== 'ok') {
        setLlmStep('');
        return;
      }
      // 改用雲端或其他端點：先卸載 LM Studio 的模型（跟選哪個模型無關，本機模型不用了就不佔顯存與主記憶體）
      const unloaded = local ? false : (await unloadLms(s.audioBase)).unloaded;
      const freed = unloaded ? '；LM Studio 的模型已卸載，顯存留給 TTS' : '';
      // 選的模型不在這個端點的清單裡：不自動換別的（之前自動挑清單第一個，載入了沒選的大模型、塞爆記憶體），請使用者自己選
      if (!r.models.includes(model)) {
        setLlmStep(freed ? `已連線${freed}` : '');
        setLlmErr(model ? `這個端點沒有「${model}」，從下面的模型清單選一個` : '從下面的模型清單選一個模型');
        return;
      }
      if (local) {
        setLlmStep(`載入 ${model}…（第一次約 30 秒）`);
        setLoadingModel(model);
        const l = await loadLmsModel(s.audioBase, model).finally(() => setLoadingModel(''));
        setLlmStep(l.already ? `${model} 已經載入` : `已載入 ${model}${l.unloaded?.length ? `（卸載了 ${l.unloaded.join('、')}）` : ''}`);
      } else setLlmStep(`已連線${freed}`);
    } catch (e) {
      setLlmStep('');
      if (cancelledLoad.current) setLlmStep(`已取消載入 ${model}；換模型或按「連線」重新載入`);
      else setLlmErr(e instanceof Error ? e.message : String(e));
      cancelledLoad.current = false;
    } finally {
      setTesting(false);
      // LM Studio 的模型清單在 lms load 回來後還要一下子才更新：馬上讀一次、2 秒後再讀一次
      void refreshSvc();
      window.setTimeout(() => void refreshSvc(), 2000);
    }
  }
  // 卸載／停止（使用者 2026-11-20：連線之後要有手段收掉；載入中也要能取消，不用等載完）
  const [offBusy, setOffBusy] = useState('');
  const session = useSession(); // 還沒有角色時是 null
  const [loadingModel, setLoadingModel] = useState('');
  const ttsName: TtsService = s.engine === 'qwen-comfy' ? 'qwen' : s.engine;
  // 伺服器上的載入／啟動狀態：別的頁面（例如電腦按的、這邊是 iPad）按的也顯示、也能取消
  const serverLoad = svc?.lmstudio.loading ?? null;
  const loadName = loadingModel || serverLoad?.model || '';
  const ttsStarting = !!svc && svc[ttsName].running && !svc[ttsName].ready;
  useEffect(() => {
    if (tab !== 'conn' || !(serverLoad || loadingModel || ttsStarting || ttsBusy)) return;
    const t = window.setInterval(() => void refreshSvc(), 2000);
    return () => window.clearInterval(t);
  }, [tab, !!serverLoad, loadingModel, ttsStarting, ttsBusy]);
  // 取消的是別的頁面按的載入：伺服器回報不在載入了，就把「取消載入 X…」換成結果（自己按的由 connectLlm 寫）
  const lastLoad = useRef('');
  useEffect(() => {
    if (serverLoad) lastLoad.current = serverLoad.model;
    else if (lastLoad.current && !loadingModel) {
      if (llmStep.startsWith('取消載入')) setLlmStep(`已取消載入 ${lastLoad.current}`);
      lastLoad.current = '';
    }
  }, [serverLoad?.model, loadingModel]);
  const cancelledLoad = useRef(false);
  /** 取消載入＝載入中請 LM Studio 卸載（實測會中止載入；那次載入請求回「已取消」） */
  async function cancelLoad() {
    cancelledLoad.current = true;
    session?.stop(UNLOAD_STOP);
    setLlmStep(`取消載入 ${loadName}…`);
    try {
      await unloadLms(s.audioBase);
    } catch (e) {
      cancelledLoad.current = false;
      setLlmErr(e instanceof Error ? e.message : String(e));
    }
  }
  const loadedModels = svc?.lmstudio.models.filter((m) => m.state === 'loaded').map((m) => m.id) ?? [];
  async function offload(what: 'lms' | TtsService) {
    setOffBusy(what);
    setSvcErr('');
    try {
      if (what === 'lms') {
        // 先停掉正在生成的段落：不然那段收到「Model unloaded」會斷線重連，LM Studio 收到請求又自動把模型載回來（使用者 2026-11-20 回報卸載不了）
        session?.stop(UNLOAD_STOP);
        await unloadLms(s.audioBase);
        setLlmStep('已卸載 LM Studio 的模型；要再用本機模型時按「連線」');
      } else {
        await stopTts(s.audioBase, what);
        setTtsStep(`已停止 ${SERVICE_LABEL[what]}`);
      }
    } catch (e) {
      setSvcErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOffBusy('');
      void refreshSvc();
      window.setTimeout(() => void refreshSvc(), 2000); // LM Studio 的清單卸載後要一下子才更新
    }
  }
  /** TTS 連線：啟動選的引擎並等它就緒（ZONOS 與 Irodori 互斥，伺服器端會先關另一個） */
  const ttsAbort = useRef<AbortController | null>(null);
  /** 取消啟動＝停掉正在啟動的引擎（連啟動腳本一起停）並結束等待 */
  async function cancelTts() {
    ttsAbort.current?.abort();
    setTtsStep(`取消中…`);
    try {
      await stopTts(s.audioBase, ttsName);
      setTtsStep(`已取消啟動 ${SERVICE_LABEL[ttsName]}`);
    } catch (e) {
      setTtsErr(e instanceof Error ? e.message : String(e));
    } finally {
      void refreshSvc();
    }
  }
  async function connectTts() {
    const name = ttsName;
    const label = SERVICE_LABEL[name];
    const ctrl = new AbortController();
    ttsAbort.current = ctrl;
    setTtsBusy(true);
    setTtsErr('');
    try {
      const r = await startTts(s.audioBase, name);
      if (ctrl.signal.aborted) return; // 啟動請求回來前已按取消：不要蓋掉「取消中」
      const pre = r.stopped.length ? `先關掉 ${r.stopped.map((x) => SERVICE_LABEL[x as TtsService] ?? x).join('、')}（顯存只放得下一個）；` : '';
      setTtsStep(r.already ? `${pre}${label} 已經在跑，等它就緒…` : `${pre}啟動 ${label}…`);
      await waitTtsReady(s.audioBase, name, { timeoutMs: READY_TIMEOUT[name], signal: ctrl.signal, onTick: (sec) => setTtsStep(`${pre}啟動 ${label}…（${sec} 秒）`) });
      setTtsStep(`${label} 就緒`);
    } catch (e) {
      if (ctrl.signal.aborted) return; // 取消啟動：cancelTts 寫結果
      setTtsStep('');
      setTtsErr(e instanceof Error ? e.message : String(e));
    } finally {
      ttsAbort.current = null;
      setTtsBusy(false);
      void refreshSvc();
    }
  }
  function editField(i: number, nf: StateField | null) {
    const next = { fields: nf ? fmt.fields.map((f, j) => (j === i ? nf : f)) : fmt.fields.filter((_, j) => j !== i) };
    setFmt(next);
    try {
      validateFormat(next);
      setFmtErr('');
    } catch (e) {
      setFmtErr(e instanceof SecretFormatError ? e.message : String(e));
    }
  }
  function applyFormat() {
    try {
      validateFormat(fmt);
      // 角色存著的狀態跟著新欄位表：新欄位用初始值、原本有的保留、刪掉的不帶；驗證不過的角色維持原樣（聆聽頁會說明怎麼處理）
      const migrate = (st: Snapshot): Snapshot => {
        const next = initialSnapshot(fmt);
        for (const f of fmt.fields) if (st[f.key] !== undefined) next[f.key] = st[f.key]!;
        try {
          new StateTimeline(fmt, ['x']).setBase('x', next);
          return next;
        } catch {
          return st;
        }
      };
      update((d) => ({ ...d, secretFormat: fmt, ...(genLayout ? { layout: genLayout } : {}), characters: d.characters.map((c) => (c.state ? { ...c, state: migrate(c.state) } : c)) }));
      setGenLayout(null);
      props.toast('欄位表已套用；角色的狀態補上新欄位（初始值），這次對話會重新開始');
    } catch (e) {
      setFmtErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function genFields() {
    if (!s.model) {
      setFmtErr('還沒選模型：到連線設定測試連線並選一個模型。');
      return;
    }
    setGenBusy(true);
    try {
      const r = await fieldsFromDefinitions({ endpoint: endpointOf(s), fetchFn: traced('欄位表'), model: s.model, definitions: data.statDefs, system: data.templates.fields.system });
      setFmt(r.format);
      setGenLayout(r.layout.length ? r.layout : null);
      setFmtErr('');
      const secs = r.layout.filter((b) => b.type === 'section').length;
      props.toast(`產生了 ${r.format.fields.length} 個欄位${secs ? `、${secs} 個分段` : ''}，確認後按「套用欄位表」${secs ? '（分段會一起套用到面板版面）' : ''}`);
    } catch (e) {
      setFmtErr(`產生失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenBusy(false);
    }
  }
  async function importRulesFile(f: File | undefined) {
    if (!f) return;
    try {
      const r = importRules(JSON.parse(await f.text()));
      const c = r.config;
      update((d) => ({
        ...d,
        rulesName: c.name ?? d.rulesName,
        prompts: c.rules !== undefined ? { ...d.prompts, system: c.rules } : d.prompts,
        statDefs: c.definitions ?? d.statDefs,
        secretTemplate: c.secretFormat ?? d.secretTemplate,
        layout: c.layout ?? d.layout,
        secretFormat: c.fields ? { fields: c.fields } : d.secretFormat,
        intimacy: { system: c.intimacySystem ?? d.intimacy.system, script: c.intimacyScript ?? d.intimacy.script },
      }));
      if (c.fields) setFmt({ fields: c.fields });
      const src = r.source === 'cheruno' ? 'CherunoASMR 設定檔' : r.source === 'adv-config' ? 'ADV3.0 匯出配置' : 'ADV3.0 存檔（只取規則，角色與對話沒有讀）';
      setImportMsg(`已匯入：${src}。${r.needsFields ? '這個檔沒有欄位表（ADV3.0 只有文字定義）：按「由狀態定義產生欄位」產生，確認後套用。' : ''}`);
    } catch (e) {
      setImportMsg('');
      props.toast(`匯入失敗：${e instanceof RulesImportError || e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  const [backupBusy, setBackupBusy] = useState('');
  async function doBackup() {
    setBackupBusy('download');
    try {
      await props.backup.download();
      props.toast('已下載備份：資料、對話、角色圖與候選音都在裡面');
    } catch (e) {
      props.toast(`備份失敗：${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBackupBusy('');
    }
  }
  async function restoreBackup(f: File | undefined) {
    if (!f) return;
    setBackupBusy('restore');
    try {
      await props.backup.restore(f); // 成功會重新開存檔，這頁會換掉
    } catch (e) {
      props.toast(`還原失敗：${e instanceof Error ? e.message : String(e)}`, true);
      setBackupBusy('');
    }
  }

  const layout: PanelBlock[] = data.layout.length ? data.layout : resolveLayout([], data.secretFormat.fields).map((b) => ({ type: b.type, title: b.title, fields: [] }));
  const setLayout = (l: PanelBlock[]) => update((d) => ({ ...d, layout: l }));

  // 提示詞模板：每段生成依用途分子類，其餘每個群組一個區塊
  const segKeys = Object.keys(TEMPLATE_META.segment.items);
  const segSubs = [...TPL_SUB.map((x) => ({ ...x, keys: segKeys.filter((k) => x.test(k)) })), { k: 'other', label: '其他', test: () => false, keys: segKeys.filter((k) => !TPL_SUB.some((x) => x.test(k))) }].filter((x) => x.keys.length);
  type TplSection = { id: string; label: string; group: keyof PromptTemplates; keys: string[]; title: string; desc: string };
  const tplSections: TplSection[] = (Object.keys(TEMPLATE_META) as (keyof PromptTemplates)[]).flatMap((g): TplSection[] => {
    const meta = TEMPLATE_META[g];
    const keys = Object.keys(meta.items);
    if (g === 'segment') return segSubs.map((x) => ({ id: `tpl-segment-${x.k}`, label: `每段生成：${x.label}`, group: g, keys: x.keys, title: `${meta.title}：${x.label}`, desc: meta.desc }));
    return [{ id: `tpl-${g}`, label: meta.title, group: g, keys, title: meta.title, desc: meta.desc }];
  });

  const cats: OutlineCat<SysTab>[] = [
    { k: 'conn', ...CAT_INFO.conn, note: s.model ? '已設定' : '未設定', sections: [{ id: 'conn-llm', label: 'LLM' }, { id: 'conn-tts', label: '語音合成' }] },
    { k: 'gen', ...CAT_INFO.gen, sections: [{ id: 'gen-lines', label: '每段長度' }, { id: 'gen-context', label: '上下文' }, { id: 'gen-state', label: '狀態更新' }, { id: 'gen-clock', label: '故事時鐘' }, { id: 'gen-rag', label: '參考範例' }, { id: 'gen-tone', label: '語氣對照' }, { id: 'gen-sleep', label: '睡眠模式' }] },
    { k: 'prompt', ...CAT_INFO.prompt, sections: [{ id: 'prompt-system', label: '系統核心規則' }, { id: 'prompt-opening', label: '開場劇本' }] },
    { k: 'intimacy', ...CAT_INFO.intimacy, note: data.rulesName, sections: [{ id: 'int-prompt', label: '親密模式提示詞' }, { id: 'int-defs', label: '狀態定義' }, { id: 'int-fields', label: '欄位表' }, { id: 'int-layout', label: '面板版面' }, { id: 'int-file', label: '規則設定檔' }] },
    { k: 'templates', ...CAT_INFO.templates, note: tplDirty ? '未儲存' : '', sections: tplSections.map((x) => ({ id: x.id, label: x.label })) },
    { k: 'flow', ...CAT_INFO.flow, sections: [] },
    { k: 'log', ...CAT_INFO.log, sections: [] },
    { k: 'applog', ...CAT_INFO.applog, sections: [] },
    { k: 'data', ...CAT_INFO.data, sections: [] },
  ];
  const info = CAT_INFO[tab];
  const wide = tab === 'flow' || tab === 'log' || tab === 'applog';

  return (
    <div className="book">
      <Outline title="系統核心" label="系統核心分類" cats={cats} current={tab} onSelect={(k) => props.setTab(k)} />
      <section aria-label={info.label} className={wide ? 'lin-main' : 'lin-main'} style={wide ? { maxWidth: 1100 } : undefined}>
        <div className="sub-head">
          <div>
            <h2>{info.label}</h2>
            <p>{info.desc}</p>
          </div>
        </div>

        {tab === 'conn' && (
          <>
            <Sec
              id="conn-llm"
              title="LLM"
              desc="寫台詞與狀態的模型。LM Studio 是 http://localhost:1234/v1（用 lms server start --cors 開），Ollama 是 http://localhost:11434/v1；Claude 經本機音訊服務轉接。"
              aside={
                <span className={conn?.kind === 'ok' ? 'hint ok-t' : conn ? 'hint bad-t' : 'hint'} data-testid="conn-result">
                  {conn ? KIND[conn.kind] : '還沒測試'}
                </span>
              }
            >
              <Field as="div" label="快速填入">
                <div className="lin-actions">
                  <button type="button" className="btn sm" onClick={() => setS('llmBase', 'http://localhost:1234/v1')}>
                    LM Studio
                  </button>
                  <button type="button" className="btn sm" onClick={() => setS('llmBase', `${s.audioBase.replace(/\/+$/, '')}/claude/v1`)}>
                    Claude（經本機音訊服務）
                  </button>
                  <button type="button" className="btn sm" title="用本機的 Codex CLI（要先安裝並登入）；用哪個 CODEX_HOME 在下面的「Codex 設定資料夾」選。每段在獨立的唯讀沙盒跑、不能執行指令，約 10 秒一段、不逐字串流" onClick={() => setS('llmBase', `${s.audioBase.replace(/\/+$/, '')}/codex/v1`)}>
                    Codex（經本機音訊服務）
                  </button>
                  <button type="button" className="btn sm" title="Google AI Studio 的金鑰（aistudio.google.com/apikey）填到下面的 API key，再按「連線」選模型" onClick={() => setS('llmBase', GEMINI_BASE)}>
                    Gemini
                  </button>
                  <button type="button" className="btn sm" title="OpenAI 的金鑰（platform.openai.com/api-keys）填到下面的 API key，再按「連線」選模型" onClick={() => setS('llmBase', OPENAI_BASE)}>
                    OpenAI
                  </button>
                </div>
              </Field>
              <Field label="Base URL">
                <input className="input" value={s.llmBase} onChange={(e) => setS('llmBase', e.target.value)} />
              </Field>
              <Field label="API key" hint="本機模型與 Codex 留空；Claude 填 Anthropic 金鑰。存在存檔區的 settings.json，匯出備份時不帶。">
                <input className="input" type="password" value={s.apiKey} onChange={(e) => setS('apiKey', e.target.value)} />
              </Field>
              {s.llmBase.includes('/codex/') && (
                <Field as="div" label="Codex 設定資料夾" hint="Codex 連線用哪個 CODEX_HOME（登入資訊、模型、指示檔都在裡面）；這台電腦的所有存檔共用。">
                  <CodexHomePicker audioBase={s.audioBase} />
                </Field>
              )}
              <Field as="div" label="連線" hint={isLocalLms(s.llmBase) ? '本機 LM Studio：按下才開 LM Studio server、讀模型清單、把選的模型載入顯存（其他模型卸載）。' : '雲端或其他端點：測試連線；LM Studio 有載入模型的話會卸載，顯存留給 TTS。'}>
                <div className="lin-actions">
                  <button type="button" className="btn primary" onClick={() => void connectLlm()} disabled={testing || !!serverLoad} title={serverLoad ? `正在載入 ${serverLoad.model}：先取消或等它好` : undefined}>
                    {testing ? '連線中' : '連線'}
                  </button>
                  {loadName ? (
                    <button type="button" className="btn" title={`中止載入 ${loadName}（LM Studio 會停下來並清掉載到一半的模型）`} onClick={() => void cancelLoad()}>
                      取消載入
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={testing || offBusy === 'lms' || !loadedModels.length}
                      title={loadedModels.length ? `從顯存和主記憶體卸載 ${loadedModels.join('、')}` : 'LM Studio 現在沒有載入模型'}
                      onClick={() => void offload('lms')}
                    >
                      {offBusy === 'lms' ? '卸載中' : '卸載模型'}
                    </button>
                  )}
                  {llmStep && <span className="hint">{llmStep}</span>}
                  {serverLoad && !loadingModel && !llmStep.startsWith('取消') && (
                    <span className="hint" data-testid="server-loading">
                      {serverLoad.seconds === null ? `LM Studio 正在載入 ${serverLoad.model}（不是從這裡按的，可能卡住了；可以按「取消載入」）` : `載入 ${serverLoad.model} 中…（${serverLoad.seconds} 秒；在別的頁面按的）`}
                    </span>
                  )}
                  {llmErr && <span className="hint bad-t">{llmErr}</span>}
                  {conn && conn.kind !== 'ok' && (
                    <span className="hint bad-t">
                      {conn.message}
                      {'hint' in conn && conn.hint ? `（${conn.hint}）` : ''}
                    </span>
                  )}
                  {conn?.kind === 'ok' && !llmStep && <span className="hint">讀到 {conn.models.length} 個模型</span>}
                </div>
              </Field>
              <Field label="模型" hint={conn?.kind === 'ok' ? undefined : '先測試連線就能從清單選，也可以直接輸入模型 id。'}>
                {conn?.kind === 'ok' ? (
                  <select
                    className="select"
                    value={s.model}
                    disabled={testing}
                    onChange={(e) => {
                      setS('model', e.target.value);
                      setLlmErr(''); // 選了清單裡的模型：「這個端點沒有…」的提示不再成立
                      if (isLocalLms(s.llmBase) && e.target.value) void connectLlm(e.target.value); // 本機：選了就載入
                    }}
                  >
                    <option value="">選一個</option>
                    {chatModels(s.llmBase, conn.models).map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input className="input" value={s.model} placeholder="模型 id" onChange={(e) => setS('model', e.target.value)} />
                )}
              </Field>
              <Check checked={s.noThinking} onChange={(v) => setS('noThinking', v)} label="關掉模型的「思考」" hint="Gemma 4 這類會先想很久才回答的模型要勾（送 reasoning_effort: none）；Claude 不受影響。" />
              <div className="lin-pair">
                <Field label="溫度" hint="越高越有變化，越低越穩定。">
                  <input className="input num" type="number" step="0.05" min="0" max="2" value={s.temperature} onChange={(e) => setS('temperature', Number(e.target.value))} />
                </Field>
                <Field label="最大輸出 token" hint="一段（含狀態）最多寫多長。">
                  <input className="input num" type="number" step="100" min="400" max="8000" value={s.maxTokens} onChange={(e) => setS('maxTokens', Number(e.target.value))} />
                </Field>
              </div>
            </Sec>

            <Sec id="conn-tts" title="語音合成" desc="把台詞念出來的本機引擎；全部本機、免費。">
              <Field label="音訊服務" hint="本機的音訊服務（也負責存檔區與 Claude 轉接）。">
                <input className="input" value={s.audioBase} onChange={(e) => setS('audioBase', e.target.value)} />
              </Field>
              <Field label="引擎" hint="聲音在建立角色時鎖定；換引擎後要到萬物之書的角色分頁重新設計聲音。">
                <select className="select" value={s.engine} onChange={(e) => setS('engine', e.target.value as Engine)}>
                  {/* 沒裝的引擎不列（目前選的照樣列出、標「沒裝」，免得選單空白） */}
                  {(Object.keys(ENGINES) as Engine[])
                    .filter((k) => !svc || svc[ENGINE_SERVICE[k]].installed || k === s.engine)
                    .map((k) => (
                      <option key={k} value={k}>
                        {ENGINES[k]}
                        {svc && !svc[ENGINE_SERVICE[k]].installed ? '（沒裝）' : ''}
                      </option>
                    ))}
                </select>
              </Field>
              <Field as="div" label="連線" hint="按下才啟動選的引擎（ZONOS 與 Irodori 二選一，開一個會關另一個）；Irodori 載入模型要 2～3 分鐘。">
                <div className="lin-actions">
                  <button type="button" className="btn primary" disabled={ttsBusy || ttsStarting} onClick={() => void connectTts()}>
                    {ttsBusy ? '啟動中' : `連線（啟動 ${SERVICE_LABEL[ttsName]}）`}
                  </button>
                  {ttsBusy || ttsStarting ? (
                    <button type="button" className="btn" title={`停掉正在啟動的 ${SERVICE_LABEL[ttsName]}（連啟動腳本一起停）`} onClick={() => void cancelTts()}>
                      取消啟動
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={offBusy === ttsName || !svc?.[ttsName].running}
                      title={svc?.[ttsName].running ? `關掉 ${SERVICE_LABEL[ttsName]}，模型移出顯存` : `${SERVICE_LABEL[ttsName]} 現在沒有啟動`}
                      onClick={() => void offload(ttsName)}
                    >
                      {offBusy === ttsName ? '停止中' : `停止 ${SERVICE_LABEL[ttsName]}`}
                    </button>
                  )}
                  {ttsStep && <span className="hint">{ttsStep}</span>}
                  {ttsErr && <span className="hint bad-t">{ttsErr}</span>}
                  {svc && !svc[ttsName].installed && <span className="hint bad-t">{SERVICE_LABEL[ttsName]} 還沒裝好（缺 {svc[ttsName].missing}）：關掉後執行 startserver.bat setup 選裝</span>}
                </div>
              </Field>
              <Field as="div" label="目前狀態" hint="開著的服務都在這裡收：TTS 引擎按「停止」關掉程式，LM Studio 按「卸載模型」把模型移出顯存與主記憶體。">
                {svcErr && <span className="hint bad-t">{svcErr}</span>}
                {svc ? (
                  <ul className="svc-list">
                    {(['zonos', 'irodori', 'qwen'] as const).filter((n) => svc[n].installed || svc[n].running).map((n) => (
                      <li key={n}>
                        <span>{SERVICE_LABEL[n]}</span>
                        <span className={svc[n].ready ? 'hint ok-t' : 'hint'} data-testid="audio-health">
                          {svc[n].ready ? '就緒' : svc[n].running ? '載入中' : '沒有啟動'}
                        </span>
                        {svc[n].running && (
                          <button type="button" className="btn sm" disabled={offBusy === n} onClick={() => void offload(n)}>
                            {offBusy === n ? '停止中' : '停止'}
                          </button>
                        )}
                      </li>
                    ))}
                    <li>
                      <span>LM Studio</span>
                      <span className={loadedModels.length ? 'hint ok-t' : 'hint'}>{svc.lmstudio.running ? (loadedModels.length ? `載入 ${loadedModels.join('、')}` : 'server 開著，沒有載入模型') : '沒開'}</span>
                      {loadedModels.length > 0 && (
                        <button type="button" className="btn sm" disabled={offBusy === 'lms'} onClick={() => void offload('lms')}>
                          {offBusy === 'lms' ? '卸載中' : '卸載模型'}
                        </button>
                      )}
                    </li>
                  </ul>
                ) : (
                  !svcErr && <span className="hint">讀取中…</span>
                )}
                <div className="lin-actions">
                  <button type="button" className="btn sm ghost" onClick={() => void refreshSvc()}>
                    重新整理
                  </button>
                </div>
              </Field>
              {svc?.irodori.installed && <Field label={<>Irodori 取樣步數　<span className="num">{s.irodoriSteps} 步</span></>} hint="越少越快、音質越粗。這台 GTX 1070 實測一句 2～4 秒的台詞：16 步約 3.8 秒合成完（播放幾乎不停頓），24 步約 5 秒，40 步約 7 秒（句與句之間會停）。只對 Irodori 有效。">
                <input type="range" className="range" min={8} max={40} step={4} value={s.irodoriSteps} aria-valuetext={`${s.irodoriSteps} 步`} onChange={(e) => setS('irodoriSteps', Number(e.target.value))} />
              </Field>}
              <Field as="div" label="其他音訊">
                <span className="lin-hint">音效：和所屬那句台詞同時開始，WebAudio 程序合成 6 種、左右定位（之後可換成錄音素材）。語音輸入、混音與響度（KU100 雙耳定位、−20 LUFS）：還沒接上，現在直接播放 TTS 原音。</span>
              </Field>
            </Sec>
          </>
        )}

        {tab === 'gen' && (
          <>
            <Sec id="gen-lines" title="每段長度" desc="一次生成幾句台詞。">
              <div className="lin-pair">
                <Field label="最少">
                  <input className="input num" type="number" min={1} max={20} value={s.linesMin} onChange={(e) => { const v = Math.min(20, Math.max(1, Math.round(Number(e.target.value)))); update((d) => ({ ...d, settings: { ...d.settings, linesMin: v, linesMax: Math.max(v, d.settings.linesMax) } })); }} />
                </Field>
                <Field label="最多">
                  <input className="input num" type="number" min={1} max={20} value={s.linesMax} onChange={(e) => { const v = Math.min(20, Math.max(1, Math.round(Number(e.target.value)))); update((d) => ({ ...d, settings: { ...d.settings, linesMax: v, linesMin: Math.min(v, d.settings.linesMin) } })); }} />
                </Field>
              </div>
              <span className="lin-hint">
                現在每段 <span className="num">{s.linesMin === s.linesMax ? `${s.linesMin} 句` : `${s.linesMin}～${s.linesMax} 句`}</span>。兩個設一樣就是固定句數；小模型通常只寫到最少的句數，想要長一點就調高「最少」；句數越多，一段越久才生成完。
              </span>
            </Sec>

            <Sec id="gen-context" title="上下文" desc="每段生成時帶最近幾則對話（你說的話與她的台詞各算一則）。越多越記得前文，也越慢、越貴。">
              {(
                [
                  ['contextNormal', '一般模式'],
                  ['contextIntimacy', '親密模式'],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={<>{label}　<span className="num">{s[k]} 則</span></>}>
                  <input type="range" className="range" min={5} max={200} step={5} value={s[k]} aria-valuetext={`${s[k]} 則`} onChange={(e) => setS(k, Number(e.target.value))} />
                </Field>
              ))}
            </Sec>

            <Sec id="gen-state" title="狀態更新" desc="親密模式的秘密狀態什麼時候、根據什麼更新。">
              <Check checked={s.stateSeparately} onChange={(v) => setS('stateSeparately', v)} label="狀態等台本生成完再生成" hint="台詞先生成、先播放，再把這段台本當輸入另外送一次請求，只填秘密狀態——狀態才不會跟台本脫鉤。面板晚幾秒更新，每段多一次請求。" />
            </Sec>

            <Sec id="gen-clock" title="故事時鐘" desc="每段帶現在時刻，模型回報這段結束時幾點；時間只會往前。">
              <Check checked={data.clock.on} onChange={(v) => update((d) => ({ ...d, clock: { ...d.clock, on: v } }))} label="開啟故事時鐘" />
              <Field label="起始時刻" hint="在重新開始或第一段時生效。">
                <input className="input num" type="time" value={data.clock.start} disabled={!data.clock.on} onChange={(e) => update((d) => ({ ...d, clock: { ...d.clock, start: e.target.value } }))} style={{ maxWidth: 160 }} />
              </Field>
            </Sec>

            {!ragAbsent && (
            <Sec id="gen-rag" title="參考範例（RAG）" desc="生成每一段前，從本機索引找幾段相近的對話片段放進提示詞，當語氣與表達的參考。資料自己準備，用 rag.bat 建索引（說明見 README 與 rag/README.md）；沒有選索引就不檢索，生成照常。">
              <Field label="索引" hint={ragCols && !ragCols.length ? '還沒有索引：用 rag.bat 建自己的索引（步驟見 README 的「參考範例（RAG）」），建好會在 data\\rag\\out\\<名稱>\\，按「重新整理」就會列出來。' : '選「不使用」就不檢索。'}>
                <div className="lin-actions">
                  <select className="select" value={s.rag.collection} onChange={(e) => setRag('collection', e.target.value)} style={{ maxWidth: 320 }}>
                    <option value="">不使用</option>
                    {(ragCols ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}（{c.chunks} 個片段{c.embed.backend === 'none' ? '，只用關鍵字' : ''}）
                      </option>
                    ))}
                    {s.rag.collection && ragCols && !ragCols.some((c) => c.name === s.rag.collection) && <option value={s.rag.collection}>{s.rag.collection}（找不到）</option>}
                  </select>
                  <button type="button" className="btn sm ghost" onClick={refreshRag}>
                    重新整理
                  </button>
                </div>
              </Field>
              <Field label="加入索引" hint="別處建好的索引：把 data\rag\out\<名稱> 資料夾壓成 zip 匯入，zip 的檔名就是索引名稱；或開資料夾把索引資料夾直接放進去。">
                <div className="lin-actions">
                  <button type="button" className="btn sm" disabled={!!ragBusy} onClick={() => ragFile.current?.click()}>
                    {ragBusy ? '匯入中' : '匯入索引（zip）'}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => void openRagFolder()}>
                    開啟索引資料夾
                  </button>
                  <input
                    ref={ragFile}
                    type="file"
                    accept=".zip,application/zip"
                    className="sr-only"
                    onChange={(e) => {
                      void importRag(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </div>
              </Field>
              {ragBusy && <p className="hint">{ragBusy}</p>}
              {ragErr && <div className="note danger">{ragErr}</div>}
              {(() => {
                const col = ragCols?.find((c) => c.name === s.rag.collection);
                return col && col.embed.backend === 'lmstudio' ? <p className="hint">這個索引用 LM Studio 的 {col.embed.model} 做查詢向量：檢索時要載入它（約 0.8 GB 顯存，可和 LLM 同時載著）。</p> : null;
              })()}
              <Check checked={s.rag.local} onChange={(v) => setRag('local', v)} label="本機 LM Studio 時帶參考範例" />
              <Check checked={s.rag.cloud} onChange={(v) => setRag('cloud', v)} label="其他端點（Gemini、OpenAI、Claude…）時帶參考範例" hint="每段多幾百到上千字的 token；各家的內容政策不同，被擋時整段會失敗。" />
              <div className="lin-pair">
                <Field label={<>片段數　<span className="num">{s.rag.k} 個</span></>}>
                  <input type="range" className="range" min={1} max={10} step={1} value={s.rag.k} aria-valuetext={`${s.rag.k} 個`} onChange={(e) => setRag('k', Number(e.target.value))} />
                </Field>
                <Field label="總字數上限" hint="超過就少帶幾個片段。">
                  <input className="input num" type="number" min={200} max={8000} step={100} value={s.rag.maxChars} onChange={(e) => setRag('maxChars', Math.min(8000, Math.max(200, Math.round(Number(e.target.value)))))} />
                </Field>
              </div>
            </Sec>
            )}

            <Sec id="gen-tone" title="語氣對照（ZONOS）" desc="台本每句標的語氣（音量、速度、情緒、句中耳語）換成 ZONOS 的控制，每格寫成「類別.方向=強度」。預設值來自試聽量測：音高不超過原聲約 +40%、不會出錯或空音。改了從下一句起生效；已經合成過的句子留在語音庫裡照舊。只有 ZONOS 用得到。">
              <ToneTable value={data.zonosTone} onChange={(t) => update((d) => ({ ...d, zonosTone: t }))} />
            </Sec>

            <Sec id="gen-sleep" title="睡眠模式" desc="播放列選「睡眠」時：照時長慢慢收尾。">
              <Field label="時長（分鐘）">
                <input className="input num" type="number" min="5" max="240" value={s.sleepMinutes} onChange={(e) => setS('sleepMinutes', Number(e.target.value))} style={{ maxWidth: 160 }} />
              </Field>
              <Field label="睡眠模式指令" hint="睡眠模式每段都帶。">
                <textarea className="textarea" rows={4} value={data.prompts.sleep} onChange={(e) => update((d) => ({ ...d, prompts: { ...d.prompts, sleep: e.target.value } }))} />
              </Field>
            </Sec>
          </>
        )}

        {tab === 'prompt' && (
          <>
            <Sec id="prompt-system" title="系統核心規則" desc="一般模式每段 system 訊息的開頭。親密模式改用「親密模式」分類裡的親密模式系統提示詞。">
              <Field label="系統核心規則">
                <textarea className="textarea" rows={12} value={data.prompts.system} onChange={(e) => update((d) => ({ ...d, prompts: { ...d.prompts, system: e.target.value } }))} />
              </Field>
            </Sec>
            <Sec id="prompt-opening" title="開場劇本" desc="只在第一段帶。">
              <Field label="開場劇本">
                <textarea className="textarea" rows={5} value={data.prompts.opening} onChange={(e) => update((d) => ({ ...d, prompts: { ...d.prompts, opening: e.target.value } }))} />
              </Field>
            </Sec>
          </>
        )}

        {tab === 'intimacy' && (
          <>
            <Sec id="int-prompt" title="親密模式提示詞" desc="頂列愛心按下去（親密模式）時用這套，取代一般模式的系統核心規則。">
              <Field label="親密模式系統提示詞">
                <textarea className="textarea" rows={10} value={data.intimacy.system} onChange={(e) => update((d) => ({ ...d, intimacy: { ...d.intimacy, system: e.target.value } }))} />
              </Field>
              <Field label="親密劇本" hint="親密模式每段都帶，也是親密模式的開場。">
                <textarea className="textarea" rows={5} value={data.intimacy.script} placeholder="例：深夜的房間只開一盞小燈……" onChange={(e) => update((d) => ({ ...d, intimacy: { ...d.intimacy, script: e.target.value } }))} />
              </Field>
            </Sec>

            <Sec id="int-defs" title="狀態定義" desc="給模型看的文字規則：數值怎麼變、角色的秘密怎麼寫。">
              <Field label="數值與狀態定義" hint="親密模式每段帶。也是「由狀態定義產生欄位」的依據。">
                <textarea className="textarea" rows={8} value={data.statDefs} onChange={(e) => update((d) => ({ ...d, statDefs: e.target.value }))} />
              </Field>
              <Field label="秘密生成格式" hint="建立角色時，角色的秘密照這份寫；角色沒有秘密時，親密模式也照這份補寫。">
                <textarea className="textarea" rows={6} value={data.secretTemplate} onChange={(e) => update((d) => ({ ...d, secretTemplate: e.target.value }))} />
              </Field>
            </Sec>

            <Sec id="int-fields" title="欄位表" desc="模型每段能寫的秘密狀態欄位與上限（產生 JSON schema）：格式外的欄位寫不出來，數值每段變化不能超過上限。改了要按「套用欄位表」，這次對話會重新開始。">
              <div className="field-list">
                {fmt.fields.map((f, i) => (
                  <FieldRow key={i} f={f} onChange={(nf) => editField(i, nf)} onRemove={() => editField(i, null)} />
                ))}
              </div>
              <div className="lin-actions">
                <button type="button" className="btn" onClick={() => setFmt({ fields: [...fmt.fields, blankField('text', `field${fmt.fields.length + 1}`)] })}>
                  新增欄位
                </button>
                <button type="button" className="btn" disabled={fmt.fields.some((f) => f.type === 'zones' && f.label === ZONE_MAP_FIELD.label) || fmt.fields.some((f) => f.key === ZONE_MAP_FIELD.key)} title="ADV3.0 的性感帶地圖：部位、開發度、狀態；部位由模型新增" onClick={() => setFmt({ fields: [...fmt.fields, structuredClone(ZONE_MAP_FIELD) as unknown as StateField] })}>
                  加入性感帶地圖欄位
                </button>
                <button type="button" className="btn" disabled={genBusy || !data.statDefs.trim()} onClick={() => void genFields()}>
                  {genBusy ? '產生中' : '由狀態定義產生欄位'}
                </button>
                <button type="button" className="btn primary" disabled={!!fmtErr || !fmtDirty} onClick={applyFormat}>
                  套用欄位表
                </button>
                <span className="hint">{fmtErr ? '' : fmtDirty ? '有還沒套用的修改（套用後這次對話重新開始）' : '沒有修改'}</span>
              </div>
              {fmtErr && <div className="note danger">{fmtErr}</div>}
            </Sec>

            <Sec id="int-layout" title="面板版面" desc="聆聽頁右側狀態面板的區塊與順序。欄位留空＝依類型自動分配；沒被任何區塊收到的欄位會放到最後的「其他」。">
              {layout.map((b, i) => (
                <div key={i} className="lin-sub">
                  <div className="lin-sec-head">
                    <h4>
                      區塊 {i + 1}：{b.title || BLOCK_LABEL[b.type]}
                    </h4>
                    <div className="lin-actions">
                      <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => setLayout(layout.map((x, j) => (j === i - 1 ? layout[i]! : j === i ? layout[i - 1]! : x)))} aria-label={`區塊 ${i + 1} 往上`}>
                        上移
                      </button>
                      <button type="button" className="btn sm ghost" onClick={() => setLayout(layout.filter((_, j) => j !== i))} aria-label={`刪除區塊 ${i + 1}`}>
                        刪除
                      </button>
                    </div>
                  </div>
                  <div className="lin-pair">
                    <Field label="類型">
                      <select className="select" value={b.type} onChange={(e) => setLayout(layout.map((x, j) => (j === i ? { ...x, type: e.target.value as PanelBlock['type'] } : x)))}>
                        {(Object.keys(BLOCK_LABEL) as PanelBlock['type'][]).map((t) => (
                          <option key={t} value={t}>
                            {BLOCK_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="標題">
                      <input className="input" value={b.title} onChange={(e) => setLayout(layout.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                    </Field>
                  </div>
                  <Field label="欄位 key" hint="用、分隔；留空＝依類型自動分配。">
                    <input className="input mono" value={b.fields.join('、')} onChange={(e) => setLayout(layout.map((x, j) => (j === i ? { ...x, fields: e.target.value.split(/[、,，]/).map((y) => y.trim()).filter(Boolean) } : x)))} />
                  </Field>
                  {b.type === 'kv' && (
                    <Field label="只顯示的項目" hint="數值表才有；用、分隔，空白＝全部；^開頭或$結尾＝regex。">
                      <input
                        className="input mono"
                        placeholder="空白＝全部"
                        value={incDraft[i] ?? (b.include ?? []).join('、')}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setIncDraft({ ...incDraft, [i]: raw });
                          const include = raw.split(/[、,，]/).map((y) => y.trim()).filter(Boolean);
                          const err = checkInclude(include);
                          setIncErr({ ...incErr, [i]: err ?? '' });
                          if (!err) setLayout(layout.map((x, j) => (j === i ? { ...x, include } : x)));
                        }}
                      />
                      {incErr[i] && <span className="bad-t" style={{ fontSize: 13 }}>{incErr[i]}（沒有存）</span>}
                    </Field>
                  )}
                </div>
              ))}
              <div className="lin-actions">
                <button type="button" className="btn" onClick={() => setLayout([...layout, { type: 'rows', title: '新區塊', fields: [] }])}>
                  新增區塊
                </button>
                <button type="button" className="btn ghost" onClick={() => setLayout([])}>
                  用預設版面
                </button>
              </div>
            </Sec>

            <Sec id="int-file" title="規則設定檔" desc="整套親密模式設定（提示詞、定義、秘密生成格式、欄位表、面板版面）打包成一個檔。">
              <Field label="設定檔名稱">
                <input className="input" value={data.rulesName} onChange={(e) => update((d) => ({ ...d, rulesName: e.target.value }))} />
              </Field>
              <Field as="div" label="匯入與匯出" hint="匯入接受 CherunoASMR 設定檔、ADV3.0 的「匯出配置」和 ADV3.0 整份存檔（只讀規則、定義、秘密生成格式、面板版面；角色與對話紀錄不讀）。系統核心規則會一起取代「一般模式」的內容。">
                <div className="lin-actions">
                  <button type="button" className="btn" onClick={() => rulesFile.current?.click()}>
                    匯入設定檔
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      download(`cheruno-rules-${data.rulesName}.json`, exportRules({ name: data.rulesName, rules: data.prompts.system, definitions: data.statDefs, secretFormat: data.secretTemplate, layout: data.layout, fields: data.secretFormat.fields, intimacySystem: data.intimacy.system, intimacyScript: data.intimacy.script }))
                    }
                  >
                    匯出設定檔
                  </button>
                </div>
              </Field>
              {importMsg && <div className="note positive">{importMsg}</div>}
              <input ref={rulesFile} type="file" accept="application/json" className="sr-only" onChange={(e) => void importRulesFile(e.target.files?.[0])} />
            </Sec>
          </>
        )}

        {tab === 'templates' && (
          <>
            <div className="lin-actions" style={{ position: 'sticky', top: 0, background: 'var(--color-paper)', padding: '8px 0', zIndex: 5 }}>
              <button type="button" className="btn primary" disabled={!tplDirty || tplProblems.length > 0} onClick={() => { update((d) => ({ ...d, templates: tpl })); props.toast('提示詞已儲存，下一次送出起生效'); }}>
                儲存提示詞
              </button>
              <button type="button" className="btn ghost" disabled={!tplDirty} onClick={() => setTpl(data.templates)}>
                放棄修改
              </button>
              <button type="button" className="btn ghost" onClick={() => setTpl(DEFAULT_TEMPLATES)}>
                全部還原預設
              </button>
              <span className="hint">{tplProblems.length ? '' : tplDirty ? '有還沒儲存的修改' : '點一個模板展開編輯；改過的會標「已改」'}</span>
            </div>
            {tplProblems.length > 0 && (
              <div className="note danger">
                {tplProblems.map((p) => (
                  <div key={p}>{p}</div>
                ))}
              </div>
            )}
            {tplSections.map((sec) => {
              const meta = TEMPLATE_META[sec.group];
              const items = meta.items as Record<string, { label: string; vars: Record<string, string>; rows?: number }>;
              return (
                <Sec key={sec.id} id={sec.id} title={sec.title} desc={sec.desc}>
                  <div>
                    {sec.keys.map((k) => {
                      const m = items[k]!;
                      const value = (tpl[sec.group] as Record<string, string>)[k]!;
                      const def = (DEFAULT_TEMPLATES[sec.group] as Record<string, string>)[k]!;
                      const vars = Object.entries(m.vars);
                      const bad = tplProblems.some((p) => p.startsWith(`${meta.title} › ${m.label}`));
                      return (
                        <details key={k} className="tpl-one" open={bad || undefined}>
                          <summary className="tpl-sum">
                            <span className="lin-label">{m.label}</span>
                            {value !== def && <span className="tpl-badge">已改</span>}
                            {bad && <span className="tpl-badge bad-t">有問題</span>}
                            <span className="tpl-prev" title={value.trim() ? value.replace(/\s+/g, ' ') : '（空）'}>
                              {value.trim() ? value.replace(/\s+/g, ' ') : '（空）'}
                            </span>
                          </summary>
                          <Field as="div" label="內容" hint={vars.length ? <>可用變數：{vars.map(([v, d]) => <span key={v} style={{ marginRight: 12 }}><code>{`{{${v}}}`}</code> {d}</span>)}</> : undefined}>
                            <textarea className="textarea" rows={Math.max(2, m.rows ?? 1)} value={value} aria-label={m.label} aria-invalid={bad} onChange={(e) => setTpl({ ...tpl, [sec.group]: { ...tpl[sec.group], [k]: e.target.value } })} />
                          </Field>
                          {value !== def && (
                            <div className="lin-actions" style={{ marginTop: 8 }}>
                              <button type="button" className="btn sm ghost" onClick={() => setTpl({ ...tpl, [sec.group]: { ...tpl[sec.group], [k]: def } })}>
                                這個還原預設
                              </button>
                            </div>
                          )}
                        </details>
                      );
                    })}
                  </div>
                </Sec>
              );
            })}
          </>
        )}

        {tab === 'flow' && <AiFlow data={data} />}
        {tab === 'log' && <RequestLog />}
        {tab === 'applog' && <AppLog />}

        {tab === 'data' && (
          <Sec id="data-backup" title="備份與還原" desc="這個存檔的全部可改資料打包成一個 JSON：系統核心的所有設定（連線、語音合成、生成方式、一般／親密模式、提示詞模板、欄位表、面板版面）、角色（含秘密狀態）、主角、萬物之書、規則、提示詞、面板版面、對話（台本與每段狀態）、角色圖與鎖定聲音時的候選音。不含 API key 與每句的合成語音（還原後播放時會重新合成）。">
            <Field as="div" label="備份">
              <div className="lin-actions">
                <button type="button" className="btn" disabled={!!backupBusy} onClick={() => void doBackup()}>
                  {backupBusy === 'download' ? '打包中' : '下載備份'}
                </button>
              </div>
            </Field>
            <Field as="div" label="還原" hint="會覆蓋這個存檔的資料與對話，系統核心的連線、語音合成、生成方式也換成備份裡的（API key 保留這台電腦的）；還原前自動先下載一份目前的備份。要另外建一個存檔，請到存檔畫面用「從備份檔建立」。舊的備份檔（沒有對話）也能還原。">
              <div className="lin-actions">
                <button type="button" className="btn" disabled={!!backupBusy} onClick={() => backupFile.current?.click()}>
                  {backupBusy === 'restore' ? '還原中' : '選擇備份檔'}
                </button>
              </div>
            </Field>
            <input ref={backupFile} type="file" accept="application/json" className="sr-only" onChange={(e) => void restoreBackup(e.target.files?.[0])} />
          </Sec>
        )}
      </section>
    </div>
  );
}
