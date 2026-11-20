// 選存檔區資料夾：一顆按鈕開系統的選資料夾視窗（使用者 2026-11-20），選了就切換。
// 視窗由音訊服務在本機開（瀏覽器的資料夾選擇拿不到完整路徑）；切換只換資料夾，原本資料夾裡的存檔不動、不搬。
import { useState } from 'react';
import { isRemote } from '../remote.ts';
import { pickDataDir } from '../saveStore.ts';

export function DataDirPicker(props: { current: string | null; locked: string | null; onChanged: () => void; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function pick() {
    setBusy(true);
    setErr('');
    try {
      const r = await pickDataDir();
      if (!r.cancelled) props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dd-line">
      <span className="hint">存檔區：{props.current ?? '還沒選'}</span>
      {props.locked ? (
        <span className="hint">（由環境變數 CHERUNO_DATA_DIR 指定，測試用，不能在這裡改）</span>
      ) : isRemote() ? (
        <span className="hint">（選資料夾的視窗會開在電腦上，要換請在電腦上按）</span>
      ) : (
        <button
          type="button"
          className={props.primary ? 'btn primary' : 'btn sm'}
          disabled={busy}
          title={props.current ? '換成別的資料夾；原本資料夾裡的存檔留在原處，不會搬' : '選一個資料夾放設定、存檔、語音與角色圖'}
          onClick={() => void pick()}
        >
          {busy ? '在系統視窗裡選資料夾…' : props.current ? '換資料夾…' : '選擇資料夾…'}
        </button>
      )}
      {err && (
        <div className="note danger" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
