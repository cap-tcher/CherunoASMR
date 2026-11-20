// 提示詞模板：程式裡每一段送給 LLM（與 Qwen 聲音描述）的文字都在這裡，系統核心 › 提示詞分頁可逐欄修改、還原預設。
// 寫法：{{變數}} 會被代入；某一行用到的變數全部是空字串時，整行省略（例：角色卡沒填背景，就不出現「背景：」）。
// 用了不存在的變數 → 丟 TemplateError（不默默變空白）。

export class TemplateError extends Error {}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function templateVars(tpl: string): string[] {
  return [...new Set([...tpl.matchAll(VAR_RE)].map((m) => m[1]!))];
}

/** 代入變數；某行的變數全是空字串時省略整行。 */
export function fill(tpl: string, vars: Record<string, string>): string {
  const unknown = templateVars(tpl).filter((k) => !Object.hasOwn(vars, k));
  if (unknown.length) throw new TemplateError(`提示詞模板用了不存在的變數：${unknown.map((k) => `{{${k}}}`).join('、')}`);
  return tpl
    .split('\n')
    .filter((line) => {
      const used = templateVars(line);
      return !used.length || used.some((k) => vars[k]!.trim() !== '');
    })
    .map((line) => line.replace(VAR_RE, (_m, k: string) => vars[k]!))
    .join('\n');
}

export interface TemplateMeta {
  label: string;
  vars: Record<string, string>; // 可用變數 → 說明
  rows?: number;
}

type Group<K extends string> = Record<K, string>;

export interface PromptTemplates {
  segment: Group<
    | 'secCharacter' | 'secListener' | 'secScene' | 'secWorld' | 'secGlossary' | 'secMemories' | 'secHistory' | 'secSecret' | 'secStateFormat' | 'secStatDefs' | 'secStateNow' | 'secTone' | 'secOutput' | 'secOpening' | 'secIntimacyScript' | 'secSecretGen' | 'secretGenBody' | 'secClock' | 'clockBody'
    | 'card' | 'listener' | 'scene' | 'glossaryItem' | 'listItem'
    | 'fieldNumber' | 'fieldText' | 'fieldEnum' | 'fieldTags' | 'fieldZones' | 'fieldKv' | 'namesFixed' | 'namesFree'
    | 'output' | 'outputState' | 'stateAsk' | 'stateAskSecret' | 'translationZh' | 'translationZhEn'
    | 'modeInteractive' | 'modeInfinite' | 'modeSleep' | 'sleepDefault'
  >;
  character: Group<'system' | 'intro' | 'withImage' | 'direction' | 'tags' | 'filled' | 'secretTemplate' | 'fields' | 'hint_name' | 'hint_reading' | 'hint_subName' | 'hint_ageSex' | 'hint_relation' | 'hint_appearance' | 'hint_bio' | 'hint_personality' | 'hint_behavior' | 'hint_catchphrase' | 'hint_secret' | 'hint_voiceDesc'>;
  chapters: Group<'system' | 'latest' | 'noLatest' | 'body'>;
  fields: Group<'system'>;
  glossary: Group<'system' | 'user'>;
  voice: Group<'qwenDefault' | 'qwenWhisper' | 'qwenBreath' | 'qwenNormal'>;
}

