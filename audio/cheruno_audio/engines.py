"""TTS 引擎 adapter。每個引擎是獨立的本機伺服器，這裡只透過 HTTP 呼叫。
見 Obsidian/notes/Research_本機TTS伺服器整合.md。
"""

from __future__ import annotations

import base64
import io
import os
import time
from dataclasses import dataclass

import httpx
import numpy as np
import soundfile as sf

from . import paths
from .text import irodori_text, to_reading


class EngineUnavailable(Exception):
    """引擎伺服器連不上（沒開、還在載入）。"""


class EngineError(Exception):
    """引擎有回應但合成失敗。"""


@dataclass(frozen=True)
class TtsRequest:
    text: str  # 可含 {漢字|よみ}
    voice: str  # normal | soft | whisper | breath
    speaker: str  # 引擎端的聲音 id；空字串＝引擎預設（Irodori 為不帶參考音）
    caption: str = ""  # 聲音描述（Irodori VoiceDesign）；空＝不帶
    seed: int | None = None  # 固定 seed：3 個候選＝同一描述、不同 seed
    style: str | None = None  # Qwen：接在聲音描述後的語氣後綴（app 依提示詞模板與 voice 給）
    num_steps: int | None = None  # Irodori 取樣步數；None＝伺服器預設（RF 40）。GTX 1070 實測 24 步 RTF 0.83、40 步 1.7
    unload_after: bool = False  # Qwen：這句產完就卸載模型（建立角色最後一個候選用，騰出 VRAM 給播放引擎）
    controls: dict[str, float] | None = None  # ZONOS：語氣（app 依 core tone.ts 換算；[[PLAN_ZONOS語氣控制]]）
    control_spans: list[dict] | None = None  # ZONOS：句中範圍 [{start, end, controls}]（位置是 to_reading 後的字元）
    control_span_rate: float | None = None  # ZONOS：每字幾格音框（日文約 3）
    condition_values: dict[str, float] | None = None  # ZONOS：整句的條件 loudness（LUFS）／fmax（Hz）／speaking_rate


class HttpEngine:
    name = ""
    health_path = "/health"

    def __init__(self, base_url: str, client: httpx.Client):
        self.base_url = base_url.rstrip("/")
        self.client = client

    def health(self) -> dict:
        try:
            r = self.client.get(self.base_url + self.health_path, timeout=3)
            return {"reachable": r.status_code < 500, "status": r.status_code, "url": self.base_url}
        except httpx.HTTPError as e:
            return {"reachable": False, "error": type(e).__name__, "url": self.base_url}

    def _post_speech(self, payload: dict, timeout: float) -> bytes:
        try:
            r = self.client.post(self.base_url + "/v1/audio/speech", json=payload, timeout=timeout)
        except httpx.ConnectError as e:
            raise EngineUnavailable(f"{self.name} 伺服器連不上（{self.base_url}）") from e
        except httpx.TimeoutException as e:
            raise EngineError(f"{self.name} 合成逾時（{timeout:.0f} 秒）") from e
        except httpx.HTTPError as e:  # 連線中斷、回應讀到一半被重設：照實回報（不然變成沒有 CORS 標頭的 500，畫面只看到 Failed to fetch）
            raise EngineError(f"{self.name} 連線中斷：{e!r}") from e
        if r.status_code >= 400:
            raise EngineError(f"{self.name} 回 {r.status_code}：{r.text[:300]}")
        if not r.content.startswith(b"RIFF"):
            raise EngineError(f"{self.name} 回傳的不是 WAV（{r.headers.get('content-type')}）")
        return r.content

    def synthesize(self, req: TtsRequest) -> bytes:  # pragma: no cover - 子類實作
        raise NotImplementedError

    def register_voice(self, voice_id: str, wav: bytes) -> str:
        raise EngineError(f"{self.name} 不支援登錄參考音")


class IrodoriEngine(HttpEngine):
    """Irodori-TTS-Server（OpenAI 相容）。voice 轉成 emoji 前綴，speaker 是 voices/ 裡的 voice id。"""

    name = "irodori"

    def synthesize(self, req: TtsRequest) -> bytes:
        payload = {
            "model": "irodori-tts",
            "input": irodori_text(req.text, req.voice),
            "voice": req.speaker or "none",
            "response_format": "wav",
        }
        opts: dict = {}
        if req.caption:
            opts["caption"] = req.caption
        if req.seed is not None:
            opts["seed"] = req.seed
        if req.num_steps is not None:
            opts["num_steps"] = req.num_steps
        if opts:
            payload["irodori"] = opts
        return self._post_speech(payload, timeout=180)

    def register_voice(self, voice_id: str, wav: bytes) -> str:
        """把鎖定的候選音上傳成 Irodori 的參考音（voices/），之後 speaker＝voice_id。"""
        files = {"file": (f"{voice_id}.wav", wav, "audio/wav")}
        try:
            # 已存在就用 PUT 取代（重新設計聲音）
            exists = self.client.get(f"{self.base_url}/v1/audio/voices/{voice_id}", timeout=10).status_code == 200
            if exists:
                r = self.client.put(f"{self.base_url}/v1/audio/voices/{voice_id}", files=files, timeout=60)
            else:
                r = self.client.post(self.base_url + "/v1/audio/voices", data={"voice_id": voice_id}, files=files, timeout=60)
        except httpx.ConnectError as e:
            raise EngineUnavailable(f"irodori 伺服器連不上（{self.base_url}）") from e
        if r.status_code >= 400:
            raise EngineError(f"irodori 登錄參考音失敗（{r.status_code}）：{r.text[:300]}")
        return voice_id


