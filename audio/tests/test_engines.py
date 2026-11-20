import httpx
import pytest

from cheruno_audio.engines import EngineError, QwenEngine, TtsRequest


def test_qwen_read_reset_is_reported_as_engine_error():
    """Qwen 回應讀到一半被重設（Windows WinError 10054）：回清楚的 EngineError，不是沒接住的例外（→ 沒有 CORS 標頭的 500、畫面只看到 Failed to fetch）"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("[WinError 10054] reset", request=request)

    eng = QwenEngine("http://qwen.test", httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(EngineError, match="連線中斷"):
        eng.synthesize(TtsRequest(text="ねえ", voice="normal", speaker="やさしい声", seed=1, style=""))
