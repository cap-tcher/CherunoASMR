"""download：Hugging Face 資料集（固定 revision）→ <out>/raw/；本機檔案不用下載（直接讀）。"""

from __future__ import annotations

from fnmatch import fnmatch
from pathlib import Path

from .config import Config
from .records import data_files


def raw_files(cfg: Config) -> list[Path]:
    """這份設定要讀的資料檔（排序固定）"""
    if cfg.dataset.local:
        out: list[Path] = []
        for s in cfg.dataset.local:
            p = Path(s) if Path(s).is_absolute() else cfg.base_dir / s
            if not p.exists():
                raise FileNotFoundError(f"dataset.local 的檔案不存在：{p}")
            out.extend(data_files(p))
        return out
    raw = cfg.out_dir / "raw"
    # 只讀資料檔：跳過 huggingface_hub 的 .cache 等隱藏資料夾；設了 dataset.include 就只讀符合的（repo 裡的清單、說明檔不算資料）
    files = [p for p in data_files(raw) if not any(part.startswith(".") for part in p.relative_to(raw).parts)]
    if cfg.dataset.include:
        files = [p for p in files if any(fnmatch(p.relative_to(raw).as_posix(), pat) for pat in cfg.dataset.include)]
    if not files:
        raise FileNotFoundError(f"{raw} 沒有符合的資料檔：先跑 download（dataset.include：{cfg.dataset.include or '全部'}）")
    return files


def download(cfg: Config) -> list[Path]:
    if cfg.dataset.local:
        files = raw_files(cfg)
        print(f"本機資料檔 {len(files)} 個，不用下載")
        return files
    from huggingface_hub import snapshot_download

    raw = cfg.out_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=cfg.dataset.hf_repo,
        repo_type="dataset",
        revision=cfg.dataset.revision,
        local_dir=str(raw),
        allow_patterns=cfg.dataset.include or None,
    )
    files = data_files(raw)
    print(f"下載完成：{len(files)} 個資料檔 → {raw}")
    return files
