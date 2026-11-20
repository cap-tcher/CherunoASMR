// 系統核心 › 生成方式 › 語氣對照（[[PLAN_ZONOS語氣控制]] Z-05）：台本每句的語氣 → ZONOS controls。
// 每格寫成「類別.方向=強度, …」；離開欄位時檢查，寫錯就留在原值並說明哪裡錯。
import { DEFAULT_ZONOS_TONE, EMOTION_LABEL, EMOTIONS, SPEED_LABEL, SPEEDS, VOICES, formatControls, parseControls, SCALE_RANGE, type Emotion, type ZonosToneTable } from '@cheruno/core';
import { useEffect, useState } from 'react';
import { Field } from './Outline.tsx';

type Controls = Record<string, number>;
const VOICE_LABEL = { normal: '一般', soft: '小声', whisper: '囁き', breath: '吐息' } as const;

function Cell(props: { label: string; value: Controls | null; onSave: (c: Controls | null) => void; emptyMeans: string }) {
  const shown = props.value ? formatControls(props.value) : '';
  const [text, setText] = useState(shown);
  const [err, setErr] = useState('');
  useEffect(() => setText(shown), [shown]);
  return (
    <div>
      <input
        className="input mono"
        aria-label={props.label}
        value={text}
        placeholder={props.emptyMeans}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const c = parseControls(text);
            setErr('');
            props.onSave(Object.keys(c).length ? c : null);
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      {err && <p className="hint bad-t">{err}</p>}
    </div>
  );
}

export function ToneTable(props: { value: ZonosToneTable; onChange: (t: ZonosToneTable) => void }) {
  const t = props.value;
  const emo = EMOTIONS.filter((e): e is Exclude<Emotion, 'none'> => e !== 'none');
  return (
    <>
      <Field label={<>情緒與起伏強度　<span className="num">{t.scale.toFixed(2)}</span></>} hint="情緒與激動的強度乘上這個比例：聲音起伏太大、聽起來破掉就往下調，太平就往上。耳語、速度、響度不受影響。預設 0.70">
        <input
          type="range"
          className="range"
          min={SCALE_RANGE[0]}
          max={SCALE_RANGE[1]}
          step={0.05}
          value={t.scale}
          aria-valuetext={t.scale.toFixed(2)}
          onChange={(e) => props.onChange({ ...t, scale: Number(e.target.value) })}
        />
      </Field>
      <div className="lin-sub">
        <h4>音量</h4>
        {VOICES.map((v) => (
          <Field key={v} label={VOICE_LABEL[v]}>
            <Cell label={`音量：${VOICE_LABEL[v]}`} value={t.voice[v]} emptyMeans="不加（原本的音量）" onSave={(c) => props.onChange({ ...t, voice: { ...t.voice, [v]: c ?? {} } })} />
          </Field>
        ))}
      </div>
      <div className="lin-sub">
        <h4>速度</h4>
        {SPEEDS.map((v) => (
          <Field key={v} label={SPEED_LABEL[v] || '一般'}>
            <Cell label={`速度：${SPEED_LABEL[v] || '一般'}`} value={t.speed[v]} emptyMeans="不加" onSave={(c) => props.onChange({ ...t, speed: { ...t.speed, [v]: c ?? {} } })} />
          </Field>
        ))}
      </div>
      <div className="lin-sub">
        <h4>情緒（強度 1／強度 2）</h4>
        <p className="hint">強度 2 空白＝一律用強度 1（量測時音高超過上限的情緒）。囁き、吐息的句子不疊情緒（疊了常出空音）；小声只用強度 1；耳語類都不疊速度。響度等整句條件寫成 cond.loudness（LUFS，-40～0）、cond.fmax、cond.speaking_rate。</p>
        {emo.map((e) => (
          <Field key={e} label={EMOTION_LABEL[e]}>
            <div className="lin-pair">
              <Cell label={`${EMOTION_LABEL[e]}：強度 1`} value={t.emotion[e][0]} emptyMeans="不加" onSave={(c) => props.onChange({ ...t, emotion: { ...t.emotion, [e]: [c ?? {}, t.emotion[e][1]] } })} />
              <Cell label={`${EMOTION_LABEL[e]}：強度 2`} value={t.emotion[e][1]} emptyMeans="用強度 1" onSave={(c) => props.onChange({ ...t, emotion: { ...t.emotion, [e]: [t.emotion[e][0], c] } })} />
            </div>
          </Field>
        ))}
      </div>
      <div className="lin-sub">
        <h4>句中耳語《》</h4>
        <Field label="《》裡的那段">
          <Cell label="句中耳語" value={t.span} emptyMeans="不加" onSave={(c) => props.onChange({ ...t, span: c ?? {} })} />
        </Field>
      </div>
      <div className="lin-actions">
        <button type="button" className="btn ghost" onClick={() => props.onChange(structuredClone(DEFAULT_ZONOS_TONE))}>
          全部還原預設
        </button>
      </div>
    </>
  );
}
