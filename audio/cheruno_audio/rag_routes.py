"""RAG 檢索 API（[[TASKS_RAG]] R-04）：讀 ragDir 底下 rag pipeline 建好的索引（<ragDir>/<名稱>/index/）。

GET  /rag/collections                                  有哪些索引（名稱、片段數、Embedding 後端與模型）
POST /rag/search {collection, query, k?, mode?, filters?} → {hits: [{id, score, header, text, meta}]}
POST /rag/import?name=<名稱>  body＝zip                    匯入別處建好的索引（[[PLAN_RAG索引匯入]]）
POST /rag/open-folder                                    用檔案總管開 ragDir（只限這台電腦呼叫）

索引第一次查時才載入，manifest 改了（重新 build）就自動重讀。錯誤照實回報：索引不存在 404、Embedding 連不上 503、
這個索引沒有向量卻要向量檢索 400。檢索程式和 pipeline 共用（cheruno_rag.search）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import paths


NAME_RE = r"^[A-Za-z0-9_-]+$"


def _index_prefix(names: list[str]) -> str:
    """zip 裡索引檔所在的資料夾（只認一個 manifest.json）：壓整個 <名稱> 資料夾＝<名稱>/index/，只壓 index＝index/ 或最上層"""
    mfs = [n for n in names if PurePosixPath(n).name == "manifest.json" and not n.endswith("/")]
    if len(mfs) != 1:
        raise HTTPException(400, "zip 裡要剛好有一個索引（manifest.json）：把 data\\rag\\out\\<名稱> 資料夾整個壓縮起來再匯入" if not mfs else f"zip 裡有 {len(mfs)} 個 manifest.json：一次匯入一個索引")
    parent = str(PurePosixPath(mfs[0]).parent)
    return "" if parent == "." else parent + "/"


def _extract_index(zip_path: Path, dest: Path) -> None:
    """只解出索引資料夾裡的檔；路徑有 .. 或絕對路徑就整個拒絕（不解出任何東西）"""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        raise HTTPException(400, "不是 zip 檔") from e
    with zf:
        names = [i.filename.replace("\\", "/") for i in zf.infolist()]
        for n in names:
            p = PurePosixPath(n)
            if p.is_absolute() or ".." in p.parts or re.match(r"^[A-Za-z]:", n):
                raise HTTPException(400, f"zip 裡有不安全的路徑：{n}")
        prefix = _index_prefix(names)
        dest.mkdir(parents=True)
        for info, n in zip(zf.infolist(), names):
            if info.is_dir() or not n.startswith(prefix):
                continue
            rel = n[len(prefix):]
            if "/" in rel:  # 索引資料夾底下不會有子資料夾
                continue
            with zf.open(info) as src, open(dest / rel, "wb") as out:
                shutil.copyfileobj(src, out)


class SearchBody(BaseModel):
    collection: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    query: str = Field(min_length=1, max_length=4000)
    k: int = Field(default=3, ge=1, le=20)
    mode: str | None = Field(default=None, pattern=r"^(hybrid|vector|keyword)$")  # 空＝建索引時設定檔的 search.mode
    filters: dict[str, str | int | float | bool] | None = None


def rag_router(rag_dir_of: Callable[[], Path] = lambda: paths.path("ragDir"), embedder=None) -> APIRouter:
    r = APIRouter(prefix="/rag")
    cache: dict[str, tuple[float, object]] = {}
    lock = threading.Lock()

    def index_of(name: str):
        from cheruno_rag.search import Index, IndexError_

        mf = rag_dir_of() / name / "index" / "manifest.json"
        if not mf.is_file():
            raise HTTPException(404, f"沒有索引「{name}」（{mf.parent}）：先用 rag pipeline build")
        mtime = mf.stat().st_mtime
        with lock:
            hit = cache.get(name)
            if hit and hit[0] == mtime:
                return hit[1]
            try:
                idx = Index(mf.parent, embedder=embedder)
            except IndexError_ as e:
                raise HTTPException(500, str(e)) from e
            cache[name] = (mtime, idx)
            return idx

    @r.get("/collections")
    def collections() -> dict:
        root = rag_dir_of()
        out = []
        if root.is_dir():
            for mf in sorted(root.glob("*/index/manifest.json")):
                if mf.parent.parent.name.startswith("."):  # 匯入中的暫存
                    continue
                m = json.loads(mf.read_text(encoding="utf-8"))
                out.append({"name": mf.parent.parent.name, "chunks": m["counts"]["chunks"], "embed": m["embed"], "search_mode": m["config"]["search"]["mode"]})
        return {"dir": str(root), "collections": out}

    @r.post("/search")
    def search(body: SearchBody) -> dict:
        from cheruno_rag.embed import EmbedError
        from cheruno_rag.search import IndexError_

        idx = index_of(body.collection)
        s = idx.manifest["config"]["search"]
        try:
            hits = idx.search(body.query, k=body.k, mode=body.mode or s["mode"], vector_weight=s["vector_weight"], keyword_weight=s["keyword_weight"], rrf_k=s["rrf_k"], filters=body.filters)
        except EmbedError as e:
            raise HTTPException(503, f"查詢的 Embedding 失敗：{e}") from e
        except IndexError_ as e:
            raise HTTPException(400, str(e)) from e
        return {"hits": [{"id": h.id, "score": h.score, "header": h.chunk["header"], "text": h.chunk["text"], "meta": h.chunk.get("meta", {})} for h in hits]}

    @r.post("/import")
    async def import_index(request: Request, name: str = Query(min_length=1, max_length=100, pattern=NAME_RE)) -> dict:
        """body 是 zip：解到 ragDir 底下的暫存資料夾、用檢索程式實際讀一次確認格式對，才改名成 <名稱>；失敗不留殘檔"""
        from cheruno_rag.search import Index, IndexError_

        root = rag_dir_of()
        final = root / name
        if final.exists():
            raise HTTPException(409, f"已經有叫「{name}」的索引（{final}）：把 zip 改個檔名再匯入，或先刪掉那個資料夾")
        root.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=".import-", dir=root))
        try:
            zip_path = work / "upload.zip"
            with open(zip_path, "wb") as f:
                async for chunk in request.stream():
                    f.write(chunk)
            if zip_path.stat().st_size == 0:
                raise HTTPException(400, "沒有收到檔案")
            idx_dir = work / name / "index"
            _extract_index(zip_path, idx_dir)
            try:
                idx = Index(idx_dir)
            except (IndexError_, OSError, ValueError, KeyError) as e:
                raise HTTPException(400, f"這個 zip 裡的索引讀不起來：{e}") from e
            chunks = idx.manifest["counts"]["chunks"]
            del idx
            zip_path.unlink()
            if final.exists():  # 上傳途中別人放了同名的
                raise HTTPException(409, f"已經有叫「{name}」的索引")
            (work / name).rename(final)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return {"name": name, "chunks": chunks, "dir": str(final)}

    @r.post("/open-folder")
    def open_folder(request: Request) -> dict:
        """用檔案總管開 ragDir；平板從區網連進來時開在電腦上沒意義，只限這台電腦"""
        if not request.client or request.client.host not in ("127.0.0.1", "::1", "localhost", "testclient"):
            raise HTTPException(403, "只能在跑 CherunoASMR 的這台電腦上開資料夾")
        root = rag_dir_of()
        root.mkdir(parents=True, exist_ok=True)
        os.startfile(str(root))  # type: ignore[attr-defined]  # Windows 才有；這個 app 只支援 Windows
        return {"dir": str(root)}

    return r
