"""檢索：向量（cosine）＋關鍵字（BM25）用 Reciprocal Rank Fusion 合併。pipeline 的 eval 與音訊服務的 /rag/search 共用。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .bm25 import Bm25
from .config import EmbedCfg
from .embed import make_embedder
from .tokenize_ja import tokenize


class IndexError_(RuntimeError):
    pass


@dataclass
class Hit:
    id: str
    score: float
    chunk: dict


class Index:
    def __init__(self, idx_dir: Path, embedder=None):
        self.dir = Path(idx_dir)
        mf = self.dir / "manifest.json"
        if not mf.is_file():
            raise IndexError_(f"索引不存在（{mf}）：先跑 build")
        self.manifest = json.loads(mf.read_text(encoding="utf-8"))
        self.chunks = [json.loads(l) for l in (self.dir / "chunks.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        try:
            self.bm25 = Bm25(self.dir)
        except FileNotFoundError as e:
            raise IndexError_(str(e)) from e
        if self.bm25.n != len(self.chunks):
            raise IndexError_("BM25 和 chunks.jsonl 筆數對不上：重新 build")
        ep = self.dir / "embeddings.npy"
        self.vecs = np.load(ep) if ep.is_file() else None
        if self.vecs is not None and len(self.vecs) != len(self.chunks):
            raise IndexError_("embeddings.npy 和 chunks.jsonl 筆數對不上：重新 build")
        e = self.manifest["embed"]
        if embedder is not None:
            self.embedder = embedder
        elif e["backend"] == "none":
            self.embedder = None
        else:
            # 查詢用建索引時的同一個後端與模型，向量才在同一個空間
            self.embedder = make_embedder(EmbedCfg(backend=e["backend"], model=e.get("model") or "", base_url=e.get("base_url") or EmbedCfg().base_url))

    def _filter_ok(self, c: dict, filters: dict | None) -> bool:
        if not filters:
            return True
        return all(c.get("meta", {}).get(k) == v for k, v in filters.items())

    def search(self, query: str, k: int = 5, mode: str = "hybrid", vector_weight: float = 1.0, keyword_weight: float = 1.0, rrf_k: int = 60, filters: dict | None = None, pool: int = 50) -> list[Hit]:
        if mode not in ("hybrid", "vector", "keyword"):
            raise ValueError(f"mode 要是 hybrid／vector／keyword：{mode}")
        if mode != "keyword" and (self.vecs is None or self.embedder is None):
            raise IndexError_("這個索引沒有向量（建索引時 embed.backend 是 none）：mode 用 keyword")
        # 沒有篩選條件就整個陣列直接算（不複製向量）；有條件時不符合的排到最後、也不給分
        mask = None if not filters else np.fromiter((self._filter_ok(c, filters) for c in self.chunks), dtype=bool, count=len(self.chunks))
        if mask is not None and not mask.any():
            return []
        score: dict[int, float] = {}
        if mode in ("hybrid", "keyword"):
            bm = self.bm25.scores(tokenize(query))
            if mask is not None:
                bm[~mask] = -np.inf
            order = np.argsort(-bm, kind="stable")[:pool]  # 同分照片段順序
            for r, i in enumerate(order.tolist()):
                if bm[i] > 0:
                    score[i] = score.get(i, 0.0) + keyword_weight / (rrf_k + r + 1)
        if mode in ("hybrid", "vector"):
            q = self.embedder([query])[0]
            sims = self.vecs @ q
            if mask is not None:
                sims[~mask] = -np.inf
            order = [i for i in np.argsort(-sims, kind="stable")[:pool].tolist() if mask is None or mask[i]]
            for r, i in enumerate(order):
                score[i] = score.get(i, 0.0) + vector_weight / (rrf_k + r + 1)
        top = sorted(score.items(), key=lambda p: (-p[1], self.chunks[p[0]]["id"]))[:k]
        return [Hit(self.chunks[i]["id"], round(s, 6), self.chunks[i]) for i, s in top]
