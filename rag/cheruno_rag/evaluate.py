"""eval：檢索題庫 → hit@k、MRR。題庫 JSONL 每行 {"query": "...", "expect": {"ids": [...]} 或 {"meta": {鍵: 值}}}。

題目命中＝前 k 名裡有任何一個符合 expect（ids 裡的 chunk id，或 meta 全部相等）。
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from .config import Config
from .search import Hit, Index


def _match(h: Hit, expect: dict) -> bool:
    if "ids" in expect:
        return h.id in expect["ids"] or h.chunk.get("conv_id") in expect["ids"]
    if "meta" in expect:
        m = h.chunk.get("meta", {})
        return all(m.get(k) == v for k, v in expect["meta"].items())
    raise ValueError("expect 要有 ids 或 meta")


def _check_encoding(rows: list[dict], eval_file: Path) -> None:
    """題目被轉碼成 ? 或 U+FFFD（例：PowerShell 5.1 用 cp950 寫中日文）時直接報錯；不然會默默算出全 0 分"""
    for n, row in enumerate(rows, 1):
        q = "".join(str(row.get("query", "")).split())
        bad = q.count("?") + q.count("�")
        if not q or bad * 2 >= len(q):
            raise ValueError(f"{eval_file} 第 {n} 題的 query 是空的或大多是 ?／�（{bad}/{len(q)} 字）：中日文寫檔時被轉碼了。用 Python open(..., 'w', encoding='utf-8') 重寫題庫")


def evaluate(cfg: Config, eval_file: Path, ks: tuple[int, ...] = (1, 3, 5), index: Index | None = None) -> dict:
    idx = index or Index(cfg.out_dir / "index")
    rows = [json.loads(l) for l in eval_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not rows:
        raise ValueError(f"題庫是空的：{eval_file}")
    _check_encoding(rows, eval_file)
    kmax = max(ks)
    hits = {k: 0 for k in ks}
    rr = 0.0
    per = []
    for row in rows:
        res = idx.search(row["query"], k=kmax, mode=cfg.search.mode, vector_weight=cfg.search.vector_weight, keyword_weight=cfg.search.keyword_weight, rrf_k=cfg.search.rrf_k, filters=row.get("filters"))
        rank = next((i + 1 for i, h in enumerate(res) if _match(h, row["expect"])), None)
        for k in ks:
            hits[k] += rank is not None and rank <= k
        rr += 1.0 / rank if rank else 0.0
        per.append({"query_index": len(per), "rank": rank, "top_ids": [h.id for h in res]})
    result = {"questions": len(rows), **{f"hit@{k}": round(hits[k] / len(rows), 3) for k in ks}, "mrr": round(rr / len(rows), 3), "search": asdict(cfg.search)}
    rep = cfg.out_dir / "reports"
    rep.mkdir(parents=True, exist_ok=True)
    (rep / "eval.json").write_text(json.dumps({**result, "per_question": per}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(rows)} 題：" + "、".join(f"hit@{k} {result[f'hit@{k}']}" for k in ks) + f"、MRR {result['mrr']} → {rep / 'eval.json'}")
    return result