export const DEFAULT_TEMPLATES: PromptTemplates = {
  segment: {
    secCharacter: '## 角色',
    secListener: '## 聽者（主角）',
    secScene: '## 情境',
    secWorld: '## 世界觀',
    secGlossary: '## 名詞圖鑑',
    secMemories: '## 回憶（跨次延續的記憶）',
    secHistory: '## 過去的聆聽',
    secSecret: '## 秘密（只有你知道，不可直接說出）',
    secStateFormat: '## 秘密狀態格式',
    secStatDefs: '## 數值與狀態定義',
    secStateNow: '## 目前的秘密狀態',
    secTone: '## 語氣（只影響演出，不改劇情與規則）',
    secOutput: '## 輸出格式',
    secIntimacyScript: '## 親密劇本',
    secSecretGen: '## 角色的秘密（還沒有）',
    secClock: '## 現在時刻',
    clockBody: '現在是 {{time}}。在 time 欄位寫這段結束時的時刻（HH:MM，24 小時制；照這段花的時間往後推，不會倒退）。',
    secretGenBody: '這個角色還沒有秘密。這段在 secret 欄位依下面的格式寫一段（正體中文，200 字內；之後每段都會帶，台詞裡不要說出來）：\n{{secretTemplate}}',
    secOpening: '## 開場',
    card: '名前：{{name}}（{{reading}}）\n年齢・性別：{{ageSex}}\n聴き手との関係：{{relation}}\n外見：{{appearance}}\n背景：{{bio}}\n性格：{{personality}}\n話し方・癖：{{behavior}}\n口癖：{{catchphrase}}',
    listener: '名前：{{nameWithReading}}\n呼び方：{{callName}}\n字幕での表記：{{subName}}\n性別：{{gender}}\n外見：{{appearance}}\nプロフィール：{{bio}}',
    scene: '名稱：{{name}}\n說明：{{desc}}',
    glossaryItem: '- {{term}}（読み：{{reading}}{{subNamePart}}）{{notePart}}',
    listItem: '- {{text}}',
    fieldNumber: '- {{key}}（{{label}}）：數字 {{min}}～{{max}}，每段最多變化 ±{{maxDelta}}',
    fieldText: '- {{key}}（{{label}}）：文字，最多 {{maxLength}} 字',
    fieldEnum: '- {{key}}（{{label}}）：只能是 {{options}}',
    fieldTags: '- {{key}}（{{label}}）：文字陣列，最多 {{maxItems}} 個、每個最多 {{maxLength}} 字；列出「現在成立」的全部 tag，沒列＝不再成立；需要說明時寫成「名稱：說明」',
    fieldZones: '- {{key}}（{{label}}）：可疊加清單，每項 {name, level, state}；{{nameRule}}；level 是 {{levelMin}}～{{levelMax}} 的整數、每項每段最多變化 ±{{maxDelta}}；只列這段有變化或新出現的項目，沒列出的維持原樣；其他欄位已經有的（例：心跳、心情）不要再放進來；沒有變化就給 []',
    fieldKv: '- {{key}}（{{label}}）：數值表，每項 {name, value}，value 是短文字；{{nameRule}}；只列這段有變化或新增的項目，沒列出的維持原樣；其他欄位已經有的不要再放進來；沒有變化就給 []',
    namesFixed: 'name 只能從這些選：{{names}}',
    namesFree: 'name 寫具體的名稱，不要用編號（部位1）或位置詞（left／right）',
    output:
      '輸出一個 JSON 物件（欄位如下）。\n- lines：{{lineRange}} 句台詞。ja 是{{charName}}對聽者說的日文（ASMR、二人稱、不寫聽者的台詞），難讀的漢字與名字寫成 {漢字|よみ}；{{translation}}；名字與名詞照圖鑑的讀み與譯名；voice 為 normal／whisper（囁き）／breath（吐息）；pos 是聲音在聽者頭部的位置（side：left／center／right，distance_cm：3～200）。\n- se：念這句之前的音效，沒有就給 []；id 只能用 {{seIds}}；side 同上。\n{{stateRule}}\n- actions：3 個聽者接下來可以做或說的事（正體中文，每個 ≤12 字）。\n- memory：這段裡出現、之後值得記得的新事實（正體中文，0～2 條，每條 ≤40 字；沒有就給 []）。',
    stateAsk: '照前面的「秘密狀態格式」與「數值與狀態定義」，只根據上面這段{{charName}}說的話，寫出這段結束時的秘密狀態：輸出 JSON 物件 {state}，state 的 key 是角色 id「{{charId}}」。{{secretPart}}',
    stateAskSecret: '{{charName}}還沒有秘密：另外依秘密生成格式寫一份放在 secret。',
    outputState: '- state：key 是角色 id「{{charId}}」，值是這段結束時的秘密狀態（格式見上）。秘密與狀態只寫在 state，絕不寫進台詞。',
    translationZh: 'zh 是正體中文翻譯（口語、每句 ≤16 字、句尾不加句號）',
    translationZhEn: 'zh 是正體中文翻譯（口語、每句 ≤16 字、句尾不加句號）；en 是英文翻譯',
    modeInteractive: '聽者說：「{{userInput}}」\n先直接回應這句話：要你做的事就照做並演出來（用台詞、whisper／breath、靠近的位置），問題就回答；再自然推進。用日文寫這一段。',
    modeInfinite: '聽者沒有說話。延續上一段正在做的事，往前推進一步（換個動作、話題或位置，不重複上一段的句子），寫下一段。',
    modeSleep: '睡眠模式：{{sleepInstruction}}\n寫下一段。',
    sleepDefault: '台詞逐漸變短、間隔變長，多用 whisper 與 breath。',
  },
  character: {
    system: '你是角色設計師，擅長日文 ASMR 音声作品的角色。只輸出符合 schema 的 JSON。',
    intro: '為日文 ASMR 作品設計一個角色，輸出角色卡 JSON。',
    withImage: '依照附上的角色圖決定外觀，並讓個性、聲音與外觀一致。',
    direction: '方向提示：{{direction}}',
    tags: '快速標籤：{{tags}}',
    filled: '以下欄位使用者已經填好，其他欄位要與它們一致：\n{{filled}}',
    secretTemplate: 'secret 欄依照下面的「秘密生成格式」逐項寫（保留項目標題，可多行）：\n{{template}}',
    fields: '各欄位：\n{{fields}}',
    hint_name: '角色名稱，日文表記＋括號讀み，例「澪（みお）」',
    hint_reading: '名字的平假名讀み',
    hint_subName: '字幕顯示用的名字（正體中文或原文）',
    hint_ageSex: '年齡與性別，例「20 歲 · 女」；角色一律是成年人',
    hint_relation: '與聽者的關係，例「隔壁的大學學姊」',
    hint_appearance: '外觀描述（正體中文，1～2 句）',
    hint_bio: '背景故事（正體中文，1～2 句）',
    hint_personality: '性格關鍵字（正體中文）',
    hint_behavior: '說話習慣與動作特徵（正體中文）',
    hint_catchphrase: '口頭禪（日文，用「」括起，2～3 個）',
    hint_secret: '只有角色知道、不會直接說出口的秘密（正體中文）',
    hint_voiceDesc: '聲音描述（日文，給音色設計用：年齡感、音高、氣聲、語速、距離感）',
  },
  chapters: {
    system:
      '你是故事編輯與檔案管理員，把對話紀錄整理成「章節」。\n- 如果新的段落是最新一章的延續：回傳 update（targetChapterId＝那一章的 id），延伸 range.end，摘要改寫成包含新事件。\n- 如果最新一章已經結束，或新段落開始了不同的場景：回傳 create（targetChapterId＝null）；跨度長可以回傳多個 create。\n- 摘要用正體中文 3～5 句，寫發生了什麼、聽者與角色之間有什麼變化；關鍵字 1～6 個（人名、地點、事件、物品），之後用來判斷要不要把這章帶進對話。\n- range 用段落序號（第幾段）。',
    latest: '=== 最新一章 ===\nid：{{id}}\n標題：{{title}}\n範圍：第 {{start}}～{{end}} 段\n摘要：{{summary}}',
    noLatest: '=== 最新一章 ===\n（還沒有章節）',
    body: '=== 要整理的段落 ===\n{{body}}',
  },
  glossary: {
    system:
      '你是名詞圖鑑管理員。讀這段台詞，把之後需要固定讀法或說明的名詞（人名、暱稱、地點、物品、反覆出現的事）整理成條目。\n- 新名詞用 create；已在「相關條目」裡的用 update（target 填它的表記），只填要改的欄位，不改的字串給空字串、陣列給 []。\n- reading 是日文讀み（假名），subName 是字幕用的正體中文譯名，synonyms 是別的叫法，related 是相關條目的表記，note 是給 LLM 的一句說明（正體中文）。\n- 一般名詞、不需要特別讀法或說明的不要建；沒有值得記的就回空的 glossary_ops。',
    user: '=== 台詞 ===\n{{text}}\n=== 相關條目 ===\n{{related}}',
  },
  fields: {
    system:
      '把「數值與狀態定義」整理成欄位表。key 用英數與底線；數值要有 min／max／每段最多變化 maxDelta（定義沒寫就給合理的小值，避免無限增值）；有固定選項的用 enum；短文字用 text 並給 maxLength；可增減的狀態標籤用 tags 並給 maxItems；不說出口的內心話設 hidden=true；會一直新增項目、每項有等級與狀態的（例：身體部位）用 zones；名稱對應短文字值、項目會增加的（例：心跳 70bpm、呼吸 急促）用 kv。',
  },
  voice: {
    qwenDefault: '若い女性の声。やわらかく落ち着いた、親しみのある話し方。',
    qwenNormal: '',
    qwenWhisper: '耳元でささやくように、とても小さな声で。',
    qwenBreath: '吐息まじりに、ほとんど息だけで。',
  },
};