class ZonosEngine(HttpEngine):
    """ZONOS3-Mini ggml server（servers/ggml 的 zonos3-server，v2 API）。

    伺服器的 /v2/speakers 聲音快取只在記憶體（依 X-TTS-Session-ID），重啟就沒了；所以登錄時把那個聲音的
    speaker embedding（192 維）存成本機 .npy，合成時用 /v2/generate 帶 speaker_embedding_base64（無狀態，重啟照樣能用）。
    """

    name = "zonos"
    health_path = "/v2/capabilities"
    session = "cheruno"

    def __init__(self, base_url: str, client: httpx.Client, voices_dir: str):
        super().__init__(base_url, client)
        self.voices_dir = voices_dir

    def _voice_path(self, voice_id: str) -> str:
        return os.path.join(self.voices_dir, f"{voice_id}.npy")

    def _req(self, method: str, path: str, timeout: float, **kw):
        try:
            return self.client.request(method, self.base_url + path, headers={"X-TTS-Session-ID": self.session}, timeout=timeout, **kw)
        except httpx.ConnectError as e:
            raise EngineUnavailable(f"zonos 伺服器連不上（{self.base_url}）") from e
        except httpx.TimeoutException as e:
            raise EngineError(f"zonos 逾時（{timeout:.0f} 秒）") from e
        except httpx.HTTPError as e:  # 連線中斷、回應讀到一半被重設：照實回報（不然變成沒有 CORS 標頭的 500，畫面只看到 Failed to fetch）
            raise EngineError(f"{self.name} 連線中斷：{e!r}") from e

    def register_voice(self, voice_id: str, wav: bytes) -> str:
        """參考音 → 伺服器算 speaker embedding → 存成 voices_dir/<voice_id>.npy；之後 speaker＝voice_id。"""
        r = self._req("POST", "/v2/speakers", 120, json={"label": voice_id, "speaker_audio_base64": base64.b64encode(wav).decode(), "speaker_audio_name": f"{voice_id}.wav"})
        if r.status_code >= 400:
            raise EngineError(f"zonos 登錄參考音失敗（{r.status_code}）：{r.text[:300]}")
        sid = r.json()["id"]
        e = self._req("GET", f"/v2/speakers/{sid}/embedding", 60)
        if e.status_code >= 400:
            raise EngineError(f"zonos 取 speaker embedding 失敗（{e.status_code}）：{e.text[:300]}")
        emb = np.asarray(e.json()["embedding"], dtype=np.float32)
        os.makedirs(self.voices_dir, exist_ok=True)
        np.save(self._voice_path(voice_id), emb)
        return voice_id

    def synthesize(self, req: TtsRequest) -> bytes:
        if not req.speaker:
            raise EngineError("zonos 需要 speaker（日文沒有內建聲音，要先鎖定一個聲音）")
        path = self._voice_path(req.speaker)
        if not os.path.exists(path):
            raise EngineError(f"zonos 沒有聲音「{req.speaker}」的 embedding：到萬物之書的角色分頁用 ZONOS 重新設計並鎖定聲音")
        with open(path, "rb") as f:
            emb_b64 = base64.b64encode(f.read()).decode()
        payload = {"text": to_reading(req.text), "stream": False, "format": "wav", "speaker_embedding_base64": emb_b64, "speaker_mode": "embedding"}
        if req.seed is not None:
            payload["seed"] = req.seed % 4294967296
        if req.controls:
            payload["controls"] = dict(req.controls)
        if req.condition_values:
            payload["condition_values"] = dict(req.condition_values)
        if req.control_spans:
            n = len(payload["text"])
            for sp in req.control_spans:
                if not (0 <= sp["start"] < sp["end"] <= n):
                    raise EngineError(f"句中範圍 {sp['start']}～{sp['end']} 超出這句（{n} 個字）：app 與音訊服務算位置的規則對不上")
            payload["control_spans"] = [dict(sp) for sp in req.control_spans]
            if req.control_span_rate:
                payload["control_span_rate"] = req.control_span_rate
        r = self._req("POST", "/v2/generate", 180, json=payload)
        if r.status_code >= 400:
            tone = {**(req.controls or {}), **{f"cond.{k}": v for k, v in (req.condition_values or {}).items()}}
            raise EngineError(f"zonos 回 {r.status_code}：{r.text[:300]}" + (f"（這句的語氣：{tone}）" if tone else ""))
        if not r.content.startswith(b"RIFF"):
            raise EngineError(f"zonos 回傳的不是 WAV（{r.headers.get('content-type')}）")
        check_not_blank(r.content, payload["text"], req.controls)
        return r.content


