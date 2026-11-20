"""normalize：依設定的欄位對應，把各種結構的原始資料轉成統一的對話物件。"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass, field

from .config import Config
from .records import get_path, iter_records


@dataclass
class Conversation:
    id: str
    system: str
    turns: list[tuple[str, str]]  # (role, text)
    meta: dict = field(default_factory=dict)

    @property
    def n_chars(self) -> int:
        return len(self.system) + sum(len(t) for _r, t in self.turns)


def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, list):  # OpenAI 式內容陣列 [{type:text, text:…}]
        return "".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in v)
    return str(v)


def normalize_record(cfg: Config, fname: str, idx: int, rec: dict) -> Conversation | str:
    """成功回 Conversation；失敗回原因字串（記進 rejected）"""
    f = cfg.fields
    turns_raw = get_path(rec, f.turns)
    if not isinstance(turns_raw, list):
        return "normalize:turns_not_list"
    system_parts: list[str] = []
    if f.system:
        system_parts.append(_text(get_path(rec, f.system)))
    turns: list[tuple[str, str]] = []
    for t in turns_raw:
        if not isinstance(t, dict):
            return "normalize:turn_not_object"
        role = str(get_path(t, f.role) or "")
        text = _text(get_path(t, f.content)).strip()
        if not f.system and role in f.system_roles:
            system_parts.append(text)
            continue
        if text:
            turns.append((role, text))
    meta = {k: get_path(rec, p) for k, p in f.meta.items()}
    system = "\n".join(s for s in system_parts if s).strip()
    if f.id:
        rid = get_path(rec, f.id)
        if rid is None:
            return "normalize:missing_id"
        cid = str(rid)
    else:
        # 沒有 id 欄位：用內容雜湊（同樣的內容永遠同一個 id，重跑一樣）
        cid = hashlib.sha256(json.dumps([system, turns], ensure_ascii=False).encode()).hexdigest()[:16]
    return Conversation(cid, system, turns, meta)


def iter_conversations(cfg: Config, files, limit: int | None = None) -> Iterator[tuple[str, Conversation | str]]:
    """(來源標記, Conversation 或失敗原因)"""
    if not cfg.fields.turns:
        raise ValueError("fields.turns 沒填：先跑 inspect 看結構，再在設定檔填對話陣列的路徑")
    for fname, idx, rec in iter_records(files, limit):
        yield f"{fname}#{idx}", normalize_record(cfg, fname, idx, rec)
