"""chunk：對話 → 片段。保留前後文：conversation＝整段（超過 max_chars 才切成視窗）；window＝固定輪數、可重疊。"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .config import ChunkCfg
from .normalize import Conversation


@dataclass
class Chunk:
    id: str
    conv_id: str
    header: str
    text: str
    turn_from: int
    turn_to: int  # 不含
    meta: dict

    def embed_text(self) -> str:
        return f"{self.header}\n{self.text}" if self.header else self.text

    def to_json(self) -> dict:
        d = asdict(self)
        d["n_chars"] = len(self.text)
        return d


def _header(c: Conversation, cfg: ChunkCfg) -> str:
    parts = []
    for k in cfg.header_fields:
        v = c.meta.get(k)
        if v not in (None, "", [], {}):
            parts.append(f"{k}: {v}")
    if cfg.header_chars and c.system:
        parts.append(c.system[: cfg.header_chars])
    return "\n".join(parts)


def _lines(c: Conversation, a: int, b: int, cfg: ChunkCfg) -> list[str]:
    return [f"{cfg.role_labels.get(r, r)}：{t}" for r, t in c.turns[a:b]]


def _fit(c: Conversation, a: int, b: int, cfg: ChunkCfg) -> int:
    """從 a 開始、最多到 b，字數不超過 max_chars 的最遠位置（至少一輪；單輪太長就截字）"""
    n = 0
    for i in range(a, b):
        n += len(c.turns[i][1]) + len(c.turns[i][0]) + 2
        if n > cfg.max_chars and i > a:
            return i
    return b


def chunk_conversation(c: Conversation, cfg: ChunkCfg) -> list[Chunk]:
    if not c.turns:
        return []
    header = _header(c, cfg)
    spans: list[tuple[int, int]] = []
    if cfg.mode == "conversation":
        total = sum(len(t) + len(r) + 2 for r, t in c.turns)
        if total <= cfg.max_chars:
            spans = [(0, len(c.turns))]
    if not spans:  # window 模式，或整段太長
        size = cfg.turns if cfg.mode == "window" else len(c.turns)
        a = 0
        while a < len(c.turns):
            b = _fit(c, a, min(len(c.turns), a + size), cfg)
            spans.append((a, b))
            if b >= len(c.turns):
                break
            step = cfg.stride if cfg.mode == "window" else max(1, b - a)
            a = max(a + 1, min(a + step, b))
    out = []
    for i, (a, b) in enumerate(spans):
        text = "\n".join(_lines(c, a, b, cfg))
        if len(text) > cfg.max_chars:
            text = text[: cfg.max_chars]
        out.append(Chunk(f"{c.id}#{i}", c.id, header, text, a, b, c.meta))
    return out
