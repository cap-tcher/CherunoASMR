"""Codex 本機代理（[[PLAN_Codex連線]]）：對 app 提供 OpenAI 相容的 /codex/v1/models 與 /codex/v1/chat/completions，
後端每個請求跑一次 `codex exec`（無頭、獨立沙盒、不能執行指令；做法與實測見 [[Research_Codex連線]]）。

用哪個 CODEX_HOME：app 的連線設定選資料夾（GET／PUT /codex/settings、POST /codex/settings/pick），存在存檔區設定檔旁的
codex.json（這份安裝的所有存檔共用）；沒選就照 Codex 自己的規則（CODEX_HOME 環境變數或 ~/.codex）。
不能執行指令（四層）：
  1. 關掉執行指令與其他工具的功能（DISABLED_FEATURES）、關網路搜尋
  2. 沙盒唯讀、不詢問（approval_policy="never"）
  3. 每次在新的空暫存資料夾跑、--ephemeral（不留 session 紀錄）
  4. 解析 --json 事件：出現 agent_message／reasoning 以外的項目就停掉整個程序樹、回錯誤，不採用結果
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .datadir import system_pick

DISABLED_FEATURES = ("shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "in_app_browser", "view_image")
ALLOWED_ITEMS = {"agent_message", "reasoning"}
DEFAULT_MODEL = "codex-default"  # 不帶 -m：用 CODEX_HOME 設定裡的模型
MODEL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")  # 模型名會進命令列（codex 是 .cmd，經過 cmd.exe）：只收這些字元
KEEPALIVE_S = 5.0
IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
PREAMBLE = "以下是一段對話紀錄：<system> 是指示，<user>／<assistant> 是之前的往來。照 system 的指示回覆最後一則 user 訊息，只輸出回覆本身。"


class ProxyError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _image(url: str) -> tuple[bytes, str]:
    if not url.startswith("data:"):
        raise ProxyError(400, "Codex 連線的圖片要用 data URL（base64）")
    head, _, data = url.partition(",")
    media = head[5:].split(";")[0]
    if ";base64" not in head or not data:
        raise ProxyError(400, "圖片 data URL 必須是 base64")
    if media not in IMAGE_EXT:
        raise ProxyError(400, f"不支援的圖片格式：{media}")
    return base64.b64decode(data), IMAGE_EXT[media]


def to_prompt(body: dict[str, Any]) -> tuple[str, list[tuple[bytes, str]], dict | None, str | None]:
    """OpenAI chat completions 請求 → (stdin 提示文字, 圖片 [(bytes, 副檔名)], output schema, 模型或 None)"""
    blocks: list[str] = []
    images: list[tuple[bytes, str]] = []
    has_user = False
    for m in body.get("messages", []):
        role, content = m.get("role"), m.get("content")
        if role not in ("system", "user", "assistant"):
            raise ProxyError(400, f"不支援的訊息角色：{role}")
        has_user |= role == "user"
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            pieces = []
            for p in content:
                if p.get("type") == "text":
                    pieces.append(p["text"])
                elif p.get("type") == "image_url":
                    images.append(_image(p["image_url"]["url"]))
                    pieces.append(f"[附圖 {len(images)}]")
                else:
                    raise ProxyError(400, f"不支援的內容類型：{p.get('type')}")
            text = "\n".join(pieces)
        else:
            raise ProxyError(400, "訊息內容要是文字或內容陣列")
        blocks.append(f"<{role}>\n{text}\n</{role}>")
    if not has_user:
        raise ProxyError(400, "沒有 user 訊息")
    rf = body.get("response_format") or {}
    schema = rf["json_schema"]["schema"] if rf.get("type") == "json_schema" else None
    model = str(body.get("model") or "")
    if model and model != DEFAULT_MODEL and not MODEL_RE.match(model):
        raise ProxyError(400, f"模型名稱只能有英數字與 . _ : -：{model[:80]}")
    return PREAMBLE + "\n\n" + "\n\n".join(blocks), images, schema, (model if model and model != DEFAULT_MODEL else None)


def codex_args(exe: str, workdir: Path, schema_path: Path | None, image_paths: list[Path], model: str | None) -> list[str]:
    a = [exe, "exec", "--ephemeral", "--skip-git-repo-check", "-C", str(workdir), "-s", "read-only", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"']
    for f in DISABLED_FEATURES:
        a += ["--disable", f]
    if model:
        a += ["-m", model]
    if schema_path:
        a += ["--output-schema", str(schema_path)]
    for p in image_paths:
        a += ["-i", str(p)]
    return a + ["--json", "-"]  # --json 要接在 -i 後面（-i 會吃掉後面不是旗標的參數）；- ＝提示從 stdin 讀


def _chunk(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":  # codex 是 npm 的 .cmd：cmd.exe → node → codex 本體，只殺 cmd.exe 底下的會留著
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def load_home(settings_file: Path) -> Path | None:
    """app 選的 CODEX_HOME；沒選（或沒有設定檔）回 None"""
    if not settings_file.is_file():
        return None
    v = json.loads(settings_file.read_text(encoding="utf-8")).get("codexHome") or ""
    return Path(v) if v else None


def env_with_home(home: Path | None) -> dict[str, str]:
    env = dict(os.environ)
    if home:
        env["CODEX_HOME"] = str(home)
    return env


def login_status(exe: str, env: dict[str, str]) -> bool:
    """`codex login status`：有登入回 0；沒登入、資料夾不存在都不是 0"""
    try:
        return subprocess.run([exe, "login", "status"], env=env, capture_output=True, timeout=30).returncode == 0
    except subprocess.TimeoutExpired:
        return False


class HomeBody(BaseModel):
    codexHome: str = Field(default="", max_length=1000)  # 空字串＝用 Codex 自己的預設


def codex_router(
    settings_file: Path,
    find_exe: Callable[[], str | None] = lambda: shutil.which("codex"),
    env_of: Callable[[], dict[str, str]] | None = None,
    pick: Callable[..., str | None] = system_pick,
    logged_in: Callable[[str, dict[str, str]], bool] = login_status,
) -> APIRouter:
    router = APIRouter(prefix="/codex")
    picking = threading.Lock()
    env_now = env_of or (lambda: env_with_home(load_home(settings_file)))

    def exe() -> str:
        e = find_exe()
        if not e:
            raise HTTPException(503, "找不到 codex 指令：先安裝 Codex CLI（npm i -g @openai/codex）並登入")
        return e

    def status() -> dict:
        home = load_home(settings_file)
        e = find_exe()
        env = env_with_home(home)
        effective = Path(env["CODEX_HOME"]) if env.get("CODEX_HOME") else Path.home() / ".codex"
        return {
            "codexHome": str(home) if home else None,  # app 選的；None＝用預設
            "effective": str(effective),  # 實際會用的資料夾
            "exists": effective.is_dir(),
            "codexFound": bool(e),
            "loggedIn": bool(e) and effective.is_dir() and logged_in(e, env),
        }

    def save(raw: str) -> dict:
        v = raw.strip().strip('"')
        if v:
            p = Path(v)
            if not p.is_absolute():
                raise HTTPException(400, f"要填完整路徑，收到：{v}")
            if not p.is_dir():
                raise HTTPException(400, f"找不到這個資料夾：{p}")
            v = os.path.normpath(p)  # 保留使用者選的寫法（不展開捷徑／symlink）
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = settings_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"codexHome": v}, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(settings_file)
        return status()

    @router.get("/settings")
    def get_settings() -> dict:
        return status()

    @router.put("/settings")
    def put_settings(body: HomeBody) -> dict:
        return save(body.codexHome)

    @router.post("/settings/pick")
    def pick_home() -> dict:
        if not picking.acquire(blocking=False):
            raise HTTPException(409, "選資料夾的視窗已經開著（可能在瀏覽器後面）")
        try:
            chosen = pick(load_home(settings_file), "選擇 Codex 設定資料夾（CODEX_HOME）")
        finally:
            picking.release()
        if chosen is None:
            return {**status(), "cancelled": True}
        return {**save(chosen), "cancelled": False}

    @router.get("/v1/models")
    def models() -> dict:
        exe()
        return {"object": "list", "data": [{"id": DEFAULT_MODEL, "object": "model"}]}

    @router.post("/v1/chat/completions")
    def chat(body: dict) -> StreamingResponse:
        try:
            prompt, images, schema, model = to_prompt(body)
        except ProxyError as e:
            raise HTTPException(e.status, str(e)) from e
        work = Path(tempfile.mkdtemp(prefix="cheruno-codex-"))
        try:
            run_dir = work / "run"  # Codex 的工作資料夾：空的
            run_dir.mkdir()
            schema_path = None
            if schema is not None:
                schema_path = work / "schema.json"
                schema_path.write_text(json.dumps(schema, ensure_ascii=False), encoding="utf-8")
            img_paths = []
            for i, (data, ext) in enumerate(images):
                p = work / f"image{i + 1}{ext}"
                p.write_bytes(data)
                img_paths.append(p)
            proc = subprocess.Popen(codex_args(exe(), run_dir, schema_path, img_paths, model), cwd=run_dir, env=env_now(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        lines: queue.Queue[bytes | None] = queue.Queue()
        err_tail: list[str] = []

        def pump_out() -> None:
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.put(line)
            lines.put(None)

        def pump_err() -> None:
            for line in proc.stderr:  # type: ignore[union-attr]
                err_tail.append(line.decode("utf-8", "replace").rstrip())
                del err_tail[:-20]

        threading.Thread(target=pump_out, daemon=True).start()
        threading.Thread(target=pump_err, daemon=True).start()
        proc.stdin.write(prompt.encode("utf-8"))  # type: ignore[union-attr]
        proc.stdin.close()  # type: ignore[union-attr]

        def events() -> Iterator[str]:
            text: str | None = None
            failed: str | None = None
            try:
                while True:
                    try:
                        line = lines.get(timeout=KEEPALIVE_S)
                    except queue.Empty:
                        yield ": keepalive\n\n"  # Codex 要等幾秒到幾十秒：送 SSE 註解讓連線不被當成斷線
                        continue
                    if line is None:
                        break
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # 非 JSON 的行（警告訊息）
                    t = ev.get("type", "")
                    item = ev.get("item") or {}
                    if t.startswith("item.") and item.get("type") not in ALLOWED_ITEMS:
                        _kill_tree(proc)
                        yield _chunk({"error": {"message": f"Codex 嘗試使用工具（{item.get('type')}），已停止；這段沒有產生"}})
                        return
                    if t == "item.completed" and item.get("type") == "agent_message":
                        text = item.get("text", "")
                    elif t in ("turn.failed", "error"):
                        failed = str((ev.get("error") or {}).get("message") or ev.get("message") or t)
                code = proc.wait()
                if failed or code != 0 or text is None:
                    detail = failed or (err_tail[-1] if err_tail else f"結束碼 {code}")
                    yield _chunk({"error": {"message": f"Codex 失敗：{detail}"}})
                    return
                yield _chunk({"choices": [{"delta": {"content": text}}]})
                yield "data: [DONE]\n\n"
            finally:
                _kill_tree(proc)  # app 中止請求（連線關掉）時也會走到這裡
                shutil.rmtree(work, ignore_errors=True)

        return StreamingResponse(events(), media_type="text/event-stream")

    return router
