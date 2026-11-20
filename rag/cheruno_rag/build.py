"""build：normalize → filter → chunk → embed → index。輸出 <out>/index/（chunks.jsonl、embeddings.npy、bm25_*、manifest.json）與 <out>/rejected.jsonl、reports/build.json。"""

from __future__ import annotations

import hashlib
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np

from .chunk import chunk_conversation
from . import bm25
from .config import Config
from .download import raw_files
from .embed import make_embedder
from .filters import FilterChain
from .normalize import iter_conversations
from .tokenize_ja import tokenize


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


EMBED_GROUP = 512  # 每算完這麼多片就存一份快取、印一次進度


def _fmt_secs(s: float) -> str:
    s = int(s)
    return f"{s // 3600} 小時 {s % 3600 // 60} 分" if s >= 3600 else f"{s // 60} 分 {s % 60} 秒"


def _embed_cached(emb, texts: list[str], cache_dir: Path, model_key: str) -> np.ndarray:
    """向量分批算、每批存成 cache_dir/part_*.npz（鍵＝模型＋文字的雜湊）。中途斷掉重跑時，算過的直接讀快取。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    keys = [hashlib.sha256((model_key + "\0" + t).encode("utf-8")).hexdigest() for t in texts]
    have: dict[str, np.ndarray] = {}
    parts = sorted(cache_dir.glob("part_*.npz"))
    for p in parts:
        with np.load(p) as z:
            for k, v in zip(z["keys"], z["vecs"]):
                have[str(k)] = v
    todo = sorted({k: i for i, k in enumerate(keys) if k not in have}.values())
    total, done0 = len(texts), len(texts) - len(todo)
    if done0:
        print(f"向量快取已有 {done0}/{total} 片，剩 {len(todo)} 片要算", flush=True)
    t0 = time.time()
    n = len(parts)
    for g in range(0, len(todo), EMBED_GROUP):
        idxs = todo[g : g + EMBED_GROUP]
        vecs = emb([texts[i] for i in idxs])
        np.savez(cache_dir / f"part_{n:05d}.npz", keys=np.array([keys[i] for i in idxs]), vecs=vecs)
        n += 1
        for i, v in zip(idxs, vecs):
            have[keys[i]] = v
        done = g + len(idxs)
        el = time.time() - t0
        eta = el / done * (len(todo) - done)
        print(f"向量 {done0 + done}/{total}（{(done0 + done) * 100 // total}%）· 已過 {_fmt_secs(el)} · 估計還要 {_fmt_secs(eta)}", flush=True)
    return np.stack([have[k] for k in keys]).astype(np.float32)


def build(cfg: Config, limit: int | None = None, embedder=None) -> dict:
    t0 = time.time()
    files = raw_files(cfg)
    out = cfg.out_dir
    idx = out / "index"
    idx.mkdir(parents=True, exist_ok=True)
    (out / "reports").mkdir(parents=True, exist_ok=True)
    chain = FilterChain(cfg.filter)
    reasons: Counter = Counter()
    chunks = []
    kept = 0
    seen_ids: set[str] = set()
    with (out / "rejected.jsonl").open("w", encoding="utf-8") as rej:
        for src, conv in iter_conversations(cfg, files, limit):
            if isinstance(conv, str):
                reasons[conv] += 1
                rej.write(json.dumps({"src": src, "reason": conv}, ensure_ascii=False) + "\n")
                continue
            if conv.id in seen_ids:  # id 欄位重複：照 id 去重（內容雜湊 id 時＝完全相同的對話）
                reasons["normalize:duplicate_id"] += 1
                rej.write(json.dumps({"src": src, "id": conv.id, "reason": "normalize:duplicate_id"}, ensure_ascii=False) + "\n")
                continue
            seen_ids.add(conv.id)
            why = chain.check(conv)
            if why:
                reasons[f"filter:{why}"] += 1
                rej.write(json.dumps({"src": src, "id": conv.id, "reason": f"filter:{why}"}, ensure_ascii=False) + "\n")
                continue
            kept += 1
            chunks.extend(chunk_conversation(conv, cfg.chunk))
    if not chunks:
        raise RuntimeError("沒有任何片段：看 rejected.jsonl 與 reports/build.json 是哪條規則全擋掉了")
    with (idx / "chunks.jsonl").open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c.to_json(), ensure_ascii=False) + "\n")
    bm25.write([tokenize(c.embed_text()) for c in chunks], idx)
    (idx / "tokens.jsonl").unlink(missing_ok=True)  # 舊格式的斷詞檔（改存 bm25_*），留著會被算進 manifest
    emb = embedder if embedder is not None else make_embedder(cfg.embed)
    dim = 0
    emb_path = idx / "embeddings.npy"
    if emb is not None:
        model_key = f"{cfg.embed.backend}:{cfg.embed.model}" if embedder is None else f"injected:{getattr(emb, '__name__', type(emb).__name__)}"
        vecs = _embed_cached(emb, [c.embed_text() for c in chunks], out / "embed_cache", model_key)
        dim = int(vecs.shape[1])
        np.save(emb_path, vecs)
    elif emb_path.exists():
        emb_path.unlink()  # 改成只用關鍵字：舊的向量檔不留，免得對不上
    lens = sorted(len(c.text) for c in chunks)
    pct = lambda q: lens[min(len(lens) - 1, int(q * (len(lens) - 1)))]  # noqa: E731
    manifest = {
        "name": cfg.name,
        "dataset": {"hf_repo": cfg.dataset.hf_repo, "revision": cfg.dataset.revision, "local": cfg.dataset.local},
        "config_hash": cfg.hash(),
        "config": cfg.snapshot(),
        "limit": limit,
        "counts": {"conversations_kept": kept, "rejected": sum(reasons.values()), "chunks": len(chunks)},
        "embed": {"backend": cfg.embed.backend, "model": cfg.embed.model if cfg.embed.backend == "lmstudio" else None, "base_url": cfg.embed.base_url if cfg.embed.backend == "lmstudio" else None, "dim": dim},
        "files": {p.name: _sha(p) for p in sorted(idx.iterdir()) if p.is_file() and p.name != "manifest.json"},
    }
    (idx / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    report = {
        "conversations_kept": kept,
        "rejected_by_reason": dict(reasons.most_common()),
        "filter_counts": dict(chain.counts),
        "chunks": len(chunks),
        "chunk_chars": {"min": lens[0], "p50": pct(0.5), "p90": pct(0.9), "max": lens[-1]},
        "embed_dim": dim,
        "seconds": round(time.time() - t0, 1),
    }
    (out / "reports" / "build.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"保留 {kept} 段對話 → {len(chunks)} 個片段；淘汰 {sum(reasons.values())}（{dict(reasons.most_common())}）")
    print(f"片段字數 p50 {report['chunk_chars']['p50']}、p90 {report['chunk_chars']['p90']}；向量 {dim} 維；{report['seconds']} 秒 → {idx}")
    return report
