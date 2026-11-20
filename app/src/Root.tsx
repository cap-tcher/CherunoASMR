// 進入點：先讀存檔區（[[PLAN_存檔區與語音庫]]）。上次開的存檔還在就直接開；沒有存檔（首次開啟）只出現存檔畫面。
import { useEffect, useRef, useState } from 'react';
import { App } from './App.tsx';
import { imageToKey, isKey } from './library.ts';
import { DataDirPicker } from './components/DataDirPicker.tsx';
import { SavesPage } from './pages/Saves.tsx';
import { attachLog } from './requestLog.ts';
import { buildBackup, parseBackup, restoreAssets } from './backup.ts';
import { attachAppLog } from './appLog.ts';
import { createSave, debouncedWriter, getDataDir, getSettings, listSaves, putSaveData, putSaveSession, putSettings, readSave, type SaveMeta, type SaveState, type Writer } from './saveStore.ts';
import type { SavedSession } from './session.tsx';
import { download, DEFAULT_DATA, LEGACY_DATA_KEY, LEGACY_SESSION_KEY, migrate, type AppData, type Settings } from './store.ts';

/** settings.json 的內容：這台電腦的設定＋上次開的存檔 */
interface MachineSettings {
  app: Settings;
  lastSave: string | null;
}

type SaveData = Omit<AppData, 'settings'>;
type Phase =
  | { k: 'loading' }
  | { k: 'fatal'; msg: string }
  | { k: 'nodir' }
  | { k: 'saves'; saves: SaveMeta[] }
  | { k: 'open'; meta: SaveMeta; data: AppData; session: SavedSession | null };

const withoutSettings = (d: AppData): SaveData => {
  const { settings: _settings, ...rest } = d;
  return rest;
};

