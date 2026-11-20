"""設定檔（YAML）→ dataclass。不認得的鍵直接報錯（打錯字不會被默默忽略）。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml


class ConfigError(ValueError):
    pass


@dataclass
class DatasetCfg:
    hf_repo: str = ""  # Hugging Face 資料集 id；和 local 擇一
    revision: str = "main"  # 建議固定成 commit sha，重跑才會一樣
    include: list[str] = field(default_factory=list)  # 只下載這些檔（glob），空＝全部
    local: list[str] = field(default_factory=list)  # 本機檔案（jsonl／json／parquet）；相對於執行資料夾


@dataclass
class FieldsCfg:
    """欄位對應：點號路徑（a.b.0.c）。turns 指到對話陣列；陣列元素裡用 role／content 取說話者與內容"""

    turns: str = ""
    role: str = "role"
    content: str = "content"
    system: str = ""  # 獨立的系統提示欄位；空＝從 turns 裡 role 為 system_roles 的那幾則取
    system_roles: list[str] = field(default_factory=lambda: ["system"])
    id: str = ""  # 空＝用內容雜湊當 id
    meta: dict[str, str] = field(default_factory=dict)  # 保留成 metadata 的欄位：{名稱: 路徑}


@dataclass
class ChunkCfg:
    mode: str = "conversation"  # conversation（整段，超過 max_chars 才切）｜window（固定輪數視窗）
    turns: int = 6  # window 模式每片幾輪
    stride: int = 3  # window 模式每次往後移幾輪
    max_chars: int = 800  # 片段內容上限（不含表頭）
    header_chars: int = 200  # 表頭裡系統提示最多留幾字（0＝不放）
    header_fields: list[str] = field(default_factory=list)  # 放進表頭的 meta 欄位
    role_labels: dict[str, str] = field(default_factory=dict)  # 說話者顯示名稱：{原本的 role: 顯示}


@dataclass
class EmbedCfg:
    backend: str = "lmstudio"  # lmstudio｜none（只用關鍵字）｜fake（測試用）
    base_url: str = "http://127.0.0.1:1234/v1"
    model: str = "text-embedding-bge-m3"
    batch: int = 32
    timeout: float = 300.0


@dataclass
class SearchCfg:
    mode: str = "hybrid"  # hybrid｜vector｜keyword
    vector_weight: float = 1.0
    keyword_weight: float = 1.0
    rrf_k: int = 60  # Reciprocal Rank Fusion 的常數


@dataclass
class Config:
    name: str = ""
    out: str = ""  # 預設 out/<name>（相對於執行資料夾）
    dataset: DatasetCfg = field(default_factory=DatasetCfg)
    fields: FieldsCfg = field(default_factory=FieldsCfg)
    filter: list[dict[str, Any]] = field(default_factory=list)
    chunk: ChunkCfg = field(default_factory=ChunkCfg)
    embed: EmbedCfg = field(default_factory=EmbedCfg)
    search: SearchCfg = field(default_factory=SearchCfg)
    base_dir: Path = field(default_factory=Path.cwd, repr=False)

    @property
    def out_dir(self) -> Path:
        p = Path(self.out) if self.out else Path("out") / self.name
        return p if p.is_absolute() else self.base_dir / p

    def snapshot(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("base_dir")
        return d

    def hash(self) -> str:
        return hashlib.sha256(json.dumps(self.snapshot(), ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]


def _build(cls, data: Any, where: str):
    if data is None:
        return cls()
    if not isinstance(data, dict):
        raise ConfigError(f"{where} 要是物件")
    known = {f.name for f in fields(cls)} - {"base_dir"}
    unknown = set(data) - known
    if unknown:
        raise ConfigError(f"{where} 有不認得的鍵：{', '.join(sorted(unknown))}（可用：{', '.join(sorted(known))}）")
    return cls(**data)


CHUNK_MODES = ("conversation", "window")
EMBED_BACKENDS = ("lmstudio", "none", "fake")
SEARCH_MODES = ("hybrid", "vector", "keyword")


def load_config(path: str | Path, base_dir: Path | None = None) -> Config:
    p = Path(path)
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ConfigError("設定檔最外層要是物件")
    top = {f.name for f in fields(Config)} - {"base_dir"}
    unknown = set(raw) - top
    if unknown:
        raise ConfigError(f"設定檔有不認得的鍵：{', '.join(sorted(unknown))}（可用：{', '.join(sorted(top))}）")
    cfg = Config(
        name=str(raw.get("name") or ""),
        out=str(raw.get("out") or ""),
        dataset=_build(DatasetCfg, raw.get("dataset"), "dataset"),
        fields=_build(FieldsCfg, raw.get("fields"), "fields"),
        filter=list(raw.get("filter") or []),
        chunk=_build(ChunkCfg, raw.get("chunk"), "chunk"),
        embed=_build(EmbedCfg, raw.get("embed"), "embed"),
        search=_build(SearchCfg, raw.get("search"), "search"),
        base_dir=base_dir or Path.cwd(),
    )
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    if not cfg.name or not all(c.isalnum() or c in "-_" for c in cfg.name):
        raise ConfigError("name 要填，只能用英數字、- 和 _（會當成輸出資料夾名稱）")
    if bool(cfg.dataset.hf_repo) == bool(cfg.dataset.local):
        raise ConfigError("dataset.hf_repo 和 dataset.local 要剛好填一個")
    if cfg.chunk.mode not in CHUNK_MODES:
        raise ConfigError(f"chunk.mode 要是 {'／'.join(CHUNK_MODES)}")
    if cfg.chunk.turns < 1 or cfg.chunk.stride < 1 or cfg.chunk.max_chars < 50:
        raise ConfigError("chunk.turns、chunk.stride 要 ≥ 1，chunk.max_chars 要 ≥ 50")
    if cfg.embed.backend not in EMBED_BACKENDS:
        raise ConfigError(f"embed.backend 要是 {'／'.join(EMBED_BACKENDS)}")
    if cfg.search.mode not in SEARCH_MODES:
        raise ConfigError(f"search.mode 要是 {'／'.join(SEARCH_MODES)}")
    if cfg.search.mode != "keyword" and cfg.embed.backend == "none":
        raise ConfigError("embed.backend 是 none（只用關鍵字）時，search.mode 要設 keyword")
    for i, r in enumerate(cfg.filter):
        if not isinstance(r, dict) or "type" not in r:
            raise ConfigError(f"filter 第 {i + 1} 條要是含 type 的物件")
