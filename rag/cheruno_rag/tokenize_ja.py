"""關鍵字檢索用的日文斷詞：fugashi＋unidic-lite（[[Research_RAG架構]]）。中文、英文混在一起也能切（unidic 會切成單字或字元）。"""

from __future__ import annotations

import unicodedata
from functools import lru_cache

_SKIP_POS = {"補助記号", "空白"}


@lru_cache(maxsize=1)
def _tagger():
    import fugashi

    return fugashi.Tagger()


def tokenize(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).lower()
    out = []
    for w in _tagger()(text):
        pos = getattr(w.feature, "pos1", None) or ""
        if pos in _SKIP_POS or not w.surface.strip():
            continue
        out.append(w.surface)
    return out
