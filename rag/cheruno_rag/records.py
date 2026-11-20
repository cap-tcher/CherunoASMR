"""讀原始資料（jsonl／json／parquet）成一筆筆 dict，以及點號路徑取值。"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

SUFFIXES = (".jsonl", ".json", ".parquet")


def get_path(obj: Any, path: str) -> Any:
    """a.b.0.c：dict 用鍵、list 用索引；路徑不存在回 None"""
    if not path:
        return None
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.lstrip("-").isdigit():
            i = int(part)
            cur = cur[i] if -len(cur) <= i < len(cur) else None
        else:
            return None
        if cur is None:
            return None
    return cur


def data_files(root: Path) -> list[Path]:
    """root 底下所有資料檔，路徑排序（重跑時順序一樣）"""
    if root.is_file():
        return [root]
    return sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in SUFFIXES)


def iter_file(path: Path) -> Iterator[dict]:
    suf = path.suffix.lower()
    if suf == ".jsonl":
        with path.open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)
    elif suf == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data if isinstance(data, list) else data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), list) else [data]
        yield from rows
    elif suf == ".parquet":
        import pyarrow.parquet as pq

        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=512):
            yield from batch.to_pylist()
    else:
        raise ValueError(f"不支援的檔案格式：{path.name}（支援 {', '.join(SUFFIXES)}）")


def iter_records(files: list[Path], limit: int | None = None) -> Iterator[tuple[str, int, dict]]:
    """(檔名, 檔內序號, 資料)；limit＝總共最多幾筆"""
    n = 0
    for p in files:
        for i, rec in enumerate(iter_file(p)):
            if limit is not None and n >= limit:
                return
            yield p.name, i, rec
            n += 1
