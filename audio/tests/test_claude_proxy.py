from types import SimpleNamespace as NS

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cheruno_audio import claude_proxy
from cheruno_audio.claude_proxy import ProxyError, claude_router, to_anthropic

SCHEMA = {
    "type": "object",
    "properties": {"lines": {"type": "array", "minItems": 3, "items": {"type": "string", "maxLength": 40}}},
    "required": ["lines"],
    "additionalProperties": False,
}


def body(**kw):
    return {
        "model": "claude-opus-5-5",
        "messages": [{"role": "system", "content": "規則"}, {"role": "user", "content": "開始"}],
        "max_tokens": 1500,
        "temperature": 0.8,
        "response_format": {"type": "json_schema", "json_schema": {"name": "segment", "strict": True, "schema": SCHEMA}},
        **kw,
    }


def test_convert_system_schema_and_fallback():
    p = to_anthropic(body())
    assert p["system"] == "規則"
    assert p["messages"] == [{"role": "user", "content": "開始"}]
    assert "temperature" not in p
    assert p["max_tokens"] == claude_proxy.MIN_MAX_TOKENS
    fmt = p["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    # 不支援的限制被 SDK 移進描述，不送進 schema 本身
    assert "maxLength" not in fmt["schema"]["properties"]["lines"]["items"]
    assert p["fallbacks"] == "default" and p["betas"] == [claude_proxy.FALLBACK_BETA]


def test_haiku_has_no_fallback():
    assert "fallbacks" not in to_anthropic(body(model="claude-haiku-5-5"))


def test_image_data_url():
    msg = {"role": "user", "content": [{"type": "text", "text": "看圖"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}]}
    p = to_anthropic(body(messages=[msg]))
    assert p["messages"][0]["content"][1] == {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}}


def test_late_system_rejected():
    with pytest.raises(ProxyError):
        to_anthropic(body(messages=[{"role": "user", "content": "a"}, {"role": "system", "content": "b"}]))


class FakeStream:
    def __init__(self, texts, stop="end_turn"):
        self.texts, self.stop = texts, stop

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        for t in self.texts:
            yield NS(type="content_block_delta", delta=NS(type="text_delta", text=t))

    def get_final_message(self):
        return NS(stop_reason=self.stop, stop_details=NS(category="general_harms") if self.stop == "refusal" else None)


def app_with(stream, seen):
    def make(key):
        seen["key"] = key

        def start(**params):
            seen["params"] = params
            return stream

        return NS(beta=NS(messages=NS(stream=start)), models=NS(list=lambda: [NS(id="claude-haiku-5-5"), NS(id="claude-opus-5-5")]))

    app = FastAPI()
    app.include_router(claude_router(make))
    return TestClient(app)


AUTH = {"Authorization": "Bearer sk-test"}


def test_stream_openai_chunks():
    seen: dict = {}
    c = app_with(FakeStream(['{"lines":', '["あ"]}']), seen)
    r = c.post("/claude/v1/chat/completions", json=body(), headers=AUTH)
    assert r.status_code == 200
    assert seen["key"] == "sk-test"
    datas = [l[5:].strip() for l in r.text.splitlines() if l.startswith("data:")]
    assert datas[-1] == "[DONE]"
    import json

    assert "".join(json.loads(d)["choices"][0]["delta"]["content"] for d in datas[:-1]) == '{"lines":["あ"]}'


def test_refusal_is_error_chunk():
    c = app_with(FakeStream(['{"li'], stop="refusal"), {})
    r = c.post("/claude/v1/chat/completions", json=body(), headers=AUTH)
    assert "general_harms" in r.text and "[DONE]" not in r.text


def test_models_sorted_default_first():
    r = app_with(FakeStream([]), {}).get("/claude/v1/models", headers=AUTH)
    assert [m["id"] for m in r.json()["data"]] == ["claude-opus-5-5", "claude-haiku-5-5"]


def test_missing_key_401():
    r = app_with(FakeStream([]), {}).get("/claude/v1/models")
    assert r.status_code == 401 and "API 金鑰" in r.json()["detail"]
