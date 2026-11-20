"""程式、執行環境、模型放哪裡（[[PLAN_開源準備]]：clone 下來的東西、之後下載的模型、產生的資料都放在 repo 資料夾裡）。

預設全部在 repo 底下：
  runtime/   uv、Node、Python、各 TTS 的環境與執行檔、ffmpeg（startserver 下載）
  models/    TTS 模型（startserver 下載；自己放好的檔案就不重下）
  data/      存檔區與它的設定檔（data/config.json）
要放到別處：在 repo 根目錄建 cheruno.local.json（不進 git）覆蓋下面 DEFAULTS 的任一項，值是絕對路徑。
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LOCAL_FILE = REPO / "cheruno.local.json"


def _defaults() -> dict[str, Path]:
    runtime, models, data = REPO / "runtime", REPO / "models", REPO / "data"
    return {
        "config": data / "config.json",  # 存檔區設定檔（記存檔區在哪）
        "zonosDir": runtime / "zonos",  # zonos3-server.exe 與它的 DLL
        "zonosModels": models / "zonos",  # backbone-ptq.gguf、zac-keep2.gguf、spk-encoder.gguf、steer.gguf
        "zonosVoices": data / "zonos-voices",  # 鎖定聲音時算出的 speaker embedding（.npy）
        "ffmpegDir": runtime / "ffmpeg" / "bin",  # ZONOS 登錄參考音要解碼
        "qwenPython": runtime / "qwen" / ".venv" / "Scripts" / "python.exe",
        "qwenModel": models / "qwen" / "Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        "ragDir": data / "rag",  # rag pipeline 建好的索引：<ragDir>/<名稱>/index/
    }


# 只有開發環境用到的鍵（公開版沒有預設值）：Irodori、借用 ComfyUI 節點資料夾裡的 qwen_tts 原始碼
OPTIONAL = ("qwenNodeDir", "irodoriScript")


@lru_cache(maxsize=1)
def _local() -> dict[str, str]:
    if not LOCAL_FILE.is_file():
        return {}
    d = json.loads(LOCAL_FILE.read_text(encoding="utf-8"))
    unknown = set(d) - set(_defaults()) - set(OPTIONAL)
    if unknown:
        raise ValueError(f"{LOCAL_FILE.name} 有不認得的鍵：{', '.join(sorted(unknown))}（可用：{', '.join([*_defaults(), *OPTIONAL])}）")
    return d


def path(key: str) -> Path:
    """這一項的位置：cheruno.local.json 有寫就用它，沒有就用 repo 底下的預設"""
    loc = _local()
    if key in loc:
        return Path(os.path.expandvars(loc[key]))
    return _defaults()[key]


def optional(key: str) -> Path | None:
    v = _local().get(key)
    return Path(os.path.expandvars(v)) if v else None
