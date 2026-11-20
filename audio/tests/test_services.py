import json
import tempfile
import threading
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from cheruno_audio.server import create_app


class FakeRunner:
    """假執行器：記下要跑的指令，不真的開程式；up＝哪些健康檢查網址回 200"""

    bash = "bash"
    lms = "lms"

    def __init__(self, up: set[str] | None = None, models: list[dict] | None = None, running: dict[str, int] | None = None, free_mb: int = 7000, ram_mb: int = 9000):
        self.up = up or set()
        self.models = models
        self.running = running or {}  # 停止時找得到幾個程序
        self.log: list[tuple] = []
        self.free_mb = free_mb
        self.ram_mb = ram_mb

    def spawn(self, argv, log, env=None):
        self.log.append(("spawn", " ".join(a.replace("\\", "/").rsplit("/", 1)[-1] for a in argv[:3])))

    def exists(self, p):
        return Path(p).name not in self.absent

    absent: set[str] = set()

    def run(self, argv, timeout):
        if argv[0] == "nvidia-smi":
            return 0, f"{self.free_mb}\n"
        if argv[1:] == ["ls", "--json"]:
            return 0, json.dumps([{"modelKey": m["id"], "sizeBytes": m.get("size", 4_413_532_864)} for m in self.models or []])
        self.log.append(("run", " ".join(argv)))
        if argv[1] == "load":
            for m in self.models or []:
                m["state"] = "loaded" if m["id"] == argv[2] else "not-loaded"
        if argv[1] == "unload":
            for m in self.models or []:
                m["state"] = "not-loaded"
        return 0, "ok"

    def kill(self, match, launcher=None):
        n = self.running.pop(match, 0)
        self.log.append(("kill", match, launcher) if launcher else ("kill", match))
        return n

    def ram_free_mb(self):
        return self.ram_mb

    def get(self, url):
        if url.endswith("/api/v0/models"):
            return None if self.models is None else httpx.Response(200, json={"data": self.models})
        if url in self.up:
            return httpx.Response(200, json={"runtime": {"loaded": True}})
        return None


def client(r: FakeRunner) -> TestClient:
    return TestClient(create_app({}, data_dir=Path(tempfile.mkdtemp(prefix="cheruno-svc-")), runner=r))


def test_status_lists_every_service():
    r = FakeRunner(up={"http://127.0.0.1:8092/v2/capabilities"}, models=[{"id": "gemma", "state": "loaded", "type": "llm"}])
    s = client(r).get("/services").json()
    assert s["zonos"]["running"] and s["zonos"]["ready"]
    assert not s["irodori"]["running"] and not s["qwen"]["running"]
    assert s["lmstudio"] == {"running": True, "models": [{"id": "gemma", "state": "loaded", "type": "llm"}], "loading": None}


def test_start_zonos_stops_irodori_then_runs_fixed_script():
    r = FakeRunner(running={"irodori_openai_tts": 2})
    res = client(r).post("/services/zonos/start").json()
    assert res["starting"] and res["stopped"] == ["irodori"]
    assert ("kill", "irodori_openai_tts", "start_irodori.sh") in r.log
    assert ("spawn", "zonos3-server.exe backbone-ptq.gguf --gpu") in r.log


def test_start_already_running_does_not_spawn():
    r = FakeRunner(up={"http://127.0.0.1:8094/health"})
    res = client(r).post("/services/qwen/start").json()
    assert res["already"] and not any(x[0] == "spawn" for x in r.log)


def test_unknown_service_is_404():
    c = client(FakeRunner())
    assert c.post("/services/rm-rf/start").status_code == 404
    assert c.post("/services/rm-rf/stop").status_code == 404


def test_lms_load_validates_and_unloads_others():
    models = [{"id": "gemma-e2b", "state": "not-loaded", "type": "llm"}, {"id": "gemma-e4b", "state": "loaded", "type": "llm"}, {"id": "nomic", "state": "not-loaded", "type": "embeddings"}]
    r = FakeRunner(models=models)
    c = client(r)
    assert c.post("/services/lmstudio/load", json={"model": "evil; rm -rf"}).status_code == 400
    assert c.post("/services/lmstudio/load", json={"model": "nomic"}).status_code == 400  # embedding 不是聊天模型
    res = c.post("/services/lmstudio/load", json={"model": "gemma-e2b"}).json()
    assert {k: res[k] for k in ("model", "loaded", "already", "unloaded")} == {"model": "gemma-e2b", "loaded": True, "already": False, "unloaded": ["gemma-e4b"]}
    assert ("run", "lms unload --all") in r.log and ("run", "lms load gemma-e2b --gpu max --context-length 8192 -y") in r.log
    n = len(r.log)
    assert c.post("/services/lmstudio/load", json={"model": "gemma-e2b"}).json()["already"]  # 已載入就不重載
    assert len(r.log) == n


