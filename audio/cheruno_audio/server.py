"""CherunoASMR 本機音訊服務（預設 127.0.0.1:8790）。

GET  /health  服務與各 TTS 引擎是否連得上
POST /tts     {engine, text, voice, speaker} → audio/wav
/claude/v1/*  OpenAI 相容的 Claude 代理（金鑰只在伺服器端讀，見 claude_proxy.py）
/store/*      存檔區（設定、存檔、語音庫，見 store.py；放在哪個資料夾見 datadir.py）
/services/*   按需啟動 LM Studio 與 TTS 引擎（見 services.py）
"""

from __future__ import annotations

import base64
import binascii
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .claude_proxy import claude_router
from .engines import EngineError, EngineUnavailable, HttpEngine, TtsRequest, build_engines
from .datadir import DataDir, datadir_router
from .services import default_runner, services_router
from .store import store_router
from .text import VOICES

DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


class TtsBody(BaseModel):
    engine: str
    text: str = Field(min_length=1, max_length=400)
    voice: str = "normal"
    speaker: str = ""
    caption: str = Field(default="", max_length=400)
    seed: int | None = None
    style: str | None = Field(default=None, max_length=200)
    num_steps: int | None = Field(default=None, ge=4, le=64)
    unload_after: bool = False


class RegisterBody(BaseModel):
    engine: str
    voice_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    wav_base64: str


def create_app(engines: dict[str, HttpEngine] | None = None, data_dir: Path | None = None, runner=None, config_file: Path | None = None, pick_dir=None) -> FastAPI:
    app = FastAPI(title="cheruno-audio")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.environ.get("CHERUNO_APP_ORIGINS", DEFAULT_ORIGINS).split(","),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["*"],
        expose_headers=["X-Synth-Ms", "X-Engine"],
    )
    app.state.engines = engines if engines is not None else build_engines(httpx.Client())
    app.include_router(claude_router())
    # 存檔區：程式參數（測試）＞環境變數 CHERUNO_DATA_DIR＞設定檔（app 的存檔畫面可以改，見 datadir.py）
    dd = DataDir.load(data_dir, config_file)
    app.include_router(datadir_router(dd, pick_dir) if pick_dir is not None else datadir_router(dd))
    app.include_router(store_router(lambda: dd.path))
    app.include_router(services_router(lambda: dd.path, (lambda: runner) if runner is not None else default_runner))

    @app.get("/health")
    def health() -> dict:
        # 同時檢查：Windows 連到沒人聽的 localhost 埠要約 2 秒才被拒，逐一檢查會疊加
        engines = app.state.engines
        with ThreadPoolExecutor(max_workers=max(1, len(engines))) as pool:
            results = dict(zip(engines, pool.map(lambda e: e.health(), engines.values())))
        return {"ok": True, "engines": results}

    @app.post("/tts")
    def tts(body: TtsBody) -> Response:
        engine = app.state.engines.get(body.engine)
        if engine is None:
            raise HTTPException(400, f"未知的引擎：{body.engine}（可用：{', '.join(app.state.engines)}）")
        if body.voice not in VOICES:
            raise HTTPException(400, f"未知的 voice：{body.voice}")
        t0 = time.perf_counter()
        try:
            wav = engine.synthesize(TtsRequest(text=body.text, voice=body.voice, speaker=body.speaker, caption=body.caption, seed=body.seed, style=body.style, num_steps=body.num_steps, unload_after=body.unload_after))
        except EngineUnavailable as e:
            raise HTTPException(503, str(e)) from e
        except EngineError as e:
            raise HTTPException(502, str(e)) from e
        ms = (time.perf_counter() - t0) * 1000
        return Response(wav, media_type="audio/wav", headers={"X-Synth-Ms": f"{ms:.0f}", "X-Engine": body.engine})

    @app.post("/voice/register")
    def register(body: RegisterBody) -> dict:
        engine = app.state.engines.get(body.engine)
        if engine is None:
            raise HTTPException(400, f"未知的引擎：{body.engine}")
        try:
            wav = base64.b64decode(body.wav_base64, validate=True)
        except binascii.Error as e:
            raise HTTPException(400, "wav_base64 不是合法的 base64") from e
        if not wav.startswith(b"RIFF"):
            raise HTTPException(400, "上傳的不是 WAV")
        try:
            return {"voice_id": engine.register_voice(body.voice_id, wav)}
        except EngineUnavailable as e:
            raise HTTPException(503, str(e)) from e
        except EngineError as e:
            raise HTTPException(502, str(e)) from e

    return app


def main() -> None:
    import uvicorn

    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("CHERUNO_AUDIO_PORT", "8790")))


if __name__ == "__main__":
    main()
