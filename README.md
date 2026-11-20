# CherunoASMR

用 LLM 即時寫日文 ASMR 台本、用本機語音合成念出來的 Windows app。角色、世界觀、規則都自己設定；每一段台詞附中文翻譯與角色狀態。

- 台本：本機 LLM（LM Studio）或雲端 API（Claude、Gemini、OpenAI，自己填金鑰）
- 語音：ZONOS3-Mini（每句即時合成）、Qwen3-TTS VoiceDesign（用文字描述設計角色的聲音）
- 全部東西放在這個資料夾裡：執行環境、模型、存檔都不會裝到別的地方（LM Studio 例外）

## 需要

- Windows 10／11（64 位元）
- NVIDIA 顯卡，建議顯存 8 GB 以上；驅動程式要支援 CUDA 12.8（R570 以後的版本）
- 硬碟空間：程式與環境約 4 GB，語音模型約 6 GB（只裝 ZONOS 約 1.5 GB）
- 網路（第一次安裝要下載）
- 要用本機 LLM：另外安裝 [LM Studio](https://lmstudio.ai) 並開過一次，在裡面下載模型。只用雲端 API 就不需要

## 安裝與啟動

1. 下載這個 repo（`git clone`，或按 GitHub 上的 Code → Download ZIP 解壓縮）。放在路徑只有英文字母、數字、`-`、`_` 的資料夾（不要有空格或中文），例如 `D:\CherunoASMR`
2. 雙擊 **`startserver.bat`**
   - 第一次會自動下載 uv、Node.js、Python 套件，然後問要裝哪些語音引擎（ZONOS、Qwen 聲音設計），選好就自動下載
   - 裝好後開啟瀏覽器 http://127.0.0.1:5173
3. 之後每次雙擊 `startserver.bat` 就直接開啟

| 檔案 | 做什麼 |
|---|---|
| `startserver.bat` | 啟動（第一次順便安裝） |
| `startserver.bat setup` | 重新選要裝的語音引擎（補裝） |
| `startserver.bat lan` | 讓同一個網路的平板也能連（畫面會列出網址） |
| `stopserver.bat` | 停掉這個資料夾開的所有程式（app、音訊服務、語音引擎） |
| `update.bat` | 更新到最新版（不動你的存檔、模型、執行環境） |
| `rag.bat` | 建自己的參考範例索引（見下面「參考範例（RAG）」） |

## 第一次使用

1. 系統核心 › 連線 › LLM：
   - LM Studio：按「LM Studio」快速填入 → 「連線」→ 選模型
   - 雲端：按「Claude」「Gemini」或「OpenAI」快速填入，把自己的 API key 貼到「API key」→ 「連線」→ 選模型。金鑰只存在 `data\settings.json`，不會進備份檔
2. 系統核心 › 連線 › 語音合成：選 ZONOS → 「連線」
3. 建立角色：寫聲音描述 → 用 Qwen 產生候選 → 鎖定（ZONOS 會用鎖定的候選當角色的聲音）
4. 聆聽：開始

## 參考範例（RAG）

生成台詞時，可以從你自己準備的對話資料裡找幾段相近的片段，放進提示詞當語氣和表達的參考（系統核心 › 生成方式 › 參考範例）。資料由你自己準備，這個 repo 不附任何資料集；沒有索引時這個功能不會動，生成照常。

建索引的步驟（指令都在這個資料夾執行，設定檔放 `data\rag\configs\`）：

1. 先跑過一次 `startserver.bat`（裝好環境）
2. 要用向量檢索：在 LM Studio 下載 Embedding 模型 `text-embedding-bge-m3`（搜尋 `bge-m3`），開著 LM Studio。只用關鍵字檢索就不需要
3. 複製 `rag\configs\example.yaml` 到 `data\rag\configs\<名稱>.yaml`，照註解填：
   - `name`：索引名稱（英數字、`-`、`_`）
   - `dataset`：Hugging Face 資料集 id，或本機的 `.jsonl`／`.json`／`.parquet`
   - 欄位結構不確定時先只填 `name` 和 `dataset`
4. 依序執行：
   ```
   rag.bat download --config configs\<名稱>.yaml      （本機檔案不用）
   rag.bat inspect  --config configs\<名稱>.yaml      → data\rag\out\<名稱>\reports\schema.json 看欄位結構
   ```
5. 照 `schema.json` 填設定檔的 `fields`（對話陣列在哪、說話者和內容的鍵），需要的話填 `filter`、`chunk`
6. 建索引：先 `rag.bat build --config configs\<名稱>.yaml --limit 200` 試跑，沒問題再拿掉 `--limit` 全量跑
7. 試搜尋：`rag.bat search --config configs\<名稱>.yaml "睡前陪伴" --text`
8. 重新開 `startserver.bat`，到系統核心 › 生成方式 › 參考範例 選這個索引

索引存在 `data\rag\out\<名稱>\index\`。設定檔的每個欄位、篩選規則、評估題庫的格式見 `rag\README.md`。

**用別人建好的索引**：在系統核心 › 生成方式 › 參考範例按「匯入索引（zip）」，選對方給的 zip。把 `data\rag\out\<名稱>` 資料夾整個壓縮起來就是這種 zip；zip 的檔名就是索引名稱，只能用英數字、`-`、`_`。app 會先檢查索引讀得起來才放進去，已經有同名的不會覆蓋。也可以按「開啟索引資料夾」，直接把索引資料夾放進 `data\rag\out\`，再按「重新整理」。

**分享自己的索引**：把 `data\rag\out\<名稱>` 壓成 zip 給對方。索引裡有原始資料的片段文字，分享前先確認資料的授權允許。

## 資料夾

| 資料夾 | 內容 |
|---|---|
| `runtime\` | uv、Node.js、Python、各引擎的環境與執行檔、ffmpeg（自動下載） |
| `models\` | 語音模型（自動下載；自己已經下載好的放法見 `models\README.md`） |
| `data\` | 存檔區：存檔、角色圖、聲音、紀錄；`data\logs\` 是各服務的紀錄；`data\rag\` 是參考範例的設定檔與索引 |

要把模型或存檔放到別的磁碟：在這個資料夾建 `cheruno.local.json` 覆蓋路徑（可用的項目見 `audio\cheruno_audio\paths.py`），存檔區也可以在 app 的存檔畫面換。

## 出問題時

- 啟動失敗：看 `data\logs\audio.log`、`app.log`
- 語音引擎起不來：看 `data\logs\zonos.log`、`qwen.log`；缺檔時系統核心 › 語音合成會寫缺什麼，執行 `startserver.bat setup` 補裝
- 下載中斷：重新執行 `startserver.bat`，會接著下載

## 授權

MIT（見 `LICENSE`）。下載的第三方元件與模型各有授權，見 `THIRD_PARTY_NOTICES.md`。
