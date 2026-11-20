"""服務按需啟動（[[PLAN_服務按需啟動]]）：app 按「連線」才開 LM Studio 與 TTS 引擎，startserver 只開 app＋音訊服務。

GET  /services                       各服務狀態（zonos、irodori、qwen 有沒有在跑；LM Studio server 與模型載入狀態）
POST /services/{tts}/start           啟動 TTS（只跑固定的程式：ZONOS 伺服器、Qwen 伺服器、開發環境的 Irodori 腳本）；ZONOS 與 Irodori 互斥，開一個先關另一個
POST /services/{tts}/stop            停掉
POST /services/lmstudio/start        lms server start --cors
POST /services/lmstudio/load {model} 載入模型（先卸載其他；已載入就跳過）；模型 id 必須在 LM Studio 的清單裡
POST /services/lmstudio/unload       lms unload --all（改用雲端模型時騰顯存）

只執行固定的腳本與 lms 子指令；使用者只能選「哪一個」，不能給指令內容。
"""

from __future__ import annotations

import os
import shutil
import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import paths

REPO = paths.REPO


@dataclass(frozen=True)
class Launch:
    argv: list[str]
    env: dict[str, str]
    launcher: str | None = None  # 啟動腳本檔名：停止時連跑腳本的 bash 一起砍（直接開程式的沒有）


@dataclass(frozen=True)
class Tts:
    health: str
    match: str  # 停止時找程序命令列的關鍵字（固定字串）
    launch: Callable[[Runner], Launch]
    # 沒裝好時回傳缺什麼（給畫面顯示）；裝好回 None。公開版沒有 Irodori → 一直是「沒裝」，畫面就不列它
    missing: Callable[[Runner], str | None]
    conflicts: tuple[str, ...] = ()
    ready: Callable[[httpx.Response], bool] = lambda r: r.status_code == 200


ZONOS_FILES = ("backbone-ptq.gguf", "zac-keep2.gguf", "spk-encoder.gguf", "steer.gguf")
QWEN_FILES = ("model.safetensors", "config.json", "speech_tokenizer/model.safetensors")


def _first_missing(rr: Runner, items: list[tuple[str, Path]]) -> str | None:
    for what, p in items:
        if not rr.exists(p):
            return f"{what}（{p}）"
    return None


def _zonos_launch(rr: Runner) -> Launch:
    d, m = paths.path("zonosDir"), paths.path("zonosModels")
    # --gpu：不加整個跑 CPU；--batch 1：預設 8 路同時合成的快取多吃約 1.8 GB，app 一次只合成一句；
    # 官方預設埠 1919 落在 Windows 常保留的 1902–2001，改 8092
    argv = [str(d / "zonos3-server.exe"), str(m / "backbone-ptq.gguf"), "--gpu", "--batch", "1", "--host", "127.0.0.1", "--port", "8092"]
    return Launch(argv, {"PATH": os.pathsep.join([str(d), str(paths.path("ffmpegDir")), os.environ.get("PATH", "")])})


def _zonos_missing(rr: Runner) -> str | None:
    d, m = paths.path("zonosDir"), paths.path("zonosModels")
    return _first_missing(rr, [("ZONOS 伺服器", d / "zonos3-server.exe"), *[(f"ZONOS 模型 {f}", m / f) for f in ZONOS_FILES], ("ffmpeg", paths.path("ffmpegDir") / "ffmpeg.exe")])


def _qwen_launch(rr: Runner) -> Launch:
    env = {"QWEN_MODEL_DIR": str(paths.path("qwenModel")), "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1", "HF_HUB_OFFLINE": "1"}
    node = paths.optional("qwenNodeDir")
    if node:
        env["QWEN_NODE_DIR"] = str(node)  # 開發環境：qwen_tts 原始碼在 ComfyUI 節點資料夾裡
    return Launch([str(paths.path("qwenPython")), "-s", str(REPO / "tts" / "qwen_server.py")], env)


def _qwen_missing(rr: Runner) -> str | None:
    m = paths.path("qwenModel")
    return _first_missing(rr, [("Qwen 的 Python 環境", paths.path("qwenPython")), *[(f"Qwen 模型 {f}", m / f) for f in QWEN_FILES]])


