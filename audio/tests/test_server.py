import base64
import io
import json
import tempfile

import httpx
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from cheruno_audio.engines import IrodoriEngine, QwenEngine, ZonosEngine
from cheruno_audio.server import create_app
from cheruno_audio.text import irodori_text, to_reading, to_surface


def wav_bytes(seconds: float = 0.5) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(48000 * seconds), dtype=np.float32), 48000, format="WAV")
    return buf.getvalue()


ZONOS_VOICES = tempfile.mkdtemp(prefix="zonos-voices-")


def make_client(handler) -> TestClient:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    engines = {"irodori": IrodoriEngine("http://irodori", http), "zonos": ZonosEngine("http://zonos", http, ZONOS_VOICES)}
    return TestClient(create_app(engines))


def test_text_helpers():
    s = "{明日|あした}は{澪|みお}と"
    assert to_reading(s) == "あしたはみおと"
    assert to_surface(s) == "明日は澪と"
    assert irodori_text("おやすみ", "whisper") == "👂おやすみ"
    assert irodori_text("ふぅ", "breath") == "😮‍💨ふぅ"


def test_tts_irodori_sends_reading_and_emoji():
    seen = {}

    def handler(req: httpx.Request):
        seen["path"] = req.url.path
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=wav_bytes(), headers={"content-type": "audio/wav"})

    c = make_client(handler)
    r = c.post("/tts", json={"engine": "irodori", "text": "{明日|あした}ね", "voice": "whisper"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content.startswith(b"RIFF")
    assert seen["path"] == "/v1/audio/speech"
    assert seen["body"]["input"] == "👂あしたね"
    assert seen["body"]["voice"] == "none"


def test_engine_down_is_503():
    def handler(req):
        raise httpx.ConnectError("refused", request=req)

    r = make_client(handler).post("/tts", json={"engine": "irodori", "text": "a"})
    assert r.status_code == 503
    assert "連不上" in r.json()["detail"]


def test_engine_error_is_502():
    r = make_client(lambda req: httpx.Response(500, text="CUDA out of memory")).post("/tts", json={"engine": "irodori", "text": "a"})
    assert r.status_code == 502
    assert "CUDA out of memory" in r.json()["detail"]


def test_non_wav_response_is_502():
    r = make_client(lambda req: httpx.Response(200, content=b"ID3....", headers={"content-type": "audio/mpeg"})).post(
        "/tts", json={"engine": "irodori", "text": "a"}
    )
    assert r.status_code == 502


def test_unknown_engine_and_voice_are_400():
    c = make_client(lambda req: httpx.Response(200, content=wav_bytes()))
    assert c.post("/tts", json={"engine": "nope", "text": "a"}).status_code == 400
    assert c.post("/tts", json={"engine": "irodori", "text": "a", "voice": "shout"}).status_code == 400


def test_zonos_requires_speaker():
    r = make_client(lambda req: httpx.Response(200, content=wav_bytes())).post("/tts", json={"engine": "zonos", "text": "a"})
    assert r.status_code == 502
    assert "speaker" in r.json()["detail"]


def qwen_client(seen: dict, fail: str | None = None) -> TestClient:
    """假 qwen_server：/voice_design 回 WAV（或 500＋錯誤訊息）；記下送了什麼"""

    def handler(req: httpx.Request):
        if req.url.path == "/voice_design":
            seen["body"] = json.loads(req.content)
            if fail:
                return httpx.Response(500, json={"detail": fail})
            return httpx.Response(200, content=wav_bytes(), headers={"content-type": "audio/wav"})
        return httpx.Response(404)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    return TestClient(create_app({"qwen-comfy": QwenEngine("http://qwen", http)}))


def test_qwen_payload_and_wav():
    seen: dict = {}
    r = qwen_client(seen).post("/tts", json={"engine": "qwen-comfy", "text": "{明日|あした}ね", "voice": "whisper", "speaker": "若い女性の声。", "style": "耳元でささやくように。", "seed": 1390633093, "unload_after": True})
    assert r.status_code == 200 and r.content.startswith(b"RIFF")
    assert seen["body"] == {"text": "あしたね", "instruct": "若い女性の声。耳元でささやくように。", "seed": 1390633093, "unload_after": True}


def test_qwen_error_is_502():
    r = qwen_client({}, fail="CUDA out of memory").post("/tts", json={"engine": "qwen-comfy", "text": "a", "speaker": "x", "style": "", "seed": 1})
    assert r.status_code == 502 and "CUDA out of memory" in r.json()["detail"]


def test_health_reports_each_engine():
    def handler(req: httpx.Request):
        if req.url.host == "zonos":
            raise httpx.ConnectError("refused", request=req)
        return httpx.Response(200, json={"status": "ok"})

    body = make_client(handler).get("/health").json()
    assert body["ok"] is True
    assert body["engines"]["irodori"]["reachable"] is True
    assert body["engines"]["zonos"]["reachable"] is False


def test_irodori_caption_and_seed_passed_through():
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=wav_bytes())

    r = make_client(handler).post("/tts", json={"engine": "irodori", "text": "テスト", "caption": "落ち着いた若い女性", "seed": 7})
    assert r.status_code == 200
    assert seen["body"]["irodori"] == {"caption": "落ち着いた若い女性", "seed": 7}


def test_irodori_without_caption_has_no_options():
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=wav_bytes())

    make_client(handler).post("/tts", json={"engine": "irodori", "text": "テスト"})
    assert "irodori" not in seen["body"]


