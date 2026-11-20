"""關鍵字檢索的 BM25（Okapi），存成稀疏陣列：build 時算好寫進索引，查詢只碰查詢詞的 posting。

rank_bm25.BM25Okapi 每個查詢詞都要用 Python 迴圈掃過全部片段、建索引時每片一個 dict：
5 萬片要 26 秒載入、1.8 GB 記憶體、每次查詢 1～3 秒（[[TASKS_RAG]] R-08 實測）。這裡的分數公式與它相同
（k1=1.5、b=0.75、負的 idf 換成 0.25×平均 idf；空片段當成一個 "\\0" 詞），測試逐片對照 rank_bm25。

檔案（都在 index/ 底下，用 .npy／.json 讓同樣的輸入寫出同樣的位元組，manifest 雜湊才穩定）：
  bm25_vocab.json   詞表（第 j 個詞的 id 是 j）
  bm25_indptr.npy   詞 j 的 posting 在 docs／tf 的 [indptr[j], indptr[j+1])
  bm25_docs.npy     posting 的片段編號（每個詞內遞增）
  bm25_tf.npy       該詞在該片段出現幾次
  bm25_doclen.npy   每片的詞數
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np

K1, B, EPSILON = 1.5, 0.75, 0.25
FILES = ("bm25_vocab.json", "bm25_indptr.npy", "bm25_docs.npy", "bm25_tf.npy", "bm25_doclen.npy")


def write(docs: list[list[str]], idx_dir: Path) -> None:
    docs = [t or ["\u0000"] for t in docs]
    vocab: dict[str, int] = {}
    terms: list[int] = []
    owners: list[int] = []
    freqs: list[int] = []
    for d, toks in enumerate(docs):
        for w, f in Counter(toks).items():
            terms.append(vocab.setdefault(w, len(vocab)))
            owners.append(d)
            freqs.append(f)
    t = np.asarray(terms, dtype=np.int64)
    order = np.argsort(t, kind="stable")  # 依詞排序；同一個詞內片段編號維持遞增
    indptr = np.zeros(len(vocab) + 1, dtype=np.int64)
    np.cumsum(np.bincount(t, minlength=len(vocab)), out=indptr[1:])
    (idx_dir / "bm25_vocab.json").write_text(json.dumps(list(vocab), ensure_ascii=False), encoding="utf-8")
    np.save(idx_dir / "bm25_indptr.npy", indptr)
    np.save(idx_dir / "bm25_docs.npy", np.asarray(owners, dtype=np.int32)[order])
    np.save(idx_dir / "bm25_tf.npy", np.asarray(freqs, dtype=np.int32)[order])
    np.save(idx_dir / "bm25_doclen.npy", np.asarray([len(x) for x in docs], dtype=np.int32))


class Bm25:
    def __init__(self, idx_dir: Path):
        missing = [f for f in FILES if not (idx_dir / f).is_file()]
        if missing:
            raise FileNotFoundError(f"索引缺少 {', '.join(missing)}（舊格式的索引）：重跑 build（向量有快取，只會重算斷詞）")
        self.vocab = {w: j for j, w in enumerate(json.loads((idx_dir / "bm25_vocab.json").read_text(encoding="utf-8")))}
        self.indptr = np.load(idx_dir / "bm25_indptr.npy")
        self.docs = np.load(idx_dir / "bm25_docs.npy")
        self.tf = np.load(idx_dir / "bm25_tf.npy").astype(np.float64)
        dl = np.load(idx_dir / "bm25_doclen.npy").astype(np.float64)
        self.n = len(dl)
        self.norm = K1 * (1 - B + B * dl / dl.mean())  # 分母裡和查詢無關的部分，先算好
        df = np.diff(self.indptr).astype(np.float64)
        idf = np.log(self.n - df + 0.5) - np.log(df + 0.5)
        idf[idf < 0] = EPSILON * idf.mean()
        self.idf = idf

    def scores(self, query_tokens: list[str]) -> np.ndarray:
        """每片的 BM25 分數；查詢詞重複就重複加（和 rank_bm25 相同）"""
        s = np.zeros(self.n, dtype=np.float64)
        for q in query_tokens:
            j = self.vocab.get(q)
            if j is None:
                continue
            a, b = self.indptr[j], self.indptr[j + 1]
            d = self.docs[a:b]
            f = self.tf[a:b]
            s[d] += self.idf[j] * (f * (K1 + 1) / (f + self.norm[d]))
        return s