const V = (o: Record<string, string>) => o;

/** 系統核心 › 提示詞分頁的欄位說明（標籤、可用變數）。 */
export const TEMPLATE_META: { [G in keyof PromptTemplates]: { title: string; desc: string; items: Record<keyof PromptTemplates[G], TemplateMeta> } } = {
  segment: {
    title: '每段生成',
    desc: '聆聽時每一段送給 LLM 的 system 與 user 訊息。系統核心規則、開場劇本、睡眠指令、狀態定義在「系統提示詞」「秘密規則」分頁。',
    items: {
      secCharacter: { label: '段落標題：角色', vars: {} },
      secListener: { label: '段落標題：聽者', vars: {} },
      secScene: { label: '段落標題：情境', vars: {} },
      secWorld: { label: '段落標題：世界觀', vars: {} },
      secGlossary: { label: '段落標題：名詞圖鑑', vars: {} },
      secMemories: { label: '段落標題：回憶', vars: {} },
      secHistory: { label: '段落標題：過去的聆聽', vars: {} },
      secSecret: { label: '段落標題：角色的秘密', vars: {} },
      secStateFormat: { label: '段落標題：秘密狀態格式', vars: {} },
      secStatDefs: { label: '段落標題：數值與狀態定義', vars: {} },
      secStateNow: { label: '段落標題：目前的秘密狀態', vars: {} },
      secTone: { label: '段落標題：語氣', vars: {} },
      secOutput: { label: '段落標題：輸出格式', vars: {} },
      secIntimacyScript: { label: '段落標題：親密劇本（親密模式每段帶）', vars: {} },
      secSecretGen: { label: '段落標題：角色還沒有秘密', vars: {} },
      secClock: { label: '段落標題：現在時刻（故事時鐘）', vars: {} },
      clockBody: { label: '故事時鐘說明', rows: 2, vars: V({ time: '現在時刻 HH:MM' }) },
      secretGenBody: { label: '角色還沒有秘密時的指示', rows: 3, vars: V({ secretTemplate: '秘密生成格式' }) },
      secOpening: { label: '段落標題：開場（只在第一段）', vars: {} },
      card: { label: '角色卡', rows: 8, vars: V({ name: '名字', reading: '讀み', ageSex: '年齡與性別', relation: '與你的關係', appearance: '外觀', bio: '背景', personality: '性格', behavior: '行為模組', catchphrase: '口頭禪' }) },
      listener: { label: '聽者（主角）', rows: 6, vars: V({ nameWithReading: '名字（含讀み）', callName: '她怎麼叫你', subName: '字幕名', gender: '性別', appearance: '外觀', bio: '關於你' }) },
      scene: { label: '情境', rows: 2, vars: V({ name: '情境名稱', desc: '說明' }) },
      glossaryItem: { label: '圖鑑的一條', vars: V({ term: '表記', reading: '讀み', subNamePart: '「／字幕：譯名」或空', notePart: '「：說明」或空' }) },
      listItem: { label: '回憶／歷史的一條', vars: V({ text: '內容' }) },
      fieldNumber: { label: '秘密狀態格式：數值欄', vars: V({ key: 'key', label: '名稱', min: '最小', max: '最大', maxDelta: '每段最多變化' }) },
      fieldText: { label: '秘密狀態格式：文字欄', vars: V({ key: 'key', label: '名稱', maxLength: '最多字數' }) },
      fieldEnum: { label: '秘密狀態格式：選項欄', vars: V({ key: 'key', label: '名稱', options: '選項（用／分隔）' }) },
      fieldTags: { label: '秘密狀態格式：標籤欄', vars: V({ key: 'key', label: '名稱', maxItems: '最多個數', maxLength: '每個最多字數' }) },
      fieldZones: { label: '秘密狀態格式：可疊加清單（部位）', vars: V({ key: 'key', label: '名稱', nameRule: '名稱規則（下面兩欄之一）', levelMin: 'Lv. 下限', levelMax: 'Lv. 上限', maxDelta: '每段最多變化' }) },
      fieldKv: { label: '秘密狀態格式：數值表', vars: V({ key: 'key', label: '名稱', nameRule: '名稱規則（下面兩欄之一）' }) },
      namesFixed: { label: '名稱規則：欄位表有設允許的名稱', vars: V({ names: '允許的名稱（用、分隔）' }) },
      namesFree: { label: '名稱規則：沒設允許的名稱（自由命名）', vars: {} },
      output: { label: '輸出格式說明', rows: 10, vars: V({ lineRange: '每段台詞句數（系統核心 › 系統提示詞設定）', charName: '角色名字', translation: '翻譯要求（下面兩欄之一）', seIds: '可用音效 id', charId: '角色 id（state 的 key）', stateRule: '親密模式才有的 state 說明（下一欄；一般模式整行省略）' }) },
      outputState: { label: '輸出格式：state 說明（親密模式）', rows: 3, vars: V({ charId: '角色 id' }) },
      stateAsk: { label: '狀態另外問一次：第二次請求的指令', rows: 3, vars: V({ charName: '角色名字', charId: '角色 id（state 的 key）', secretPart: '角色沒有秘密時的要求（下一欄；有秘密時是空的）' }) },
      stateAskSecret: { label: '狀態另外問一次：角色還沒有秘密時', rows: 2, vars: V({ charName: '角色名字' }) },
      translationZh: { label: '翻譯要求：繁中', vars: {} },
      translationZhEn: { label: '翻譯要求：繁中＋英文（字幕選 EN 時）', vars: {} },
      modeInteractive: { label: '本段指令：互動（聽者有說話）', rows: 2, vars: V({ userInput: '聽者說的話' }) },
      modeInfinite: { label: '本段指令：無限', rows: 2, vars: {} },
      modeSleep: { label: '本段指令：睡眠', rows: 2, vars: V({ sleepInstruction: '系統提示詞分頁的睡眠指令（空白時用下一欄）' }) },
      sleepDefault: { label: '睡眠指令空白時的內容', rows: 2, vars: {} },
    },
  },
  character: {
    title: '建立角色',
    desc: '「生成角色卡」送給 LLM 的訊息。欄位說明同時寫進 JSON schema 的 description。',
    items: {
      system: { label: 'system', rows: 2, vars: {} },
      intro: { label: '開頭', rows: 2, vars: {} },
      withImage: { label: '有角色圖時', rows: 2, vars: {} },
      direction: { label: '方向提示', vars: V({ direction: '方向提示文字' }) },
      tags: { label: '快速標籤', vars: V({ tags: '選的標籤（用、分隔）' }) },
      filled: { label: '已填欄位', rows: 2, vars: V({ filled: '使用者已填的欄位清單' }) },
      secretTemplate: { label: '秘密生成格式', rows: 2, vars: V({ template: '系統核心 › 秘密規則的秘密生成格式' }) },
      fields: { label: '欄位清單', rows: 2, vars: V({ fields: '各欄位說明（下面 12 欄）' }) },
      hint_name: { label: '欄位說明：名字', vars: {} },
      hint_reading: { label: '欄位說明：讀み', vars: {} },
      hint_subName: { label: '欄位說明：字幕名', vars: {} },
      hint_ageSex: { label: '欄位說明：年齡與性別', vars: {} },
      hint_relation: { label: '欄位說明：與你的關係', vars: {} },
      hint_appearance: { label: '欄位說明：外觀', vars: {} },
      hint_bio: { label: '欄位說明：背景', vars: {} },
      hint_personality: { label: '欄位說明：性格', vars: {} },
      hint_behavior: { label: '欄位說明：行為模組', vars: {} },
      hint_catchphrase: { label: '欄位說明：口頭禪', vars: {} },
      hint_secret: { label: '欄位說明：秘密', vars: {} },
      hint_voiceDesc: { label: '欄位說明：聲音描述', vars: {} },
    },
  },
  glossary: {
    title: '整理進名詞圖鑑',
    desc: '聆聽 › 段落操作「整理進圖鑑」送給 LLM 的訊息（ADV3.0 R4）。',
    items: {
      system: { label: 'system', rows: 8, vars: {} },
      user: { label: '台詞與相關條目', rows: 3, vars: V({ text: '這段的台詞', related: '圖鑑裡相關的條目（JSON）' }) },
    },
  },
  chapters: {
    title: '回憶 AI 整理',
    desc: '萬物之書 › 回憶「AI 整理」送給 LLM 的訊息（Chapter Manager）。',
    items: {
      system: { label: 'system', rows: 8, vars: {} },
      latest: { label: '最新一章', rows: 5, vars: V({ id: '章節 id', title: '標題', start: '起始段', end: '結束段', summary: '摘要' }) },
      noLatest: { label: '還沒有章節時', rows: 2, vars: {} },
      body: { label: '要整理的段落', rows: 2, vars: V({ body: '段落內容' }) },
    },
  },
  fields: {
    title: '由狀態定義產生欄位',
    desc: '系統核心 › 秘密規則「由狀態定義產生欄位」送給 LLM 的 system；user 是狀態定義本文。',
    items: { system: { label: 'system', rows: 5, vars: {} } },
  },
  voice: {
    title: '聲音（Qwen VoiceDesign）',
    desc: 'Qwen3-TTS VoiceDesign 的聲音描述：角色沒有聲音描述時用「預設」，每句再接上依 voice 的後綴。Irodori 的囁き 👂／吐息 😮‍💨 是模型的控制記號，不在這裡改。',
    items: {
      qwenDefault: { label: '預設聲音描述', rows: 2, vars: {} },
      qwenNormal: { label: '後綴：一般', vars: {} },
      qwenWhisper: { label: '後綴：囁き', vars: {} },
      qwenBreath: { label: '後綴：吐息', vars: {} },
    },
  },
};

/** 檢查整份模板：每欄只能用該欄說明裡列出的變數。回傳問題清單（空＝沒問題）。 */
export function checkTemplates(t: PromptTemplates): string[] {
  const problems: string[] = [];
  for (const g of Object.keys(TEMPLATE_META) as (keyof PromptTemplates)[]) {
    const meta = TEMPLATE_META[g].items as Record<string, TemplateMeta>;
    for (const [k, m] of Object.entries(meta)) {
      const tpl = (t[g] as Record<string, string>)[k];
      if (typeof tpl !== 'string') {
        problems.push(`${TEMPLATE_META[g].title} › ${m.label}：缺少`);
        continue;
      }
      const bad = templateVars(tpl).filter((v) => !Object.hasOwn(m.vars, v));
      if (bad.length) problems.push(`${TEMPLATE_META[g].title} › ${m.label}：不能用 ${bad.map((v) => `{{${v}}}`).join('、')}`);
    }
  }
  return problems;
}
