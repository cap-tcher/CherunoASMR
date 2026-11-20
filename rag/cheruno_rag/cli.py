"""cheruno-rag {download,inspect,build,eval,search} --config <yaml>"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import ConfigError, load_config


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="cheruno-rag", description="CherunoASMR 的 RAG 離線建置（設定檔驅動）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, help_ in (("download", "下載資料集（本機檔案不用）"), ("inspect", "看欄位結構與統計"), ("build", "建索引"), ("eval", "跑檢索題庫"), ("search", "試查（印片段 id 與分數）")):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--config", required=True)
        if name in ("inspect", "build"):
            p.add_argument("--limit", type=int, default=None, help="只處理前 N 筆（先小量試跑）")
        if name == "inspect":
            p.add_argument("--sample", type=int, default=0, help="另存 N 筆內容抽樣到 reports/samples.jsonl")
        if name == "eval":
            p.add_argument("--file", default=None, help="題庫（預設 configs/<名稱>.eval.jsonl）")
            p.add_argument("--min-hit5", type=float, default=None, help="hit@5 低於這個值就回傳失敗")
        if name == "search":
            p.add_argument("query")
            p.add_argument("-k", type=int, default=5)
            p.add_argument("--text", action="store_true", help="一併印出片段內容")
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config)
    except (ConfigError, OSError) as e:
        print(f"設定檔錯誤：{e}", file=sys.stderr)
        return 2
    if a.cmd == "download":
        from .download import download

        download(cfg)
    elif a.cmd == "inspect":
        from .inspect_data import inspect

        inspect(cfg, a.limit, a.sample)
    elif a.cmd == "build":
        from .build import build

        build(cfg, a.limit)
    elif a.cmd == "eval":
        from .evaluate import evaluate

        f = Path(a.file) if a.file else Path(a.config).with_suffix("").with_suffix(".eval.jsonl")
        r = evaluate(cfg, f)
        if a.min_hit5 is not None and r.get("hit@5", 0) < a.min_hit5:
            print(f"hit@5 {r['hit@5']} 低於門檻 {a.min_hit5}", file=sys.stderr)
            return 1
    elif a.cmd == "search":
        from .search import Index

        idx = Index(cfg.out_dir / "index")
        for h in idx.search(a.query, k=a.k, mode=cfg.search.mode, vector_weight=cfg.search.vector_weight, keyword_weight=cfg.search.keyword_weight, rrf_k=cfg.search.rrf_k):
            print(f"{h.score:.4f}  {h.id}" + (f"\n{h.chunk['header']}\n{h.chunk['text']}\n" if a.text else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
