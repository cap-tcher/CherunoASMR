"""Claude 本機代理：對 app 提供 OpenAI 相容的 /claude/v1/models 與 /claude/v1/chat/completions，
後端用官方 anthropic SDK 呼叫 Messages API。

金鑰來自 app 存檔（系統核心 › 連線設定的 API 金鑰），由 app 放在 Authorization: Bearer 標頭送來；
這裡只轉交給 Anthropic，不存檔、不寫進 log、不回傳。
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from typing import Any

import anthropic
from anthropic import transform_schema
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

# 串流段落要快：預設 low effort（Opus 5.5 的 API 預設是 medium）；要更仔細時設環境變數
EFFORT = os.environ.get("CHERUNO_CLAUDE_EFFORT", "low")
# 思考 token 也算在 max_tokens 裡：core 給的上限是照本機模型抓的，太小會在 JSON 寫完前被截斷
MIN_MAX_TOKENS = 16000
# 這些模型支援伺服器端 fallback（被安全分類器擋下時改由後備模型接手）；Haiku 沒有
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ProxyError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def key_from(authorization: str | None) -> str:
    key = (authorization or "").removeprefix("Bearer ").strip()
    if not key:
        raise ProxyError(401, "沒有 Claude API 金鑰：到系統核心 › 連線設定的「API 金鑰」填入")
    return key


def _part(p: dict[str, Any]) -> dict[str, Any]:
    if p.get("type") == "text":
        return {"type": "text", "text": p["text"]}
    if p.get("type") == "image_url":
        url: str = p["image_url"]["url"]
        if url.startswith("data:"):
            head, _, data = url.partition(",")
            media = head[5:].split(";")[0]
            if ";base64" not in head or not data:
                raise ProxyError(400, "圖片 data URL 必須是 base64")
            return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}
        return {"type": "image", "source": {"type": "url", "url": url}}
    raise ProxyError(400, f"不支援的內容類型：{p.get('type')}")


def to_anthropic(body: dict[str, Any]) -> dict[str, Any]:
    """OpenAI chat completions 請求 → Messages API 參數。"""
    system: list[str] = []
    messages: list[dict[str, Any]] = []
    for m in body.get("messages", []):
        role, content = m.get("role"), m.get("content")
        if role == "system":
            if messages:
                raise ProxyError(400, "system 訊息只能放在最前面")
            if not isinstance(content, str):
                raise ProxyError(400, "system 訊息必須是文字")
            system.append(content)
        elif role in ("user", "assistant"):
            messages.append({"role": role, "content": content if isinstance(content, str) else [_part(p) for p in content]})
        else:
            raise ProxyError(400, f"不支援的訊息角色：{role}")
    if not messages:
        raise ProxyError(400, "沒有 user 訊息")
    params: dict[str, Any] = {
        "model": body["model"],
        "max_tokens": max(int(body.get("max_tokens") or 0), MIN_MAX_TOKENS),
        "messages": messages,
        "output_config": {"effort": EFFORT},
    }
    # temperature 不轉送：目前的 Messages API 已不接受取樣參數
    if system:
        params["system"] = "\n\n".join(system)
    rf = body.get("response_format")
    if rf and rf.get("type") == "json_schema":
        params["output_config"]["format"] = {"type": "json_schema", "schema": transform_schema(rf["json_schema"]["schema"])}
    if params["model"] in FALLBACK_MODELS:
        params["betas"] = [FALLBACK_BETA]
        params["fallbacks"] = "default"
    return params


def _chunk(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _api_error(e: Exception) -> ProxyError:
    if isinstance(e, anthropic.APIStatusError):
        return ProxyError(e.status_code, f"Claude API {e.status_code}：{e.message}")
    if isinstance(e, anthropic.APIConnectionError):
        return ProxyError(502, f"連不到 Claude API：{e}")
    raise e


def claude_router(make_client=None) -> APIRouter:
    """make_client(key) → anthropic.Anthropic；測試時可換掉。"""
    router = APIRouter(prefix="/claude/v1")
    make = make_client or (lambda key: anthropic.Anthropic(api_key=key))
    state: dict[str, Any] = {}

    def client(authorization: str | None):
        key = key_from(authorization)
        if state.get("key") != key:
            state["key"], state["client"] = key, make(key)
        return state["client"]

    @router.get("/models")
    def models(authorization: str | None = Header(default=None)) -> dict:
        try:
            ids = [m.id for m in client(authorization).models.list()]
        except ProxyError as e:
            raise HTTPException(e.status, str(e)) from e
        except Exception as e:
            pe = _api_error(e)
            raise HTTPException(pe.status, str(pe)) from e
        # 預設模型排第一
        ids.sort(key=lambda i: (i != "claude-opus-5-5", i))
        return {"object": "list", "data": [{"id": i, "object": "model"} for i in ids]}

    @router.post("/chat/completions")
    def chat(body: dict, authorization: str | None = Header(default=None)) -> StreamingResponse:
        try:
            params = to_anthropic(body)
            mgr = client(authorization).beta.messages.stream(**params)
            stream = mgr.__enter__()  # 先送出請求：金鑰錯、模型不存在等錯誤回成真正的 HTTP 狀態碼
        except ProxyError as e:
            raise HTTPException(e.status, str(e)) from e
        except Exception as e:
            pe = _api_error(e)
            raise HTTPException(pe.status, str(pe)) from e

        def events() -> Iterator[str]:
            try:
                for ev in stream:
                    if ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                        yield _chunk({"choices": [{"delta": {"content": ev.delta.text}}]})
                msg = stream.get_final_message()
                if msg.stop_reason == "refusal":
                    cat = getattr(msg.stop_details, "category", None) if msg.stop_details else None
                    yield _chunk({"error": {"message": f"Claude 拒絕了這個請求（類別：{cat or '未提供'}），這段沒有產生"}})
                elif msg.stop_reason == "max_tokens":
                    yield _chunk({"error": {"message": f"輸出到 max_tokens（{params['max_tokens']}）被截斷"}})
                else:
                    yield "data: [DONE]\n\n"
            except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
                yield _chunk({"error": {"message": str(_api_error(e))}})
            finally:
                mgr.__exit__(None, None, None)

        return StreamingResponse(events(), media_type="text/event-stream")

    return router
