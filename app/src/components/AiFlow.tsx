// 系統核心 › AI 流程：照目前設定畫出資料怎麼流——每一站的輸入、處理、輸出，以及上一段實際送給 LLM 的內容與模型原始輸出。
import { SE_IDS } from '@cheruno/core';
import type { ReactNode } from 'react';
import { useSession, type SegmentTrace } from '../session.tsx';
import type { AppData } from '../store.ts';

type Item = { k: string; v?: ReactNode; off?: boolean };

function Io(props: { title: string; items: Item[] }) {
  return (
    <div className="flow-io">
      <h4>{props.title}</h4>
      <ul>
        {props.items.map((it) => (
          <li key={it.k} className={it.off ? 'off' : undefined}>
            <span className="flow-k">{it.k}</span>
            {it.v !== undefined && <span className="flow-v">{it.v}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Step(props: { n: string; title: string; where: string; input: Item[]; process: Item[]; output: Item[] }) {
  return (
    <section className="flow-step" aria-label={props.title}>
      <header>
        <span className="flow-n">{props.n}</span>
        <h3>{props.title}</h3>
        <span className="flow-where mono">{props.where}</span>
      </header>
      <div className="flow-cols">
        <Io title="輸入" items={props.input} />
        <Io title="處理" items={props.process} />
        <Io title="輸出" items={props.output} />
      </div>
    </section>
  );
}

const Arrow = (props: { label: string }) => (
  <div className="flow-arrow" aria-hidden="true">
    <span className="flow-line" />
    <span className="flow-label">{props.label}</span>
  </div>
);

const on = (b: boolean, v: ReactNode = '帶') => (b ? v : '不帶');
const len = (s: string) => (s.trim() ? `${s.trim().length} 字` : '空的（不帶）');
const MODE = { interactive: '互動', infinite: '無限', sleep: '睡眠' } as const;
const ENGINE_NAME = { irodori: 'Irodori-TTS（:8088）', zonos: 'ZONOS3-Mini（:8092）', 'qwen-comfy': 'Qwen3-TTS VoiceDesign（ComfyUI :8188）' } as const;

export function AiFlow(props: { data: AppData }) {
  const { data } = props;
  const s = data.settings;
  const session = useSession();
  const ch = data.characters.find((c) => c.id === data.activeId) ?? null;
  const im = data.ui.intimacy;
  const ctxN = im ? s.contextIntimacy : s.contextNormal;
  const viaClaude = s.llmBase.includes('/claude/');
  const fields = data.secretFormat.fields;
  const sub = data.ui.sub === 'off' ? '不要字幕' : data.ui.sub === 'en' ? 'EN' : '繁中';

  return (
    <div className="flow">
      <p className="hint">
        目前模式：<b>{im ? '親密模式' : '一般模式'}</b>
        {'　'}模型：<b className="mono">{s.model || '（還沒選）'}</b>
        {'　'}TTS：<b>{ENGINE_NAME[s.engine]}</b>
        {'　'}角色：<b>{ch ? ch.subName || ch.name : '（沒有）'}</b>
        。灰字＝目前設定下不會送出。
      </p>

      <h2 className="flow-h">聆聽：每一段</h2>
      <Step
        n="1"
        title="聽者輸入"
        where="聆聽頁"
        input={[{ k: '回話框的文字' }, { k: '點選的建議行動', v: '和打的字合併送出' }, { k: '無限／睡眠模式', v: '不用輸入，播完自動續寫' }]}
        process={[{ k: '目前模式', v: MODE[data.ui.mode] }, { k: '她正在說話時送出', v: '排在這段之後' }]}
        output={[{ k: 'userInput（聽者的話）' }]}
      />
      <Arrow label="userInput＋存檔裡的設定與資料" />
      <Step
        n="2"
        title="組提示詞"
        where="core/prompt.ts buildMessages"
        input={[
          { k: im ? '親密提示詞' : '系統提示詞', v: len(im ? data.intimacy.system : data.prompts.system), off: !(im ? data.intimacy.system : data.prompts.system).trim() },
          { k: '親密劇本（每段）', v: on(im, len(data.intimacy.script)), off: !im || !data.intimacy.script.trim() },
          { k: '開場劇本', v: data.prompts.opening.trim() ? `只在第一段，${len(data.prompts.opening)}` : len(''), off: !data.prompts.opening.trim() },
          { k: '主角', v: data.protagonist.name || '—' },
          { k: '角色卡（含她怎麼叫你）', v: ch ? `${ch.subName || ch.name}${ch.callName ? `；叫你「${ch.callName}」` : ''}` : '—' },
          { k: '角色的秘密', v: on(im && !!ch?.secret.trim(), '帶（只在 system）'), off: !im },
          { k: '秘密生成格式', v: im && ch && !ch.secret.trim() ? '帶（角色還沒有秘密）' : '不帶', off: !(im && ch && !ch.secret.trim()) },
          { k: '數值與狀態定義', v: on(im, len(data.statDefs)), off: !im || !data.statDefs.trim() },
          { k: '上一段的狀態快照（JSON）', v: on(im), off: !im },
          { k: '場景', v: on(data.optOn.scene), off: !data.optOn.scene },
          { k: '世界觀', v: on(data.optOn.world && !!data.world.trim()), off: !(data.optOn.world && data.world.trim()) },
          { k: '名詞圖鑑', v: data.optOn.glossary ? `${data.glossary.length} 條中，最近 3 則＋輸入命中的` : '不帶', off: !data.optOn.glossary },
          { k: '回憶章節', v: data.optOn.memory ? `${data.chapters.length} 則中，最新＋釘選＋命中` : '不帶', off: !data.optOn.memory },
          { k: '歷史', v: data.optOn.history ? `最近 ${Math.min(3, data.history.length)} 筆` : '不帶', off: !data.optOn.history },
          { k: '語氣', v: data.tone || '—' },
          { k: '故事時鐘', v: data.clock.on ? '帶現在時刻' : '不帶', off: !data.clock.on },
          { k: '上下文', v: `最近 ${ctxN} 則對話（${im ? '親密' : '一般'}模式設定）` },
        ]}
        process={[{ k: '提示詞模板代入', v: '系統核心 › 提示詞；變數全空的行省略' }, { k: '圖鑑／回憶比對', v: '掃最近 3 則對話＋這次輸入' }]}
        output={[{ k: 'messages', v: `system 1 則＋上下文（user／assistant 交替，最多 ${ctxN} 則）＋這次的 user 1 則` }]}
      />
      <Arrow label="messages＋json_schema（輸出格式）" />
      <Step
        n="3"
        title="LLM 生成"
        where={viaClaude ? `${s.llmBase} → Anthropic API` : s.llmBase}
        input={[
          { k: 'messages' },
          { k: 'response_format', v: 'json_schema（strict）' },
          { k: 'temperature', v: s.temperature },
          { k: 'max_tokens', v: s.maxTokens },
          { k: '關掉思考', v: s.noThinking ? 'reasoning_effort: none' : '不送', off: !s.noThinking },
        ]}
        process={[
          { k: viaClaude ? '音訊服務的 Claude 代理' : 'OpenAI 相容端點', v: viaClaude ? '轉成 Anthropic Messages API，金鑰取自連線設定' : '本機（LM Studio 等）' },
          { k: '串流', v: '120 秒沒資料就報錯可重試' },
        ]}
        output={[
          { k: 'lines[]', v: `每句 ja（≤60 字，可含 {漢字|よみ}）、${data.ui.sub === 'en' ? 'en' : 'zh'}、voice（normal／whisper／breath）、se[]` },
          { k: 'actions', v: '3 個建議行動' },
          { k: 'memory', v: '記憶候選' },
          { k: 'state', v: im ? `${fields.length} 個欄位` : '一般模式不輸出', off: !im },
          { k: 'secret', v: im && ch && !ch.secret.trim() ? '角色沒秘密時寫一份' : '不輸出', off: !(im && ch && !ch.secret.trim()) },
          { k: 'time', v: data.clock.on ? '這段結束的時刻' : '不輸出', off: !data.clock.on },
        ]}
      />
      <Arrow label="串流 JSON（邊收邊拆）" />
      <Step
        n="4"
        title="解析與狀態"
        where="core/segment.ts、core/state.ts"
        input={[{ k: '串流 JSON' }, { k: '欄位表', v: `${fields.length} 個欄位，各自的上限與每段最大變化` }]}
        process={[
          { k: '每句一收到就拆出來', v: '不用等整段，第一句馬上送 TTS' },
          { k: '台詞檢查', v: 'ja 有程式碼符號或過長就擋下並報錯' },
          { k: '狀態限幅', v: im ? '超過每段上限的變化會被壓回並提示' : '一般模式沿用上一段', off: !im },
          { k: '故事時鐘', v: data.clock.on ? '只往前，倒退的會被拒絕並提示' : '關閉', off: !data.clock.on },
        ]}
        output={[
          { k: '台詞事件', v: '→ TTS 佇列' },
          { k: '音效', v: `掛在台詞上（${SE_IDS.length} 種）` },
          { k: '狀態快照', v: '→ 狀態面板、存回角色', off: !im },
          { k: '建議行動', v: '→ 回話框上方' },
          { k: '記憶候選', v: data.optOn.memory ? '→ 使用者確認才存' : '回憶停用', off: !data.optOn.memory },
        ]}
      />
      <Arrow label="每句 ja（讀音）＋聲音" />
      <Step
        n="5"
        title="語音合成"
        where={`${s.audioBase}/tts → ${ENGINE_NAME[s.engine]}`}
        input={[
          { k: 'text', v: '{漢字|よみ} 換成讀音' },
          { k: 'voice', v: 'normal／whisper／breath' },
          { k: '聲音', v: ch?.voice ? `${ch.voice.engine}，${ch.voice.engine === 'qwen-comfy' ? `描述＋seed ${ch.voice.seed}` : `參考音 ${ch.voice.speaker}`}` : '還沒鎖定' },
          ...(s.engine === 'irodori' ? [{ k: '取樣步數', v: s.irodoriSteps }] : []),
        ]}
        process={[{ k: '一次合成一句', v: '引擎單一併發' }]}
        output={[{ k: 'wav', v: '每句一個' }]}
      />
      <Arrow label="wav＋音效＋字幕" />
      <Step
        n="6"
        title="播放"
        where="app（WebAudio）"
        input={[{ k: 'wav' }, { k: '音效', v: '程序合成，左右耳定位' }, { k: '字幕', v: sub }]}
        process={[{ k: '台詞開始時同時觸發這句的音效' }, { k: '無限模式', v: '緩衝下一段' }]}
        output={[{ k: '聲音與字幕' }, { k: '狀態面板更新', off: !im }, { k: '建議行動', v: '→ 回到 1' }]}
      />

      <h2 className="flow-h">建立角色</h2>
      <Step
        n="A"
        title="角色卡生成"
        where="core/character.ts generateCharacter"
        input={[{ k: '角色圖', v: '縮小後當 image_url（模型要會看圖）' }, { k: '方向提示、標籤' }, { k: '已經填的欄位', v: '保留不覆蓋' }, { k: '秘密生成格式', v: len(data.secretTemplate) }]}
        process={[{ k: 'LLM', v: `${s.model || '—'}，json_schema` }, { k: '提示詞', v: '系統核心 › 提示詞 › 角色卡' }]}
        output={[{ k: '角色卡欄位', v: '名字、讀音、外觀、個性、說話方式、秘密、聲音描述…' }]}
      />
      <Arrow label="聲音描述（日文）＋試聽句" />
      <Step
        n="B"
        title="聲音設計"
        where="ComfyUI :8188（FB_Qwen3TTSVoiceDesign）"
        input={[{ k: '聲音描述', v: '留空用預設描述' }, { k: '試聽句' }, { k: '3 個隨機 seed', v: '同描述不同 seed＝不同聲音' }]}
        process={[{ k: 'Qwen3-TTS 1.7B VoiceDesign', v: 'fp32，一個候選約 2～3 分鐘' }, { k: '最後一個候選產完卸載 Qwen', v: s.engine === 'qwen-comfy' ? '播放也用 Qwen，不卸載' : '騰 VRAM 給播放引擎', off: s.engine === 'qwen-comfy' }]}
        output={[
          { k: '候選 wav ×3' },
          {
            k: '鎖定',
            v:
              s.engine === 'irodori'
                ? '候選音登錄成 Irodori 參考音'
                : s.engine === 'zonos'
                  ? '候選音算成 ZONOS speaker embedding（存成 .npy）'
                  : '記住描述＋seed，每句重新設計',
          },
        ]}
      />

      <h2 className="flow-h">整理進圖鑑</h2>
      <Step
        n="C"
        title="圖鑑整理"
        where="core/glossary.ts organizeGlossary"
        input={[{ k: '這段的台詞' }, { k: '現有圖鑑', v: `${data.glossary.length} 條` }]}
        process={[{ k: 'LLM', v: 'json_schema' }]}
        output={[{ k: 'create／update 操作', v: '→ 名詞圖鑑' }]}
      />

      <h2 className="flow-h">上一段實際內容</h2>
      {session?.trace ? <TraceView t={session.trace} /> : <p className="hint">還沒有生成過。到聆聽送出一段後，這裡會顯示實際送給 LLM 的 messages 與模型的原始輸出。</p>}
    </div>
  );
}

const ROLE = { system: 'system', user: 'user（聽者）', assistant: 'assistant（她說過的）' } as const;

function TraceView({ t }: { t: SegmentTrace }) {
  const chars = t.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
  const status = t.status === 'streaming' ? '生成中' : t.status === 'done' ? '完成' : `失敗：${t.error}`;
  return (
    <div className="flow-trace">
      <p className="hint">
        {new Date(t.at).toLocaleString()}　<span className="mono">{t.model}</span>　{t.intimacy ? '親密模式' : '一般模式'}　{status}
        {t.ms !== undefined && `　整段 ${(t.ms / 1000).toFixed(1)} 秒`}
        {t.firstEventMs != null && `、第一句 ${(t.firstEventMs / 1000).toFixed(1)} 秒`}
        {t.state && t.stateMs != null && `、狀態 ${(t.stateMs / 1000).toFixed(1)} 秒（另外問一次）`}
      </p>
      <details className="flow-details">
        <summary>
          實際送出：{t.messages.length} 則 messages，共 {chars} 字
        </summary>
        {t.messages.map((m, i) => (
          <div key={i} className="flow-msg">
            <div className="flow-role">
              {i + 1}. {ROLE[m.role]}
            </div>
            <pre>{typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}</pre>
          </div>
        ))}
      </details>
      <details className="flow-details">
        <summary>輸出格式（json_schema）</summary>
        <pre>{JSON.stringify(t.schema, null, 2)}</pre>
      </details>
      <details className="flow-details">
        <summary>模型輸出（{t.raw ? `${t.raw.length} 字` : '還沒有'}）</summary>
        <pre>{t.status === 'done' ? JSON.stringify(JSON.parse(t.raw), null, 2) : '—'}</pre>
      </details>
      {t.state && (
        <details className="flow-details">
          <summary>第二次請求：只問狀態（最後一則指令＋state schema；模型輸出 {t.state.raw ? `${t.state.raw.length} 字` : '還沒有'}）</summary>
          <pre>{String(t.state.messages[t.state.messages.length - 1]?.content ?? '')}</pre>
          <pre>{JSON.stringify(t.state.schema, null, 2)}</pre>
          <pre>{t.state.raw ? JSON.stringify(JSON.parse(t.state.raw), null, 2) : '—'}</pre>
        </details>
      )}
    </div>
  );
}