export function Root() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  // 每開一次存檔就換一個號：同一個存檔重新開（例：還原後）也要整個重建畫面，不然畫面上的舊資料會被自動存檔寫回去
  const [openGen, setOpenGen] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'saved' });
  const machine = useRef<MachineSettings>({ app: DEFAULT_DATA.settings, lastSave: null });
  const writers = useRef<{ data: Writer<AppData>; session: Writer<SavedSession> } | null>(null);

  async function open(id: string) {
    await writers.current?.data.flush();
    await writers.current?.session.flush();
    const f = await readSave<SaveData, SavedSession>(id);
    const data = migrate({ ...f.data, settings: { ...machine.current.app } } as AppData);
    // 舊資料的角色圖是 data URL：搬進共用庫，存檔只留 key（只做一次）
    if (data.characters.some((c) => c.image && !isKey(c.image))) {
      data.characters = await Promise.all(data.characters.map(async (c) => (c.image && !isKey(c.image) ? { ...c, image: await imageToKey(c.image) } : c)));
      await putSaveData(id, withoutSettings(data));
    }
    machine.current = { ...machine.current, lastSave: id };
    await putSettings(machine.current);
    await attachLog(id); // 讀回這個存檔的請求紀錄
    await attachAppLog(id); // 讀回這個存檔的 App 紀錄
    writers.current = {
      data: debouncedWriter((d: AppData) => {
        machine.current = { ...machine.current, app: d.settings };
        return Promise.all([putSaveData(id, withoutSettings(d)), putSettings(machine.current)]);
      }, setSaveState),
      session: debouncedWriter((s: SavedSession) => putSaveSession(id, s), setSaveState),
    };
    setSaveState({ kind: 'saved' });
    setOpenGen((g) => g + 1);
    setPhase({ k: 'open', meta: f.meta, data, session: f.session && 'charId' in f.session ? f.session : null });
  }

  /** 下載這個存檔的完整備份（先把還沒寫的寫掉，再從存檔區讀：對話、共用庫檔都在裡面） */
  async function downloadBackup(id: string, name: string) {
    await writers.current?.data.flush();
    await writers.current?.session.flush();
    const b = await buildBackup(id, machine.current.app);
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    download(`cheruno-backup-${safe}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`, JSON.stringify(b, null, 2));
    return b;
  }

  /** 系統核心裡存在這台電腦（settings.json）的設定：連線、語音合成、生成方式。備份裡有，還原時套用；API key 不在備份裡，保留這台電腦的 */
  async function applyMachineSettings(fromBackup: Settings) {
    // 金鑰以存檔區現在的 settings.json 為準（別的裝置可能剛改過）；沒有 settings.json＝這台電腦還沒填過金鑰
    const now = await getSettings<MachineSettings>();
    machine.current = { ...machine.current, app: { ...DEFAULT_DATA.settings, ...fromBackup, apiKey: now ? now.app.apiKey : '' } };
    await putSettings(machine.current);
  }

  /** 用備份覆蓋這個存檔：還原前先下載目前的備份；停掉自動寫入，寫好資料與對話後重新開這個存檔 */
  async function restoreInto(id: string, name: string, file: File) {
    const parsed = parseBackup(await file.text());
    await downloadBackup(id, `${name}-還原前`);
    writers.current = null; // 畫面上的舊資料不能再寫回去
    await restoreAssets(parsed.assets);
    await applyMachineSettings(parsed.data.settings);
    await putSaveData(id, withoutSettings(parsed.data));
    await putSaveSession(id, parsed.session ?? {});
    await open(id);
  }

  async function showSaves() {
    await writers.current?.data.flush();
    await writers.current?.session.flush();
    writers.current = null;
    setPhase({ k: 'saves', saves: await listSaves() });
  }

  /** 開機：還沒選存檔區就先選；選好了讀這個存檔區的設定，上次開的存檔還在就直接開。換存檔區後也從這裡重來 */
  function boot(openLast: boolean) {
    setPhase({ k: 'loading' });
    (async () => {
      if (!(await getDataDir()).dataDir) return setPhase({ k: 'nodir' });
      const s = await getSettings<MachineSettings>();
      machine.current = s ? { app: { ...DEFAULT_DATA.settings, ...s.app }, lastSave: s.lastSave } : { app: machine.current.app, lastSave: null };
      const saves = await listSaves();
      if (openLast && machine.current.lastSave && saves.some((x) => x.id === machine.current.lastSave)) await open(machine.current.lastSave);
      else setPhase({ k: 'saves', saves });
    })().catch((e: unknown) => setPhase({ k: 'fatal', msg: e instanceof Error ? e.message : String(e) }));
  }

  useEffect(() => {
    boot(true);
    // 離開頁面或切到背景：把還沒寫的寫掉
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        void writers.current?.data.flush();
        void writers.current?.session.flush();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  if (phase.k === 'loading') return <div className="boot hint">讀取存檔區…</div>;
  if (phase.k === 'fatal')
    return (
      <div className="boot">
        <div className="note danger" role="alert">
          {phase.msg}
        </div>
      </div>
    );
  if (phase.k === 'nodir')
    return (
      <main className="saves">
        <header>
          <h1>CherunoASMR</h1>
          <p className="hint">先選存檔區：設定、存檔、語音與角色圖都放在這個資料夾。可以選已經有存檔的資料夾，或新的空資料夾。</p>
        </header>
        <DataDirPicker current={null} locked={null} primary onChanged={() => boot(true)} />
      </main>
    );
  if (phase.k === 'saves')
    return (
      <SavesPage
        onDataDirChanged={() => boot(false)}
        saves={phase.saves}
        current={machine.current.lastSave}
        hasLegacy={localStorage.getItem(LEGACY_DATA_KEY) !== null}
        refresh={() => void showSaves()}
        onOpen={(id) => open(id)}
        onCreateFromBackup={async (file) => {
          const parsed = parseBackup(await file.text());
          await restoreAssets(parsed.assets);
          await applyMachineSettings(parsed.data.settings);
          const meta = await createSave(parsed.name ?? file.name.replace(/\.json$/i, ''), withoutSettings(parsed.data), parsed.session);
          await open(meta.id);
        }}
        onCreate={async (name, data, session) => {
          const meta = await createSave(name, withoutSettings(data), session);
          await open(meta.id);
        }}
        onImportLegacy={async () => {
          const raw = localStorage.getItem(LEGACY_DATA_KEY)!;
          const old = migrate(JSON.parse(raw) as AppData);
          const sraw = localStorage.getItem(LEGACY_SESSION_KEY);
          machine.current = { ...machine.current, app: { ...DEFAULT_DATA.settings, ...old.settings } };
          const meta = await createSave('從瀏覽器搬來的資料', withoutSettings(old), sraw ? (JSON.parse(sraw) as SavedSession) : null);
          // 存檔建好、讀得回來才清掉瀏覽器裡的舊資料
          await readSave(meta.id);
          localStorage.removeItem(LEGACY_DATA_KEY);
          localStorage.removeItem(LEGACY_SESSION_KEY);
          await open(meta.id);
        }}
        machineSettings={() => machine.current.app}
      />
    );
  return (
    <App
      key={`${phase.meta.id}-${openGen}`}
      saveName={phase.meta.name}
      initial={phase.data}
      session={phase.session}
      saveState={saveState}
      onData={(d) => writers.current?.data.push(d)}
      onSession={(s) => writers.current?.session.push(s)}
      onSaves={() => void showSaves()}
      backup={{ download: () => downloadBackup(phase.meta.id, phase.meta.name).then(() => undefined), restore: (f) => restoreInto(phase.meta.id, phase.meta.name, f) }}
    />
  );
}