def test_lms_load_without_server_is_503_and_unload_is_noop():
    c = client(FakeRunner(models=None))
    assert c.post("/services/lmstudio/load", json={"model": "x"}).status_code == 503
    assert c.post("/services/lmstudio/unload").json() == {"unloaded": False, "reason": "LM Studio server 沒開"}


def test_lms_start_and_unload():
    r = FakeRunner(models=[{"id": "g", "state": "loaded", "type": "llm"}])
    c = client(r)
    assert c.post("/services/lmstudio/start").json()["running"]
    assert ("run", "lms server start --cors") in r.log
    assert c.post("/services/lmstudio/unload").json() == {"unloaded": True}


def test_lms_load_refuses_when_vram_is_short():
    # E4B 檔 6.3 GB → 估 0.75 倍＋512 MB ≈ 5036 MB；ZONOS 開著剩 4500 MB 時拒絕，且不呼叫 lms load
    r = FakeRunner(models=[{"id": "e4b", "state": "not-loaded", "type": "llm", "size": 6_325_659_072}], up={"http://127.0.0.1:8092/v2/capabilities"}, free_mb=4500)
    res = client(r).post("/services/lmstudio/load", json={"model": "e4b"})
    assert res.status_code == 409 and "zonos" in res.json()["detail"]
    assert not any(x[1].startswith("lms load") for x in r.log)
    r2 = FakeRunner(models=[{"id": "e4b", "state": "not-loaded", "type": "llm", "size": 6_325_659_072}], free_mb=5100)
    assert client(r2).post("/services/lmstudio/load", json={"model": "e4b"}).json()["vramNeedMb"] == 5036


def test_lms_load_refuses_when_ram_is_short():
    # E2B 檔 4.41 GB → 主記憶體估 0.85 倍＋1 GB ≈ 4601 MB；剩 4000 MB 時拒絕且不載入
    r = FakeRunner(models=[{"id": "e2b", "state": "not-loaded", "type": "llm"}], ram_mb=4000)
    res = client(r).post("/services/lmstudio/load", json={"model": "e2b"})
    assert res.status_code == 409 and "主記憶體" in res.json()["detail"]
    assert not any(x[1].startswith("lms load") for x in r.log)


def test_unload_during_load_cancels_it():
    # 實測：載入中下 lms unload --all，lms load 會以「Engine protocol startup was aborted」結束（code 1）
    release = threading.Event()

    class Slow(FakeRunner):
        def run(self, argv, timeout):
            if argv[1:2] == ["load"]:
                release.wait(10)
                return 1, "Error: Engine protocol startup was aborted."
            if argv[1:3] == ["unload", "--all"]:
                release.set()
            return super().run(argv, timeout)

    r = Slow(models=[{"id": "e4b", "state": "not-loaded", "type": "llm"}])
    c = client(r)
    out = {}
    th = threading.Thread(target=lambda: out.setdefault("res", c.post("/services/lmstudio/load", json={"model": "e4b"})))
    th.start()
    for _ in range(100):
        if any(x[1].startswith("lms load") for x in r.log) or release.is_set():
            break
        threading.Event().wait(0.02)
    threading.Event().wait(0.1)
    assert c.post("/services/lmstudio/unload").json() == {"unloaded": True}
    th.join(10)
    res = out["res"]
    assert res.status_code == 409 and res.json()["detail"] == "已取消載入 e4b"
    # 之後正常載入不受影響
    release.clear()
    r2 = FakeRunner(models=[{"id": "e4b", "state": "not-loaded", "type": "llm"}])
    assert client(r2).post("/services/lmstudio/load", json={"model": "e4b"}).json()["loaded"]


def test_cancel_before_model_reaches_server_still_ends_unloaded():
    # unload 下得太早（模型還沒進 server）：lms load 照樣成功 → 載完後再卸載一次，回「已取消」
    started, release = threading.Event(), threading.Event()

    class Early(FakeRunner):
        def run(self, argv, timeout):
            if argv[1:2] == ["load"]:
                started.set()
                release.wait(10)
                return super().run(argv, timeout)  # 成功載入
            return super().run(argv, timeout)

    r = Early(models=[{"id": "e4b", "state": "not-loaded", "type": "llm"}])
    c = client(r)
    out = {}
    th = threading.Thread(target=lambda: out.setdefault("res", c.post("/services/lmstudio/load", json={"model": "e4b"})))
    th.start()
    assert started.wait(10)
    c.post("/services/lmstudio/unload")
    release.set()
    th.join(10)
    assert out["res"].status_code == 409
    assert r.log[-1] == ("run", "lms unload --all") and all(m["state"] == "not-loaded" for m in r.models)