MIN_SEC_PER_CHAR = 0.08  # Z-02：語氣疊太重時 ZONOS 會出空音（第一輪 0.07 秒／25 字）；正常說話每字約 0.1 秒以上


def check_not_blank(wav: bytes, reading: str, controls: dict | None) -> None:
    """合成結果短到不像在說話（每字不到 0.08 秒）就報錯，不把空音當成功；不自動換 seed 重試（那是 fallback，要使用者同意）"""
    chars = len("".join(ch for ch in reading if not ch.isspace() and ch not in "、。，．・…！？!?「」『』（）()ー〜～"))
    if chars < 4:  # 「ふぅ……」這種短句長度本來就不穩，不判
        return
    with sf.SoundFile(io.BytesIO(wav)) as f:
        sec = f.frames / f.samplerate
    if sec < MIN_SEC_PER_CHAR * chars:
        raise EngineError(f"zonos 合成結果只有 {sec:.2f} 秒（{chars} 個字），疑似空音" + (f"：這句的語氣 {controls} 可能疊太重，按重試換一次，或到系統核心調低語氣強度" if controls else "：按重試換一次"))


class QwenEngine(HttpEngine):
    """Qwen3-TTS VoiceDesign，走 tts/qwen_server.py（不經過 ComfyUI，直接把模型讀進顯存；使用者 2026-11-20）。
    speaker＝聲音描述（日文 instruct），style＝依 voice 的後綴；兩者都由 app 從提示詞模板給（系統核心 › 提示詞）。
    seed 決定是哪個聲音：建立角色的 3 個候選＝同一描述、不同 seed；播放時用鎖定的那個 seed。
    生成參數與 seed 處理照 ComfyUI-Qwen-TTS 節點的預設（bf16、sdpa、japanese），引擎名稱沿用 qwen-comfy，已鎖定的聲音與語音庫的 key 不變。
    """

    name = "qwen-comfy"
    health_path = "/health"

    def synthesize(self, req: TtsRequest) -> bytes:
        if not req.speaker:
            raise EngineError("qwen-comfy 需要 speaker（聲音描述）")
        if req.style is None:
            raise EngineError("qwen-comfy 需要 style（語氣後綴，app 從提示詞模板給）")
        if req.seed is None:
            raise EngineError("qwen-comfy 需要 seed（同一描述換 seed 就是另一個聲音；app 鎖定聲音時會記住）")
        payload = {"text": to_reading(req.text), "instruct": req.speaker + req.style, "seed": req.seed % 2**64, "unload_after": req.unload_after}
        try:
            r = self.client.post(self.base_url + "/voice_design", json=payload, timeout=600)  # GTX 1070：一句約 RTF 7
        except httpx.ConnectError as e:
            raise EngineUnavailable(f"Qwen 聲音設計伺服器連不上（{self.base_url}）：到 系統核心 › 連線 啟動") from e
        except httpx.TimeoutException as e:
            raise EngineError("Qwen 合成逾時（600 秒）") from e
        except httpx.HTTPError as e:  # 連線中斷、回應讀到一半被重設：照實回報（不然變成沒有 CORS 標頭的 500，畫面只看到 Failed to fetch）
            raise EngineError(f"{self.name} 連線中斷：{e!r}") from e
        if r.status_code >= 400:
            detail = r.json().get("detail", r.text[:300]) if r.headers.get("content-type", "").startswith("application/json") else r.text[:300]
            raise EngineError(f"Qwen 回 {r.status_code}：{detail}")
        if not r.content.startswith(b"RIFF"):
            raise EngineError(f"Qwen 回傳的不是 WAV（{r.headers.get('content-type')}）")
        return r.content


def build_engines(client: httpx.Client) -> dict[str, HttpEngine]:
    return {
        "irodori": IrodoriEngine(os.environ.get("CHERUNO_IRODORI_URL", "http://127.0.0.1:8088"), client),
        "zonos": ZonosEngine(os.environ.get("CHERUNO_ZONOS_URL", "http://127.0.0.1:8092"), client, str(paths.path("zonosVoices"))),
        "qwen-comfy": QwenEngine(os.environ.get("CHERUNO_QWEN_URL", "http://127.0.0.1:8094"), client),
    }
