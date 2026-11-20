import tempfile
from pathlib import Path

import pytest

from cheruno_audio import paths


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch):
    """測試不讀、不寫使用者真正的存檔區設定檔，也不讀這台電腦的 cheruno.local.json（路徑覆蓋）"""
    monkeypatch.setenv("CHERUNO_CONFIG", str(Path(tempfile.mkdtemp(prefix="cheruno-cfg-")) / "config.json"))
    monkeypatch.delenv("CHERUNO_DATA_DIR", raising=False)
    # 固定的假路徑：有 Irodori（測 ZONOS／Irodori 互斥），其他用 repo 底下的預設
    monkeypatch.setattr(paths, "_local", lambda: {"irodoriScript": "C:/fake/Tools/tts/start_irodori.sh"})