def test_stop_kills_server_and_launcher():
    r = FakeRunner(running={"zonos3-server": 1})
    assert client(r).post("/services/zonos/stop").json() == {"stopped": 1}
    assert ("kill", "zonos3-server") in r.log  # ZONOS 直接開伺服器程式，沒有啟動腳本


def test_stop_waits_for_start_in_progress():
    # 啟動還在停衝突引擎（還沒開程式）時按停止：停止要等啟動開完程式再停，不能先跑完、讓啟動之後把程式開起來
    in_kill, go = threading.Event(), threading.Event()
    order = []

    class Racy(FakeRunner):
        def kill(self, match, launcher=None):
            if match == "irodori_openai_tts":  # 啟動 zonos 時先停 irodori
                in_kill.set()
                go.wait(10)
            order.append(("kill", match))
            return super().kill(match, launcher)

        def spawn(self, argv, log, env=None):
            order.append(("spawn",))
            super().spawn(argv, log)

    r = Racy()
    c = client(r)
    th = threading.Thread(target=lambda: c.post("/services/zonos/start"))
    th.start()
    assert in_kill.wait(10)
    st = threading.Thread(target=lambda: c.post("/services/zonos/stop"))
    st.start()
    threading.Event().wait(0.2)
    go.set()
    th.join(10)
    st.join(10)
    assert order == [("kill", "irodori_openai_tts"), ("spawn",), ("kill", "zonos3-server")]


def test_status_shows_load_in_progress_to_every_client():
    started, release = threading.Event(), threading.Event()

    class Slow(FakeRunner):
        def run(self, argv, timeout):
            if argv[1:2] == ["load"]:
                started.set()
                release.wait(10)
            return super().run(argv, timeout)

    r = Slow(models=[{"id": "e4b", "state": "not-loaded", "type": "llm"}])
    c = client(r)
    th = threading.Thread(target=lambda: c.post("/services/lmstudio/load", json={"model": "e4b"}))
    th.start()
    assert started.wait(10)
    ld = c.get("/services").json()["lmstudio"]["loading"]  # 另一個頁面查狀態
    assert ld["model"] == "e4b" and ld["seconds"] >= 0
    release.set()
    th.join(10)
    assert c.get("/services").json()["lmstudio"]["loading"] is None


def test_load_timeout_cleans_up_and_external_loading_is_reported():
    class Stuck(FakeRunner):
        def run(self, argv, timeout):
            if argv[1:2] == ["load"]:
                return 124, "超過 300 秒沒結束"
            return super().run(argv, timeout)

    r = Stuck(models=[{"id": "e2b", "state": "not-loaded", "type": "llm"}])
    c = client(r)
    res = c.post("/services/lmstudio/load", json={"model": "e2b"})
    assert res.status_code == 504 and "超過 5 分鐘" in res.json()["detail"]
    assert r.log[-1] == ("run", "lms unload --all")
    # LM Studio 自己標 loading（別處觸發或卡住）：狀態也要報出來
    r2 = FakeRunner(models=[{"id": "e2b", "state": "loading", "type": "llm"}])
    assert client(r2).get("/services").json()["lmstudio"]["loading"] == {"model": "e2b", "seconds": None}


def test_status_reports_missing_engine_and_start_refuses():
    """沒裝好的引擎：狀態回 installed false＋缺什麼；按啟動回 409 說要重新跑 setup，不去開程式"""
    r = FakeRunner()
    r.absent = {"zonos3-server.exe"}
    c = client(r)
    s = c.get("/services").json()
    assert s["zonos"]["installed"] is False and "zonos3-server.exe" in s["zonos"]["missing"]
    assert s["qwen"]["installed"] is True
    res = c.post("/services/zonos/start")
    assert res.status_code == 409 and "startserver.bat setup" in res.json()["detail"]
    assert not any(x[0] == "spawn" for x in r.log)


def test_no_irodori_in_public_build(monkeypatch):
    """公開版沒有 irodoriScript：Irodori 是「沒裝」，啟動 ZONOS 時不去停它"""
    from cheruno_audio import paths

    monkeypatch.setattr(paths, "_local", lambda: {})
    r = FakeRunner()
    c = client(r)
    assert c.get("/services").json()["irodori"] == {**c.get("/services").json()["irodori"], "installed": False, "missing": "這個版本沒有 Irodori"}
    res = c.post("/services/zonos/start").json()
    assert res["stopped"] == [] and not any(x[0] == "kill" for x in r.log)