def _irodori_launch(rr: Runner) -> Launch:
    script = paths.optional("irodoriScript")
    assert script is not None  # missing() 先擋
    return Launch([rr.bash, str(script)], {}, script.name)


def _irodori_missing(rr: Runner) -> str | None:
    script = paths.optional("irodoriScript")
    if script is None:
        return "這個版本沒有 Irodori"
    return _first_missing(rr, [("Irodori 啟動腳本", script), ("Git Bash", Path(rr.bash))])


def _irodori_ready(r: httpx.Response) -> bool:
    return r.status_code == 200 and bool(r.json().get("runtime", {}).get("loaded"))


TTS: dict[str, Tts] = {
    "zonos": Tts("http://127.0.0.1:8092/v2/capabilities", "zonos3-server", _zonos_launch, _zonos_missing, ("irodori",)),
    "irodori": Tts("http://127.0.0.1:8088/health", "irodori_openai_tts", _irodori_launch, _irodori_missing, ("zonos",), _irodori_ready),
    # Qwen 聲音設計：tts/qwen_server.py（不經過 ComfyUI）；/health 的 ready＝啟動時模型讀進顯存了
    "qwen": Tts("http://127.0.0.1:8094/health", "qwen_server.py", _qwen_launch, _qwen_missing, (), lambda r: r.status_code == 200 and bool(r.json().get("ready"))),
}
LMS_API = "http://localhost:1234/api/v0/models"
TIMEOUT_CODE = 124  # RealRunner.run 逾時的回傳碼（同 coreutils timeout）
LOAD_TIMEOUT_S = 300
# 載入前估顯存：實測 GTX 1070 上 Gemma 4 E2B（檔 4.4 GB）約佔 2.7～3.2 GB、E4B（檔 6.3 GB）約 3.9～4.4 GB（context 8192，
# 見 TASKS_本機串接），約為檔案大小的 0.65～0.7 倍 → 取 0.75 倍＋512 MB 當需求，估多不估少
VRAM_RATIO = 0.75
VRAM_MARGIN_MB = 512


def vram_need_mb(size_bytes: int) -> int:
    return int(size_bytes * VRAM_RATIO / 2**20) + VRAM_MARGIN_MB


# LM Studio 的 llama-server 另外在主記憶體留一份模型：實測 E2B（檔 4.41 GB）私有記憶體 3.57 GB ≈ 0.81 倍。
# 2026-11-19 兩個模型同時載入把 16 GB 主記憶體吃到 12 GB 以上 → 取 0.85 倍＋1 GB 給系統喘息
RAM_RATIO = 0.85
RAM_MARGIN_MB = 1024


def ram_need_mb(size_bytes: int) -> int:
    return int(size_bytes * RAM_RATIO / 2**20) + RAM_MARGIN_MB


