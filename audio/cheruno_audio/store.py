"""存檔區（[[PLAN_存檔區與語音庫]]）：app 的所有資料都存在本機資料夾 CHERUNO_DATA_DIR，不放瀏覽器。

<root>/settings.json                   這台電腦的設定（連線、TTS、音訊；所有存檔共用）
<root>/saves/<id>.json                 一個存檔：{meta, data, session}；圖片、語音只寫庫的 key
<root>/library/voice/<key>.wav         台詞語音；key = sha256(引擎|聲音|seed|步數|語氣|文字)（合成前就算得出來，用來查庫）
<root>/library/image/<sha256>.<ext>    角色圖（key = 內容 sha256）
<root>/library/refvoice/<sha256>.wav   鎖定聲音時的參考音（key = 內容 sha256）
<root>/library/library.db              SQLite 索引：assets(key, kind, ext, bytes, meta, created_at)
<root>/trash/                          刪掉的存檔、清理掉的庫檔（不直接消失）

庫檔不可變（同 key 同內容），所以多個存檔可以共用；刪存檔不刪庫檔，「未引用」清單由使用者確認後才清。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
import wave
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
KEY = re.compile(r"^[0-9a-f]{64}$")
KINDS = {"voice": {"wav"}, "image": {"jpg", "png", "webp"}, "refvoice": {"wav"}}
MIME = {"wav": "audio/wav", "jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def voice_key(engine: str, speaker: str, seed: int | None, steps: int | None, voice: str, text: str) -> str:
    """同一組合成參數＝同一個 key（app 端用同樣的字串算，見 app/src/library.ts）"""
    raw = "|".join([engine, speaker, "" if seed is None else str(seed), "" if steps is None else str(steps), voice, text])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_json(path: Path, obj: Any) -> None:
    _write_bytes(path, json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"{path} 內容損壞：{e}") from e


def _b64(s: str) -> bytes:
    try:
        return base64.b64decode(s, validate=True)
    except binascii.Error as e:
        raise HTTPException(400, "data_base64 不是合法的 base64") from e


def _wav_seconds(data: bytes) -> float:
    try:
        with wave.open(io.BytesIO(data)) as w:
            return w.getnframes() / w.getframerate()
    except (wave.Error, EOFError) as e:
        raise HTTPException(400, f"不是可讀的 WAV：{e}") from e


def _keys_in(obj: Any) -> Iterator[str]:
    """存檔裡引用到的庫 key（任何 64 位十六進位字串）"""
    if isinstance(obj, str):
        if KEY.match(obj):
            yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _keys_in(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys_in(v)


class NewSave(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    data: dict
    session: dict | None = None


class Rename(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class VoiceBody(BaseModel):
    engine: str
    speaker: str
    seed: int | None = None
    steps: int | None = None
    voice: str
    text: str = Field(min_length=1, max_length=400)
    data_base64: str


class AssetBody(BaseModel):
    ext: str
    data_base64: str
    meta: dict = Field(default_factory=dict)


class Library:
    """library.db：庫檔索引。sqlite 連線每次開關（FastAPI 同步端點跑在 thread pool）。"""

    def __init__(self, root: Path):
        self.dir = root / "library"
        self.db = self.dir / "library.db"
        self.dir.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS assets (key TEXT NOT NULL, kind TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, meta TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, key))")

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        # sqlite3 的 with 只管 commit、不關連線；Windows 上沒關會一直占著檔案
        c = sqlite3.connect(self.db, timeout=10)
        try:
            with c:
                yield c
        finally:
            c.close()

    def path(self, kind: str, key: str, ext: str) -> Path:
        return self.dir / kind / f"{key}.{ext}"

    def put(self, kind: str, key: str, ext: str, data: bytes, meta: dict) -> dict:
        f = self.path(kind, key, ext)
        if not f.is_file():
            _write_bytes(f, data)
        with self._conn() as c:
            c.execute("INSERT OR IGNORE INTO assets VALUES (?, ?, ?, ?, ?, ?)", (key, kind, ext, len(data), json.dumps(meta, ensure_ascii=False), _now()))
        return {"key": key, "kind": kind, "bytes": len(data), **meta}

    def get(self, kind: str, key: str) -> tuple[str, dict] | None:
        with self._conn() as c:
            row = c.execute("SELECT ext, meta FROM assets WHERE kind = ? AND key = ?", (kind, key)).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    def all(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT key, kind, ext, bytes, meta, created_at FROM assets ORDER BY created_at").fetchall()
        return [{"key": k, "kind": kd, "ext": e, "bytes": b, "meta": json.loads(m), "createdAt": t} for k, kd, e, b, m, t in rows]

    def remove(self, kind: str, key: str, ext: str, trash: Path) -> None:
        f = self.path(kind, key, ext)
        if f.is_file():
            dest = trash / "library" / kind / f.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(dest))
        with self._conn() as c:
            c.execute("DELETE FROM assets WHERE kind = ? AND key = ?", (kind, key))


def store_router(root_of: Callable[[], Path | None]) -> APIRouter:
    r = APIRouter(prefix="/store")
    lock = threading.Lock()  # 存檔 JSON 的讀改寫（data 與 session 分開寫進同一個檔）
    libs: dict[Path, Library] = {}

    def root() -> Path:
        p = root_of()
        if p is None:
            raise HTTPException(503, "還沒選存檔區：到存檔畫面選一個資料夾（POST /store/datadir）")
        return p

    def lib() -> Library:
        p = root()
        if p not in libs:
            libs[p] = Library(p)
        return libs[p]

    def save_file(sid: str) -> Path:
        if not ID.match(sid):
            raise HTTPException(400, f"不合法的存檔 id：{sid}")
        f = root() / "saves" / f"{sid}.json"
        if not f.is_file():
            raise HTTPException(404, f"找不到存檔 {sid}")
        return f

    async def body_object(req: Request) -> dict:
        try:
            obj = await req.json()
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"不是 JSON：{e}") from e
        if not isinstance(obj, dict):
            raise HTTPException(400, "內容要是 JSON 物件")
        return obj

    def update(sid: str, part: str, value: Any) -> dict:
        with lock:
            f = save_file(sid)
            s = _read_json(f)
            s[part] = value
            s["meta"]["updatedAt"] = _now()
            _write_json(f, s)
            return s["meta"]

    def referenced() -> set[str]:
        d = root() / "saves"
        keys: set[str] = set()
        for f in d.glob("*.json") if d.is_dir() else []:
            keys.update(_keys_in(_read_json(f)))
        return keys

    def check_kind_key(kind: str, key: str) -> None:
        if kind not in KINDS:
            raise HTTPException(400, f"未知的庫類型：{kind}（{', '.join(KINDS)}）")
        if not KEY.match(key):
            raise HTTPException(400, f"不合法的 key：{key}")

    @r.get("/info")
    def info() -> dict:
        return {"dataDir": str(root())}

    @r.get("/settings")
    def get_settings() -> dict:
        p = root() / "settings.json"
        return {"settings": _read_json(p) if p.is_file() else None}

    @r.put("/settings")
    async def put_settings(req: Request) -> dict:
        _write_json(root() / "settings.json", await body_object(req))
        return {"ok": True}

    @r.get("/saves")
    def list_saves() -> list[dict]:
        d = root() / "saves"
        metas = [_read_json(f)["meta"] for f in d.glob("*.json")] if d.is_dir() else []
        return sorted(metas, key=lambda m: m["updatedAt"], reverse=True)

    @r.post("/saves")
    def create(body: NewSave) -> dict:
        sid = "s_" + secrets.token_hex(4)
        now = _now()
        meta = {"id": sid, "name": body.name, "createdAt": now, "updatedAt": now}
        _write_json(root() / "saves" / f"{sid}.json", {"meta": meta, "data": body.data, "session": body.session})
        return meta

    @r.get("/saves/{sid}")
    def read(sid: str) -> dict:
        return _read_json(save_file(sid))

    @r.put("/saves/{sid}/data")
    async def put_data(sid: str, req: Request) -> dict:
        return update(sid, "data", await body_object(req))

    @r.put("/saves/{sid}/session")
    async def put_session(sid: str, req: Request) -> dict:
        return update(sid, "session", await body_object(req))

    @r.patch("/saves/{sid}")
    def rename(sid: str, body: Rename) -> dict:
        with lock:
            f = save_file(sid)
            s = _read_json(f)
            s["meta"]["name"] = body.name
            s["meta"]["updatedAt"] = _now()
            _write_json(f, s)
            return s["meta"]

    @r.delete("/saves/{sid}")
    def delete(sid: str) -> dict:
        with lock:
            f = save_file(sid)
            dest = root() / "trash" / "saves" / f"{sid}-{time.strftime('%Y%m%d-%H%M%S')}.json"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(dest))
        return {"trashed": str(dest)}

    # 存檔的紀錄：每個存檔一份 <name>/<id>.jsonl，一行一筆，只留最近 keep 筆；重新整理、換頁、換裝置（iPad）都讀得回來
    # requests：請求紀錄（系統核心 › 請求紀錄；使用者 2026-11-20：「請求記錄沒寫進存檔」→「先把請求記錄留到100筆好了」）
    # events：app 紀錄（系統核心 › App 紀錄：送出、生成、合成、播放、暫停的經過；使用者 2026-11-20：「你可能要額外寫一個app log 這樣比較好追蹤」）
    LOGS = {"requests": 100, "events": 500}
    log_lock = threading.Lock()

    def log_routes(name: str, keep_n: int) -> None:
        def file_of(sid: str) -> Path:
            save_file(sid)  # 存檔要存在
            return root() / name / f"{sid}.jsonl"

        def get_log(sid: str) -> list:
            f = file_of(sid)
            if not f.is_file():
                return []
            out = [json.loads(x) for x in f.read_text(encoding="utf-8").splitlines()[-keep_n:] if x.strip()]
            return out[::-1]  # 新的在前

        async def add_log(sid: str, req: Request) -> dict:
            body = await req.json()
            entries = body if isinstance(body, list) else [body]  # app 紀錄一次送一批
            if not all(isinstance(e, dict) for e in entries):
                raise HTTPException(400, "內容要是 JSON 物件（或物件陣列）")
            f = file_of(sid)
            with log_lock:
                f.parent.mkdir(parents=True, exist_ok=True)
                old = [x for x in f.read_text(encoding="utf-8").splitlines() if x.strip()] if f.is_file() else []
                lines = (old + [json.dumps(e, ensure_ascii=False) for e in entries])[-keep_n:]
                tmp = f.with_suffix(".tmp")
                tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
                tmp.replace(f)
            return {"ok": True}

        def clear_log(sid: str) -> dict:
            f = file_of(sid)
            if not f.is_file():
                return {"trashed": None}
            dest = root() / "trash" / name / f"{sid}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
            dest.parent.mkdir(parents=True, exist_ok=True)
            with log_lock:
                shutil.move(str(f), str(dest))
            return {"trashed": str(dest)}

        r.add_api_route(f"/saves/{{sid}}/{name}", get_log, methods=["GET"])
        r.add_api_route(f"/saves/{{sid}}/{name}", add_log, methods=["POST"])
        r.add_api_route(f"/saves/{{sid}}/{name}", clear_log, methods=["DELETE"])

    for _name, _keep in LOGS.items():
        log_routes(_name, _keep)

    @r.put("/library/voice/{key}")
    def put_voice(key: str, body: VoiceBody) -> dict:
        check_kind_key("voice", key)
        expect = voice_key(body.engine, body.speaker, body.seed, body.steps, body.voice, body.text)
        if key != expect:
            raise HTTPException(400, f"語音 key 和合成參數對不上（應為 {expect}）")
        data = _b64(body.data_base64)
        meta = {"text": body.text, "engine": body.engine, "speaker": body.speaker, "seed": body.seed, "steps": body.steps, "voice": body.voice, "seconds": round(_wav_seconds(data), 3)}
        return lib().put("voice", key, "wav", data, meta)

    @r.post("/library/{kind}")
    def put_asset(kind: str, body: AssetBody) -> dict:
        if kind not in KINDS or kind == "voice":
            raise HTTPException(400, f"這個端點只收 {', '.join(k for k in KINDS if k != 'voice')}")
        if body.ext not in KINDS[kind]:
            raise HTTPException(400, f"{kind} 只收 {', '.join(sorted(KINDS[kind]))}")
        data = _b64(body.data_base64)
        if body.ext == "wav":
            body.meta["seconds"] = round(_wav_seconds(data), 3)
        return lib().put(kind, hashlib.sha256(data).hexdigest(), body.ext, data, body.meta)

    @r.get("/library/{kind}/{key}")
    def get_asset(kind: str, key: str) -> FileResponse:
        check_kind_key(kind, key)
        found = lib().get(kind, key)
        if found is None:
            raise HTTPException(404, f"庫裡沒有 {kind}/{key}")
        return FileResponse(lib().path(kind, key, found[0]), media_type=MIME[found[0]])

    @r.get("/library")
    def list_library() -> dict:
        used = referenced()
        items = lib().all()
        return {"items": [{**i, "used": i["key"] in used} for i in items], "unusedBytes": sum(i["bytes"] for i in items if i["key"] not in used)}

    @r.delete("/library/{kind}/{key}")
    def remove_asset(kind: str, key: str) -> dict:
        check_kind_key(kind, key)
        found = lib().get(kind, key)
        if found is None:
            raise HTTPException(404, f"庫裡沒有 {kind}/{key}")
        if key in referenced():
            raise HTTPException(409, f"{kind}/{key} 還有存檔在用，不能清")
        lib().remove(kind, key, found[0], root() / "trash")
        return {"trashed": key}

    return r
