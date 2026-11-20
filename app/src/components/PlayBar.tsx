// 底部播放列（V4）：聆聽時完整；其他頁是迷你版（正在念的那句＋回到聆聽），聲音不停。
import { useState } from 'react';
import { fmtClock, useSession } from '../session.tsx';
import type { AppData, ModeKey, SubLang } from '../store.ts';

const MODES: [ModeKey, string][] = [
  ['infinite', '無限'],
  ['interactive', '互動'],
  ['sleep', '睡眠'],
];
const SUBS: [Exclude<SubLang, 'off'>, string][] = [
  ['zh', '繁中'],
  ['en', 'EN'],
];

export function PlayBar(props: { data: AppData; update: (f: (d: AppData) => AppData) => void; onListen: boolean; goListen: () => void; toast: (m: string) => void }) {
  const s = useSession();
  const { data, update } = props;
  const [toneOpen, setToneOpen] = useState(false);
  const [toneDraft, setToneDraft] = useState(data.tone);
  const setUi = (p: Partial<AppData['ui']>) => update((d) => ({ ...d, ui: { ...d.ui, ...p } }));
  if (!s) return null;

  const name = s.character.subName || s.character.name;
  const playingLabel = s.paused ? '繼續播放' : '暫停';
  const status =
    data.ui.mode === 'sleep'
      ? s.faded
        ? '睡眠，已淡出'
        : `睡眠，${fmtClock(s.sleepLeftMs)} 後淡出`
      : s.generating
        ? `${name}正在想下一段`
        : data.ui.mode === 'interactive' && !s.playing
          ? '等你開口'
          : `緩衝 ${s.buffered} 段`;

  return (
    <div className="playbar" role="region" aria-label="播放列">
      <div className="l">
        <button type="button" className="play" onClick={s.togglePause} aria-label={playingLabel} title={playingLabel}>
          {s.paused ? (
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 3v14l12-7z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="4" y="3" width="4" height="14" rx="1" fill="currentColor" />
              <rect x="12" y="3" width="4" height="14" rx="1" fill="currentColor" />
            </svg>
          )}
        </button>
        {props.onListen ? (
          <>
            <div role="radiogroup" aria-label="模式" className="seg">
              {MODES.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={data.ui.mode === k} onClick={() => setUi({ mode: k })}>
                  {label}
                </button>
              ))}
            </div>
            <span className="num hint" style={{ whiteSpace: 'nowrap' }} data-testid="capsule">
              {s.paused ? '已暫停' : status}
            </span>
            {s.generating && (
              <button type="button" className="btn sm ghost" onClick={() => s.stop()}>
                停止生成
              </button>
            )}
          </>
        ) : (
          <>
            <div className="mini">
              <span lang="ja" className="ja">
                {s.playing ? s.playing.ev.ja.replace(/\{([^{}|]+)\|[^{}|]+\}/g, '$1').replace(/[《》]/g, '') : s.paused ? '已暫停' : '目前沒有在念'}
              </span>
              <span className="hint">
                {name}，第 {s.panel.n} 段，{s.paused ? '已暫停' : s.playing ? '播放中' : status}
              </span>
            </div>
            <button type="button" className="btn" style={{ whiteSpace: 'nowrap' }} onClick={props.goListen}>
              回到聆聽
            </button>
          </>
        )}
      </div>
      {props.onListen && (
        <div className="r">
          {/* 字幕：選一種翻譯；再按一次已選的那個＝關掉翻譯，只看日文 */}
          <div role="group" aria-label="字幕翻譯" className="seg" title="再按一次已選的語言可以關掉翻譯">
            {SUBS.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={data.ui.sub === k} onClick={() => setUi({ sub: data.ui.sub === k ? 'off' : k })}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="btn" aria-pressed={data.ui.ruby} onClick={() => setUi({ ruby: !data.ui.ruby })}>
            振假名
          </button>
          <button
            type="button"
            className="btn"
            aria-expanded={toneOpen}
            onClick={() => {
              setToneDraft(data.tone);
              setToneOpen(!toneOpen);
            }}
          >
            語氣
          </button>
          {toneOpen && (
            <div role="dialog" aria-label="語氣" className="popover">
              <label className="field">
                <span>之後段落的語氣</span>
                <textarea className="textarea" rows={3} value={toneDraft} placeholder="例：再撒嬌一點，句尾多停頓。" onChange={(e) => setToneDraft(e.target.value)} />
              </label>
              <span className="hint">只影響之後段落的語氣與演出，不改劇情與規則。</span>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn ghost" onClick={() => setToneOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    update((d) => ({ ...d, tone: toneDraft }));
                    setToneOpen(false);
                    props.toast(toneDraft.trim() ? '語氣會套用到之後的段落' : '已清除語氣');
                  }}
                >
                  套用
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
