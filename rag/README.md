# rag — 對話資料集 → 本機檢索索引

把對話資料集（Hugging Face 或本機 jsonl／json／parquet）建成本機索引，生成台詞時檢索相近的對話片段當參考。全部由設定檔驅動，程式裡不寫死任何資料集的欄位或內容規則；篩選只執行設定檔寫的規則。

## 指令
在 repo 根目錄用 `rag.bat <指令> --config configs\<name>.yaml`（先執行過一次 `startserver.bat` 裝好環境）：它在 `data\rag\` 底下執行，設定檔放 `data\rag\configs\`，索引輸出到 `data\rag\out\<name>\`，音訊服務預設就讀這裡，app 的「參考範例（RAG）」選得到。

```
rag.bat download --config configs\<name>.yaml
rag.bat inspect  --config configs\<name>.yaml [--limit N] [--sample N]
rag.bat build    --config configs\<name>.yaml [--limit N]
rag.bat eval     --config configs\<name>.yaml [--file 題庫.jsonl] [--min-hit5 0.6]
rag.bat search   --config configs\<name>.yaml "查詢" [-k 5] [--text]
```

不用 `rag.bat` 時，在放設定檔的資料夾執行（輸出到那裡的 `out/<name>/`）：

```
uv run --project <repo>/rag cheruno-rag download --config configs/<name>.yaml
uv run --project <repo>/rag cheruno-rag inspect  --config configs/<name>.yaml [--limit N] [--sample N]
uv run --project <repo>/rag cheruno-rag build    --config configs/<name>.yaml [--limit N]
uv run --project <repo>/rag cheruno-rag eval     --config configs/<name>.yaml [--file 題庫.jsonl] [--min-hit5 0.6]
uv run --project <repo>/rag cheruno-rag search   --config configs/<name>.yaml "查詢" [-k 5] [--text]
```

## 流程
1. **設定檔**：複製 `rag/configs/example.yaml`（用 `rag.bat` 時放到 `data\rag\configs\`），填 `name` 與 `dataset`
2. **download**（本機檔案不用）→ `out/<name>/raw/`
3. **inspect**：`reports/schema.json`（欄位路徑、型別、次數）、`stats.json`（字串長度、陣列長度、對話 role 種類）。要看內容加 `--sample N`（存到 `reports/samples.jsonl`）
4. **填 `fields`**：對話陣列路徑、role／content 鍵、系統提示、id、要留的 metadata
5. **填 `filter`**（選填）與 **`chunk`**
6. **build**：先 `--limit 200` 試跑，再全量。輸出 `out/<name>/index/`（`chunks.jsonl`、`embeddings.npy`、`bm25_*`（關鍵字檢索的稀疏陣列）、`manifest.json`）、`rejected.jsonl`（id＋淘汰原因）、`reports/build.json`
7. **eval**：題庫 JSONL 每行 `{"query": "...", "expect": {"ids": [...]}}` 或 `{"expect": {"meta": {"鍵": "值"}}}` → hit@k、MRR

## 元件
- Embedding：LM Studio 的 `/v1/embeddings`（預設 `text-embedding-bge-m3`，即 `ggml-org/bge-m3-Q8_0-GGUF`）；`embed.backend: none` 只用關鍵字
- 關鍵字：fugashi＋unidic-lite 斷詞、BM25 存成稀疏陣列（`cheruno_rag/bm25.py`，分數與 rank-bm25 相同、測試對照）
- 合併：Reciprocal Rank Fusion（`search.vector_weight`、`keyword_weight`、`rrf_k`）
- 儲存：numpy 陣列＋JSONL（不需要資料庫）

## 測試
`uv run --project rag pytest`（自造的假資料、fake Embedding，不需要 LM Studio）