def _ram_free_mb() -> int:
    import ctypes

    class MemStatus(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong)] + [
            (n, ctypes.c_ulonglong) for n in ("total", "avail", "totalPage", "availPage", "totalVirtual", "availVirtual", "availExtVirtual")
        ]

    m = MemStatus()
    m.dwLength = ctypes.sizeof(MemStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
        raise OSError("GlobalMemoryStatusEx 失敗")
    return int(m.avail / 2**20)


class Runner(Protocol):
    """真正動作的部分（測試換成假的）"""

    bash: str
    lms: str

    def spawn(self, argv: list[str], log: Path, env: dict[str, str] | None = None) -> None: ...
    def run(self, argv: list[str], timeout: float) -> tuple[int, str]: ...
    def exists(self, p: Path) -> bool: ...
    def kill(self, match: str, launcher: str | None = None) -> int: ...
    def get(self, url: str) -> httpx.Response | None: ...
    def ram_free_mb(self) -> int: ...


@dataclass
class RealRunner:
    bash: str
    lms: str
    client: httpx.Client = field(default_factory=lambda: httpx.Client(timeout=3))

    def spawn(self, argv: list[str], log: Path, env: dict[str, str] | None = None) -> None:
        log.parent.mkdir(parents=True, exist_ok=True)
        f = open(log, "ab")  # noqa: SIM115 —— 交給子程序，音訊服務不再管它
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        subprocess.Popen(argv, cwd=REPO, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags, env={**os.environ, **(env or {})})

    def exists(self, p: Path) -> bool:
        return p.is_file()

    def run(self, argv: list[str], timeout: float) -> tuple[int, str]:
        try:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        except subprocess.TimeoutExpired as e:
            return TIMEOUT_CODE, f"超過 {timeout:.0f} 秒沒結束：{(e.stdout or '')[-200:] if isinstance(e.stdout, str) else ''}"
        return p.returncode, (p.stdout + p.stderr).strip()

    def kill(self, match: str, launcher: str | None = None) -> int:
        # 依命令列找程序（match、launcher 都是程式裡的固定字串，不是使用者輸入）。
        # launcher＝啟動腳本檔名：啟動剛開始時伺服器程式還沒起來，只砍伺服器的話腳本會接著把它開起來，所以連跑腳本的 bash 一起砍
        cond = f"($_.CommandLine -like '*{match}*' -and $_.Name -notin 'powershell.exe','bash.exe')"
        if launcher:
            cond += f" -or ($_.Name -eq 'bash.exe' -and $_.CommandLine -like '*{launcher}*')"
        ps = f"$n=0; Get-CimInstance Win32_Process | Where-Object {{ {cond} }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }}; $n"
        code, out = self.run(["powershell", "-NoProfile", "-Command", ps], 30)
        return int(out.splitlines()[-1]) if code == 0 and out.strip().splitlines() and out.strip().splitlines()[-1].isdigit() else 0

    def ram_free_mb(self) -> int:
        return _ram_free_mb()

    def get(self, url: str) -> httpx.Response | None:
        try:
            return self.client.get(url)
        except httpx.HTTPError:
            return None


def default_runner() -> RealRunner:
    bash = os.environ.get("CHERUNO_BASH", "C:/Program Files/Git/bin/bash.exe")
    lms = os.environ.get("CHERUNO_LMS") or shutil.which("lms") or str(Path.home() / ".cache/lm-studio/bin/lms.exe")
    return RealRunner(bash=bash, lms=lms)


class LoadBody(BaseModel):
    model: str = Field(min_length=1, max_length=200)


def services_router(log_dir_of: Callable[[], Path | None], runner_of: Callable[[], Runner] = default_runner) -> APIRouter:
    r = APIRouter(prefix="/services")
    state: dict[str, Runner] = {}
    load_lock = threading.Lock()  # 一次只載一個模型：兩個模型同時載入會塞爆顯存與主記憶體（2026-11-19 事件）
    # 取消載入＝載入中對 server 下 lms unload --all（實測會中止載入：「Engine protocol startup was aborted」；
    # 只砍 lms load 的程序沒用，server 會自己載完）。記下來讓那次載入回「已取消」而不是「失敗」
    cancel: dict[str, bool] = {"requested": False}
    # 正在載入哪個模型：放在伺服器上，每個開著的頁面（電腦、iPad、重新整理後）都看得到、都能取消（使用者 2026-11-20 iPad 回報）
    loading: dict[str, object] = {}
    # 同一個 TTS 的啟動與停止排隊執行：啟動要先花 1～2 秒停掉衝突的引擎才開程式，取消若剛好落在這段，
    # 停止會找不到程序、接著啟動又把它開起來（2026-11-20 實測）。排隊後停止會等啟動開完程式再一起停掉
    tts_lock = {n: threading.Lock() for n in TTS}

    def runner() -> Runner:
        if "r" not in state:
            state["r"] = runner_of()
        return state["r"]

    def log_dir() -> Path:
        d = log_dir_of()
        if d is None:
            raise HTTPException(503, "還沒選存檔區：服務的 log 放在存檔區的 logs/，先到存檔畫面選資料夾")
        return d / "logs"

    def tts_status(name: str) -> dict:
        t = TTS[name]
        res = runner().get(t.health)
        up = res is not None
        missing = t.missing(runner())
        return {"running": up, "ready": up and t.ready(res), "installed": missing is None, "missing": missing, "log": str(log_dir() / f"{name}.log")}

    def lms_models() -> list[dict] | None:
        res = runner().get(LMS_API)
        if res is None or res.status_code != 200:
            return None
        return [{"id": m["id"], "state": m.get("state", ""), "type": m.get("type", "")} for m in res.json().get("data", [])]

    def check_lms() -> None:
        rr = runner()
        if not rr.exists(Path(rr.lms)):
            raise HTTPException(500, f"找不到 LM Studio 的 lms（{rr.lms}）：先安裝 LM Studio 並開過一次（或用環境變數 CHERUNO_LMS 指定）；改用雲端模型就不需要")

    @r.get("")
    def status() -> dict:
        # 同時檢查：Windows 連到沒人聽的埠要約 2 秒才被拒，逐一檢查會疊到 5～6 秒
        with ThreadPoolExecutor(max_workers=len(TTS) + 1) as pool:
            tts = {n: pool.submit(tts_status, n) for n in TTS}
            models = pool.submit(lms_models).result()
            ld = {"model": loading["model"], "seconds": round(time.monotonic() - float(loading["since"]))} if loading else None  # type: ignore[arg-type]
            if ld is None:  # 不是從這裡按的載入（LM Studio 自動載入、或上一次載到一半卡住）：LM Studio 自己標 loading
                ext = next((m["id"] for m in models or [] if m["state"] == "loading"), None)
                ld = {"model": ext, "seconds": None} if ext else None
            return {**{n: f.result() for n, f in tts.items()}, "lmstudio": {"running": models is not None, "models": models or [], "loading": ld}}

    @r.post("/lmstudio/start")
    def lms_start() -> dict:
        check_lms()
        code, out = runner().run([runner().lms, "server", "start", "--cors"], 60)
        if code != 0:
            raise HTTPException(502, f"lms server start 失敗：{out[-300:]}")
        return {"running": True, "output": out[-200:]}

    def vram_free_mb() -> int:
        code, out = runner().run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], 15)
        if code != 0 or not out.strip().splitlines()[0].strip().isdigit():
            raise HTTPException(500, f"讀不到顯存（nvidia-smi）：{out[-200:]}")
        return int(out.strip().splitlines()[0])

    def model_size(model: str) -> int:
        code, out = runner().run([runner().lms, "ls", "--json"], 30)
        if code != 0:
            raise HTTPException(502, f"lms ls 失敗：{out[-300:]}")
        for m in json.loads(out):
            if m.get("modelKey") == model:
                return int(m["sizeBytes"])
        raise HTTPException(400, f"lms ls 裡沒有 {model}")

    @r.post("/lmstudio/load")
    def lms_load(body: LoadBody) -> dict:
        check_lms()
        if not load_lock.acquire(blocking=False):
            raise HTTPException(409, "正在載入另一個模型：先按「取消載入」或等它好")
        cancel["requested"] = False
        try:
            models = lms_models()
            if models is None:
                raise HTTPException(503, "LM Studio server 沒開：先按「連線」（lms server start）")
            ids = {m["id"] for m in models if m["type"] != "embeddings"}
            if body.model not in ids:
                raise HTTPException(400, f"LM Studio 沒有這個模型：{body.model}（有：{'、'.join(sorted(ids))}）")
            loaded = [m["id"] for m in models if m["state"] == "loaded"]
            if loaded == [body.model]:
                return {"model": body.model, "loaded": True, "already": True}
            lms = runner().lms
            if loaded:
                runner().run([lms, "unload", "--all"], 60)
            size = model_size(body.model)
            ram_need, ram_free = ram_need_mb(size), runner().ram_free_mb()
            if ram_free < ram_need:
                raise HTTPException(409, f"主記憶體不夠載入 {body.model}：估計要 {ram_need} MB，現在剩 {ram_free} MB（關掉其他吃記憶體的程式，或換小一點的模型）")
            need, free = vram_need_mb(size), vram_free_mb()
            if free < need:
                busy = [n for n in TTS if tts_status(n)["running"]]
                raise HTTPException(
                    409,
                    f"顯存不夠載入 {body.model}：估計要 {need} MB，現在剩 {free} MB"
                    + (f"（{'、'.join(busy)} 開著，可先關掉或換小一點的模型）" if busy else "（換小一點的模型）"),
                )
            loading.update(model=body.model, since=time.monotonic())
            # 取消可能落在任何階段：還沒開始載（上面在讀清單、量顯存）、載到一半（unload 會中止它）、
            # 或 unload 下得太早模型還沒進 server（lms load 會照樣載完）→ 三個點都檢查，載完才發現就再卸載一次
            if cancel["requested"]:
                raise HTTPException(409, f"已取消載入 {body.model}")
            code, out = runner().run([lms, "load", body.model, "--gpu", "max", "--context-length", "8192", "-y"], LOAD_TIMEOUT_S)
            if code == TIMEOUT_CODE:
                # 自己收乾淨：不卸載的話 LM Studio 會一直停在 loading（2026-11-20 實測：E2B 載了 4 分鐘、逾時砍掉 lms 後卡住）
                runner().run([lms, "unload", "--all"], 60)
                raise HTTPException(504, f"載入 {body.model} 超過 {LOAD_TIMEOUT_S // 60} 分鐘沒完成，已取消並清掉（硬碟或主記憶體很忙時會這樣：先關掉 ComfyUI 這類同時在讀大檔的程式再試）")
            if cancel["requested"]:
                if code == 0:
                    runner().run([lms, "unload", "--all"], 60)
                raise HTTPException(409, f"已取消載入 {body.model}")
            if code != 0:
                raise HTTPException(502, f"載入 {body.model} 失敗：{out[-300:]}")
            return {"model": body.model, "loaded": True, "already": False, "unloaded": loaded, "vramNeedMb": need, "vramFreeMb": free, "ramNeedMb": ram_need, "ramFreeMb": ram_free}
        finally:
            loading.clear()
            load_lock.release()

    @r.post("/lmstudio/unload")
    def lms_unload() -> dict:
        """卸載全部模型；載入進行中時就是「取消載入」"""
        check_lms()
        if load_lock.locked():
            cancel["requested"] = True
        if lms_models() is None:
            return {"unloaded": False, "reason": "LM Studio server 沒開"}
        code, out = runner().run([runner().lms, "unload", "--all"], 60)
        if code != 0:
            raise HTTPException(502, f"lms unload 失敗：{out[-300:]}")
        return {"unloaded": True}

    @r.post("/{name}/start")
    def start(name: str) -> dict:
        if name not in TTS:
            raise HTTPException(404, f"沒有這個服務：{name}（可用：{', '.join([*TTS, 'lmstudio'])}）")
        missing = TTS[name].missing(runner())
        if missing:
            raise HTTPException(409, f"{name} 還沒裝好，缺 {missing}：重新執行 startserver.bat setup 選裝這個引擎")
        with tts_lock[name]:
            return _start(name)

    def _start(name: str) -> dict:
        t = TTS[name]
        stopped = [c for c in t.conflicts if TTS[c].missing(runner()) is None and runner().kill(TTS[c].match, TTS[c].launch(runner()).launcher) > 0]  # 8 GB 卡放不下兩個 TTS
        now = tts_status(name)
        if now["running"]:
            return {**now, "stopped": stopped, "already": True}
        la = t.launch(runner())
        runner().spawn(la.argv, log_dir() / f"{name}.log", la.env)
        return {**now, "starting": True, "stopped": stopped}

    @r.post("/{name}/stop")
    def stop(name: str) -> dict:
        if name not in TTS:
            raise HTTPException(404, f"沒有這個服務：{name}")
        # 啟動中、載入中、已就緒都可以停（取消啟動也是這個）
        with tts_lock[name]:
            t = TTS[name]
            return {"stopped": runner().kill(t.match, t.launch(runner()).launcher if t.missing(runner()) is None else None)}

    return r
