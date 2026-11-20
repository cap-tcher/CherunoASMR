// 由 Tools/llm/template_upgrades.mts 產生，不要手改。歷代 DEFAULT_TEMPLATES 裡和現在不同的舊預設值（12 個版本）。
export const TEMPLATE_UPGRADES: { group: string; key: string; from: string }[] = [
  {
    "group": "segment",
    "key": "modeInteractive",
    "from": "聽者說：「{{userInput}}」\n用日文回應，寫這一段。"
  },
  {
    "group": "segment",
    "key": "modeInfinite",
    "from": "聽者沒有說話。延續情境、自然推進，寫下一段。"
  },
  {
    "group": "segment",
    "key": "output",
    "from": "輸出一個 JSON 物件（欄位如下）。\n- lines：3～8 句台詞。ja 是{{charName}}對聽者說的日文（ASMR、二人稱、不寫聽者的台詞），難讀的漢字與名字寫成 {漢字|よみ}；{{translation}}；名字與名詞照圖鑑的讀み與譯名；voice 為 normal／whisper（囁き）／breath（吐息）；pos 是聲音在聽者頭部的位置（side：left／center／right，distance_cm：3～200）。\n- se：念這句之前的音效，沒有就給 []；id 只能用 {{seIds}}；side 同上。\n{{stateRule}}\n- actions：3 個聽者接下來可以做或說的事（正體中文，每個 ≤12 字）。\n- memory：這段裡出現、之後值得記得的新事實（正體中文，0～2 條，每條 ≤40 字；沒有就給 []）。"
  },
  {
    "group": "segment",
    "key": "fieldZones",
    "from": "- {{key}}（{{label}}）：可疊加清單，每項 {name, level, state}；level 是 {{levelMin}}～{{levelMax}} 的整數、每項每段最多變化 ±{{maxDelta}}；只列這段有變化或新出現的項目（新項目直接用新名稱），沒列出的維持原樣；沒有變化就給 []"
  },
  {
    "group": "segment",
    "key": "fieldKv",
    "from": "- {{key}}（{{label}}）：數值表，每項 {name, value}，value 是短文字（例：70bpm、急促）；只列這段有變化或新增的項目，沒列出的維持原樣；沒有變化就給 []"
  },
  {
    "group": "segment",
    "key": "listener",
    "from": "名前：{{nameWithReading}}\n呼び方：{{callName}}\n字幕での表記：{{subName}}\nプロフィール：{{bio}}"
  },
  {
    "group": "segment",
    "key": "output",
    "from": "輸出一個 JSON 物件：{\"lines\":[...], \"state\":{...}, \"actions\":[...], \"memory\":[...]}。\n- lines：3～8 句台詞。ja 是{{charName}}對聽者說的日文（ASMR、二人稱、不寫聽者的台詞），難讀的漢字與名字寫成 {漢字|よみ}；{{translation}}；名字與名詞照圖鑑的讀み與譯名；voice 為 normal／whisper（囁き）／breath（吐息）；pos 是聲音在聽者頭部的位置（side：left／center／right，distance_cm：3～200）。\n- se：念這句之前的音效，沒有就給 []；id 只能用 {{seIds}}；side 同上。\n- state：key 是角色 id「{{charId}}」，值是這段結束時的完整秘密狀態（格式見上）。秘密與狀態只寫在 state，絕不寫進台詞。\n- actions：3 個聽者接下來可以做或說的事（正體中文，每個 ≤12 字）。\n- memory：這段裡出現、之後值得記得的新事實（正體中文，0～2 條，每條 ≤40 字；沒有就給 []）。"
  },
  {
    "group": "segment",
    "key": "fieldTags",
    "from": "- {{key}}（{{label}}）：文字陣列，最多 {{maxItems}} 個、每個最多 {{maxLength}} 字；列出「現在成立」的全部 tag，沒列＝不再成立"
  },
  {
    "group": "fields",
    "key": "system",
    "from": "把「數值與狀態定義」整理成欄位表。key 用英數與底線；數值要有 min／max／每段最多變化 maxDelta（定義沒寫就給合理的小值，避免無限增值）；有固定選項的用 enum；短文字用 text 並給 maxLength；可增減的狀態標籤用 tags 並給 maxItems；不說出口的內心話設 hidden=true。"
  },
  {
    "group": "fields",
    "key": "system",
    "from": "把「數值與狀態定義」整理成欄位表。key 用英數與底線；數值要有 min／max／每段最多變化 maxDelta（定義沒寫就給合理的小值，避免無限增值）；有固定選項的用 enum；短文字用 text 並給 maxLength；可增減的狀態標籤用 tags 並給 maxItems；不說出口的內心話設 hidden=true；會一直新增項目、每項有等級與狀態的（例：身體部位）用 zones；名稱對應短文字值、項目會增加的（例：心跳 70bpm、呼吸 急促）用 kv。"
  },
  {
    "group": "segment",
    "key": "card",
    "from": "名前：{{name}}（{{reading}}）\n年齢・性別：{{ageSex}}\n聴き手との関係：{{relation}}\n外見：{{appearance}}\n背景：{{bio}}\n性格：{{personality}}\n話し方・癖：{{behavior}}\n口癖：{{catchphrase}}"
  },
  {
    "group": "segment",
    "key": "listener",
    "from": "名前：{{nameWithReading}}\n呼び方：{{callName}}\n字幕での表記：{{subName}}\n性別：{{gender}}\n外見：{{appearance}}\nプロフィール：{{bio}}"
  },
  {
    "group": "character",
    "key": "listener",
    "from": "聽者（角色說話的對象）：{{listener}}"
  },
];
