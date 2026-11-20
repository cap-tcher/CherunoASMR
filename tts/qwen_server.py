"""Qwen3-TTS VoiceDesign 小伺服器：不經過 ComfyUI，直接用 qwen_tts 把模型讀進 VRAM（使用者 2026-11-20）。

ComfyUI 啟動要匯入一整套模組（HDD＋Windows Defender 每個檔都掃，實測卡過 2 分半），這支只匯入 torch 與 qwen_tts；
模型檔在 HDD：先依序讀一遍再載（見 prewarm），不然 mmap 跳著讀會載好幾分鐘；GTX 1070 生成 RTF 約 6.7（顯卡沒有別的模型時）。
生成參數與 seed 處理照 ComfyUI-Qwen-TTS 的 FB_Qwen3TTSVoiceDesign 節點預設（同一描述＋seed＝同一個聲音，已鎖定的聲音不變）。

由音訊服務啟動（POST /services/qwen/start）：Python 用 runtime/qwen/.venv（tts/qwen/pyproject.toml，qwen-tts 套件），模型位置由環境變數 QWEN_MODEL_DIR 給；
開發環境可另給 QWEN_NODE_DIR（借用 ComfyUI-Qwen-TTS 節點資料夾裡的 qwen_tts 原始碼）
GET  /health                → {"ready": 啟動時的預載完成了沒, "loaded": 模型現在在不在顯存}
POST /voice_design {text, instruct, seed, unload_after?} → audio/wav（PCM16）
POST /unload                → 把模型移出顯存（下一次合成會自己重新載入）
"""

from __future__ import annotations

import gc
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ["QWEN_MODEL_DIR"]  # 音訊服務一定會給（paths.qwenModel）
PORT = int(os.environ.get("QWEN_PORT", "8094"))
if os.environ.get("QWEN_NODE_DIR"):
    sys.path.insert(0, os.environ["QWEN_NODE_DIR"])

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from qwen_tts import Qwen3TTSModel  # noqa: E402

# ComfyUI-Qwen-TTS VoiceDesign 節點的預設值（nodes.py INPUT_TYPES）
GEN = {"max_new_tokens": 2048, "top_p": 0.8, "top_k": 20, "temperature": 1.0, "repetition_penalty": 1.05}
LANGUAGE = "japanese"  # 節點的 LANGUAGE_MAP["Japanese"]

state: dict[str, object] = {"model": None, "ready": False}
lock = threading.Lock()  # 一次合成一句


def log(msg: str) -> None:
    print(f"[qwen {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def prewarm() -> None:
    """模型檔先從頭到尾依序讀一遍進系統快取。from_pretrained 用 mmap，在 HDD 上是跳著讀 4 KB 小塊（實測 18 MB/s，載 4 分鐘）；
    依序讀 160 MB/s（2026-11-20 實測），讀完再載就是從快取拿"""
    t0, n = time.perf_counter(), 0
    for root, _dirs, files in os.walk(MODEL):
        for name in files:
            f = os.path.join(root, name)
            if os.path.getsize(f) < 1 << 20:
                continue
            with open(f, "rb", buffering=0) as fh:
                while chunk := fh.read(64 << 20):
                    n += len(chunk)
    dt = time.perf_counter() - t0
    log(f"依序讀模型檔 {n / 2**30:.2f} GB 花 {dt:.1f} 秒（{n / 2**20 / max(dt, 1e-6):.0f} MB/s）")


def load() -> Qwen3TTSModel:
    if state["model"] is None:
        prewarm()
        t0 = time.perf_counter()
        state["model"] = Qwen3TTSModel.from_pretrained(MODEL, device_map="cuda", dtype=torch.bfloat16, attn_implementation="sdpa")
        torch.cuda.synchronize()
        log(f"模型讀進顯存 {time.perf_counter() - t0:.1f} 秒，配置 {torch.cuda.memory_allocated() / 2**20:.0f} MiB")
    return state["model"]  # type: ignore[return-value]


def unload() -> None:
    state["model"] = None
    gc.collect()
    torch.cuda.empty_cache()
    log(f"模型移出顯存，剩 {torch.cuda.memory_allocated() / 2**20:.0f} MiB")


def voice_design(text: str, instruct: str, seed: int) -> bytes:
    model = load()
    # 照節點：torch、CUDA、numpy 三個都設 seed
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    np.random.seed(seed % 2**32)
    t0 = time.perf_counter()
    wavs, sr = model.generate_voice_design(text=text, language=LANGUAGE, instruct=instruct, **GEN)
    wav = np.asarray(wavs[0], dtype=np.float32).squeeze()
    log(f"合成 {len(wav) / sr:.1f} 秒音長花 {time.perf_counter() - t0:.1f} 秒")
    out = io.BytesIO()
    sf.write(out, wav, sr, format="WAV", subtype="PCM_16")
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1（連線留著、由對方關）：預設 HTTP/1.0 每次回完就關連線，在 Windows 上對方還沒讀完約 600 KB 的 WAV 就常被重設
    # （WinError 10054；2026-11-20 乾淨環境 3 次候選壞 1 次；假伺服器重現 HTTP/1.0 約 4 成失敗、HTTP/1.1 0／160）
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            return self._json(200, {"ready": state["ready"], "loaded": state["model"] is not None})
        self._json(404, {"detail": "沒有這個路徑"})

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError as e:
            return self._json(400, {"detail": f"不是 JSON：{e}"})
        if self.path == "/unload":
            with lock:
                unload()
            return self._json(200, {"loaded": False})
        if self.path != "/voice_design":
            return self._json(404, {"detail": "沒有這個路徑"})
        text, instruct, seed = body.get("text"), body.get("instruct"), body.get("seed")
        if not text or not instruct or not isinstance(seed, int):
            return self._json(400, {"detail": "要有 text、instruct（聲音描述）與整數 seed"})
        try:
            with lock:
                wav = voice_design(text, instruct, seed % 2**64)
                if body.get("unload_after"):
                    unload()
        except Exception as e:  # 回給音訊服務看，伺服器不跟著掛
            log(f"合成失敗：{e!r}")
            return self._json(500, {"detail": f"Qwen 合成失敗：{e}"})
        self._send(200, wav, "audio/wav")

    def log_message(self, fmt: str, *args: object) -> None:
        pass  # 每個請求不印一行，只印上面的合成紀錄


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"聽 127.0.0.1:{PORT}，預載模型…")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with lock:
        load()
    state["ready"] = True
    log("就緒")
    threading.Event().wait()