def test_register_voice_uploads_then_replaces():
    calls = []
    stored = set()

    def handler(req: httpx.Request):
        calls.append((req.method, req.url.path))
        if req.method == "GET":
            return httpx.Response(200 if req.url.path.endswith("/mio") and "mio" in stored else 404)
        stored.add("mio")
        return httpx.Response(200, json={"voice_id": "mio"})

    c = make_client(handler)
    body = {"engine": "irodori", "voice_id": "mio", "wav_base64": base64.b64encode(wav_bytes()).decode()}
    assert c.post("/voice/register", json=body).json() == {"voice_id": "mio"}
    assert c.post("/voice/register", json=body).status_code == 200
    assert ("POST", "/v1/audio/voices") in calls
    assert ("PUT", "/v1/audio/voices/mio") in calls


def test_register_rejects_non_wav_and_unsupported_engine():
    c = make_client(lambda req: httpx.Response(200))
    bad = {"engine": "irodori", "voice_id": "mio", "wav_base64": base64.b64encode(b"ID3notwav").decode()}
    assert c.post("/voice/register", json=bad).status_code == 400


def test_qwen_requires_speaker_and_style():
    c = qwen_client({})
    assert "speaker" in c.post("/tts", json={"engine": "qwen-comfy", "text": "a", "style": ""}).json()["detail"]
    assert "style" in c.post("/tts", json={"engine": "qwen-comfy", "text": "a", "speaker": "x"}).json()["detail"]
    assert "seed" in c.post("/tts", json={"engine": "qwen-comfy", "text": "a", "speaker": "x", "style": ""}).json()["detail"]


def test_qwen_unload_defaults_off():
    seen: dict = {}
    assert qwen_client(seen).post("/tts", json={"engine": "qwen-comfy", "text": "a", "speaker": "x", "style": "", "seed": 7}).status_code == 200
    assert seen["body"]["unload_after"] is False


def zonos_server(calls: list):
    """假 zonos3-server：登錄回 speaker id、embedding 回 192 維、generate 回 WAV；記下每次請求"""

    def handler(req: httpx.Request):
        body = json.loads(req.content) if req.content else None
        calls.append((req.method, req.url.path, req.headers.get("x-tts-session-id"), body))
        if req.url.path == "/v2/speakers":
            return httpx.Response(200, json={"id": "session_abc"})
        if req.url.path == "/v2/speakers/session_abc/embedding":
            return httpx.Response(200, json={"id": "session_abc", "embedding": [0.5] * 192})
        if req.url.path == "/v2/generate":
            return httpx.Response(200, content=wav_bytes(), headers={"content-type": "audio/wav"})
        return httpx.Response(404)

    return handler


def test_zonos_register_saves_embedding_and_generate_sends_it_inline():
    calls: list = []
    c = make_client(zonos_server(calls))
    z = {"engine": "zonos", "voice_id": "mio_z", "wav_base64": base64.b64encode(wav_bytes()).decode()}
    assert c.post("/voice/register", json=z).json() == {"voice_id": "mio_z"}
    saved = np.load(f"{ZONOS_VOICES}/mio_z.npy")
    assert saved.shape == (192,) and saved.dtype == np.float32
    assert all(sid == "cheruno" for _, _, sid, _ in calls)
    r = c.post("/tts", json={"engine": "zonos", "text": "{明日|あした}ね", "speaker": "mio_z", "seed": 5})
    assert r.status_code == 200 and r.content.startswith(b"RIFF")
    gen = [b for m, p, _, b in calls if p == "/v2/generate"][0]
    assert gen["text"] == "あしたね" and gen["format"] == "wav" and gen["stream"] is False and gen["speaker_mode"] == "embedding" and gen["seed"] == 5
    assert np.load(io.BytesIO(base64.b64decode(gen["speaker_embedding_base64"]))).shape == (192,)


def test_zonos_unknown_voice_explains_how_to_fix():
    r = make_client(zonos_server([])).post("/tts", json={"engine": "zonos", "text": "a", "speaker": "nobody"})
    assert r.status_code == 502
    assert "重新設計並鎖定聲音" in r.json()["detail"]
