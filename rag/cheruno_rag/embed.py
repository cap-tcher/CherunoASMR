"""Embedding 後端：lmstudio（OpenAI 相容 /v1/embeddings）｜fake（測試用、確定性）｜none（只用關鍵字）。

HTTP 一律用 httpx：Python 內建 urllib 讀大批次回應在 Windows 上會被重設（[[Research_RAG架構]] R-01 實測）。
向量都做 L2 正規化，之後用內積就是 cosine。
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable

import httpx
import numpy as np

from .config import EmbedCfg


class EmbedError(RuntimeError):
    pass


def _l2(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return (m / n).astype(np.float32)


def fake_embed(texts: list[str], dim: int = 256) -> np.ndarray:
    """測試用：字元 2-gram 雜湊成向量（同樣的字串永遠同一個向量，字面越像越接近）"""
    m = np.zeros((len(texts), dim), dtype=np.float32)
    for i, t in enumerate(texts):
        for j in range(len(t) - 1):
            h = int.from_bytes(hashlib.blake2b(t[j : j + 2].encode(), digest_size=4).digest(), "little")
            m[i, h % dim] += 1.0
    return _l2(m)


class LmStudioEmbedder:
    def __init__(self, cfg: EmbedCfg, client: httpx.Client | None = None):
        self.cfg = cfg
        self.client = client or httpx.Client(timeout=cfg.timeout)

    def __call__(self, texts: list[str]) -> np.ndarray:
        out = []
        for i in range(0, len(texts), self.cfg.batch):
            part = texts[i : i + self.cfg.batch]
            try:
                r = self.client.post(self.cfg.base_url.rstrip("/") + "/embeddings", json={"model": self.cfg.model, "input": part})
            except httpx.ConnectError as e:
                raise EmbedError(f"連不上 Embedding 服務（{self.cfg.base_url}）：LM Studio 的 server 要開著、載入 {self.cfg.model}") from e
            except httpx.HTTPError as e:
                raise EmbedError(f"Embedding 請求失敗：{e!r}") from e
            if r.status_code != 200:
                raise EmbedError(f"Embedding 回 {r.status_code}：{r.text[:300]}")
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            if len(data) != len(part):
                raise EmbedError(f"Embedding 回了 {len(data)} 筆，送了 {len(part)} 筆")
            out.extend(d["embedding"] for d in data)
        return _l2(np.asarray(out, dtype=np.float32))


def make_embedder(cfg: EmbedCfg) -> Callable[[list[str]], np.ndarray] | None:
    if cfg.backend == "none":
        return None
    if cfg.backend == "fake":
        return fake_embed
    return LmStudioEmbedder(cfg)
