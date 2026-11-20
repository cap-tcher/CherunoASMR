"""存檔區資料夾的選擇（使用者 2026-11-20：用系統的選資料夾視窗，頁面只放一顆按鈕）。

存檔區放在哪裡，記在設定檔（預設 repo 的 data/config.json；cheruno.local.json 的 config 或環境變數 CHERUNO_CONFIG 可改）。
環境變數 CHERUNO_DATA_DIR 有設時以它為準、不能在 app 裡改（測試用）。

GET  /store/datadir        目前的存檔區、是否鎖定、設定檔位置
POST /store/datadir {path} 切換到這個資料夾（不存在就建立）；原本資料夾的內容不動、不搬
POST /store/datadir/pick   開系統的選資料夾視窗（Windows 新式對話框，tkinter 在另一個程序開），選了就切換；取消就不動
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import paths


def default_config_file() -> Path:
    if os.environ.get("CHERUNO_CONFIG"):
        return Path(os.environ["CHERUNO_CONFIG"])
    return paths.path("config")


@dataclass
class DataDir:
    """目前的存檔區。locked＝由程式參數或環境變數指定，app 不能改"""

    config_file: Path
    path: Path | None = None
    locked: str | None = None  # 'env'／'arg'

    @classmethod
    def load(cls, fixed: Path | None = None, config_file: Path | None = None) -> DataDir:
        cf = config_file or default_config_file()
        if fixed is not None:
            return cls(cf, fixed, "arg")
        if os.environ.get("CHERUNO_DATA_DIR"):
            return cls(cf, Path(os.environ["CHERUNO_DATA_DIR"]), "env")
        if cf.is_file():
            p = json.loads(cf.read_text(encoding="utf-8")).get("dataDir")
            return cls(cf, Path(p) if p else None)
        return cls(cf)

    def check_unlocked(self) -> None:
        if self.locked:
            raise HTTPException(409, "存檔區由環境變數 CHERUNO_DATA_DIR 指定（測試用），不能在這裡改" if self.locked == "env" else "存檔區由程式參數指定，不能改")

    def set(self, p: Path) -> None:
        self.check_unlocked()
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.config_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"dataDir": str(p)}, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.config_file)
        self.path = p


# 在另一個程序開對話框：tkinter 不能在伺服器的執行緒裡開；topmost 讓視窗跳到瀏覽器前面
PICK_SCRIPT = """
import sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)
p = filedialog.askdirectory(parent=root, initialdir=sys.argv[1] or None, title=sys.argv[2], mustexist=False)
sys.stdout.write(p or '')
"""


def system_pick(initial: Path | None, title: str = "選擇 CherunoASMR 的存檔區資料夾") -> str | None:
    """開系統的選資料夾視窗；回傳選的路徑，取消回 None"""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    p = subprocess.run([sys.executable, "-c", PICK_SCRIPT, str(initial or ""), title], capture_output=True, timeout=1800, env=env)
    if p.returncode != 0:
        raise HTTPException(500, f"開不了選資料夾視窗：{p.stderr.decode('utf-8', 'replace')[-300:]}")
    out = p.stdout.decode("utf-8").strip()
    return out or None


class SetBody(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


def datadir_router(dd: DataDir, pick: Callable[[Path | None], str | None] = system_pick) -> APIRouter:
    r = APIRouter(prefix="/store")
    picking = threading.Lock()

    def info() -> dict:
        return {"dataDir": str(dd.path) if dd.path else None, "locked": dd.locked, "configFile": str(dd.config_file)}

    @r.get("/datadir")
    def get_dir() -> dict:
        return info()

    @r.post("/datadir")
    def set_dir(body: SetBody) -> dict:
        p = Path(body.path.strip().strip('"'))
        if not p.is_absolute():
            raise HTTPException(400, f"要填完整路徑（例：E:\\CherunoASMR-data），收到：{body.path}")
        p = p.resolve()
        if p.exists() and not p.is_dir():
            raise HTTPException(400, f"這是檔案，不是資料夾：{p}")
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(400, f"建立不了資料夾 {p}：{e}") from e
        dd.set(p)
        return info()

    @r.post("/datadir/pick")
    def pick_dir() -> dict:
        dd.check_unlocked()  # 鎖定時不開視窗
        if not picking.acquire(blocking=False):
            raise HTTPException(409, "選資料夾的視窗已經開著（可能在瀏覽器後面）")
        try:
            chosen = pick(dd.path)
        finally:
            picking.release()
        if chosen is None:
            return {**info(), "cancelled": True}
        return {**set_dir(SetBody(path=chosen)), "cancelled": False}

    return r
