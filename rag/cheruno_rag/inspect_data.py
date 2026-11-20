"""inspect：只輸出結構與統計（欄位路徑、型別、出現次數、字串長度分布、陣列長度分布、對話裡 role 的種類）。

內容抽樣只有加 --sample N 才寫進 reports/samples.jsonl（給使用者與 Codex 看；Claude 不讀）。
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .config import Config
from .download import raw_files
from .records import get_path, iter_records


def _dist(xs: list[int]) -> dict[str, int]:
    if not xs:
        return {}
    s = sorted(xs)
    pick = lambda q: s[min(len(s) - 1, int(q * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "min": s[0], "p50": pick(0.5), "p90": pick(0.9), "p99": pick(0.99), "max": s[-1]}


def _walk(obj: Any, path: str, types: dict, strlen: dict, listlen: dict, depth: int = 0) -> None:
    """把結構拍平：list 元素合併成 path[]（看的是元素的共同結構）"""
    t = type(obj).__name__
    types[path][t] += 1
    if isinstance(obj, str):
        strlen[path].append(len(obj))
    elif isinstance(obj, list):
        listlen[path].append(len(obj))
        if depth < 6:
            for x in obj:
                _walk(x, f"{path}[]", types, strlen, listlen, depth + 1)
    elif isinstance(obj, dict) and depth < 6:
        for k, v in obj.items():
            _walk(v, f"{path}.{k}" if path else str(k), types, strlen, listlen, depth + 1)


def inspect(cfg: Config, limit: int | None = None, sample: int = 0) -> dict:
    files = raw_files(cfg)
    rep = cfg.out_dir / "reports"
    rep.mkdir(parents=True, exist_ok=True)
    types: dict[str, Counter] = defaultdict(Counter)
    strlen: dict[str, list[int]] = defaultdict(list)
    listlen: dict[str, list[int]] = defaultdict(list)
    roles: Counter = Counter()
    n = 0
    samples = []
    for _fname, _i, rec in iter_records(files, limit):
        n += 1
        _walk(rec, "", types, strlen, listlen)
        if cfg.fields.turns:
            turns = get_path(rec, cfg.fields.turns)
            if isinstance(turns, list):
                for t in turns:
                    r = get_path(t, cfg.fields.role) if isinstance(t, dict) else None
                    roles[str(r)] += 1
        if sample and len(samples) < sample:
            samples.append(rec)
    schema = {p: {"types": dict(c), "count": sum(c.values())} for p, c in sorted(types.items())}
    stats = {
        "records": n,
        "files": [p.name for p in files],
        "string_length": {p: _dist(v) for p, v in sorted(strlen.items())},
        "list_length": {p: _dist(v) for p, v in sorted(listlen.items())},
        "turn_roles": dict(roles.most_common()) if cfg.fields.turns else None,
    }
    (rep / "schema.json").write_text(json.dumps(schema, ensure_ascii=False, indent=1), encoding="utf-8")
    (rep / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    if sample:
        with (rep / "samples.jsonl").open("w", encoding="utf-8") as f:
            for s in samples:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
    # 畫面上只印結構（欄位路徑、型別、筆數），不印內容
    print(f"資料 {n} 筆，{len(files)} 個檔；欄位結構（路徑：型別×次數）：")
    for p, info in schema.items():
        if p:
            print(f"  {p}：{', '.join(f'{t}×{c}' for t, c in info['types'].items())}")
    if roles:
        print(f"對話 role 種類：{dict(roles.most_common())}")
    print(f"報告：{rep / 'schema.json'}、{rep / 'stats.json'}" + (f"、{rep / 'samples.jsonl'}（{len(samples)} 筆抽樣）" if sample else ""))
    return {"schema": schema, "stats": stats}


def report_dir(cfg: Config) -> Path:
    return cfg.out_dir / "reports"
