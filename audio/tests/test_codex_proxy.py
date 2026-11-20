"""Codex 代理（[[TASKS_Codex連線]] C-02）：用假的 codex 執行檔回放事件，檢查參數、沙盒設定、工具偵測、錯誤與清理。"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cheruno_audio import codex_proxy
from cheruno_audio.codex_proxy import DISABLED_FEATURES, codex_router, env_with_home, load_home, to_prompt

FAKE = r'''
import json, os, sys, time
log = os.environ["FAKE_CODEX_LOG"]
sys.stdin.reconfigure(encoding="utf-8")  # 真的 codex 用 UTF-8 讀 stdin；Windows 的 Python 預設是 cp950
sys.stdout.reconfigure(encoding="utf-8")
prompt = sys.stdin.read()
json.dump({"argv": sys.argv[1:], "stdin": prompt, "cwd": os.getcwd(), "cwd_files": os.listdir("."), "codex_home": os.environ.get("CODEX_HOME"), "pid": os.getpid()}, open(log, "w", encoding="utf-8"), ensure_ascii=False)
def ev(o):
    print(json.dumps(o, ensure_ascii=False), flush=True)
s = os.environ["FAKE_CODEX"]
ev({"type": "thread.started", "thread_id": "t"})
ev({"type": "turn.started"})
if s == "tool":
    ev({"type": "item.started", "item": {"id": "1", "type": "command_execution", "command": "whoami", "status": "in_progress"}})
    time.sleep(30)
    open(log + ".survived", "w").write("1")
if s == "failed":
    ev({"type": "turn.failed", "error": {"message": "boom"}})
    sys.exit(1)
if s == "slow":
    time.sleep(1.0)
ev({"type": "item.completed", "item": {"id": "2", "type": "reasoning", "text": "..."}})
ev({"type": "item.completed", "item": {"id": "3", "type": "agent_message", "text": "{\"name\": \"リナ\"}"}})
ev({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}})
'''


@pytest.fixture()
def fake(tmp_path):
    py = tmp_path / "fake_codex.py"
    py.write_text(FAKE, encoding="utf-8")
    cmd = tmp_path / ("codex.cmd" if os.name == "nt" else "codex")
    if os.name == "nt":
        cmd.write_text(f'@"{sys.executable}" "{py}" %*\r\n', encoding="utf-8")
    else:
        cmd.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{py}" "$@"\n', encoding="utf-8")
        cmd.chmod(0o755)
    log = tmp_path / "log.json"

    def make(scenario: str, home: str | None = "/fake-codex-home"):
        env = {**os.environ, "FAKE_CODEX": scenario, "FAKE_CODEX_LOG": str(log)}
        if home:
            env["CODEX_HOME"] = home
        app = FastAPI()
        app.include_router(codex_router(tmp_path / "codex.json", find_exe=lambda: str(cmd), env_of=lambda: env))
        return TestClient(app)

    return make, log


def body(**extra):
    return {"model": "codex-default", "messages": [{"role": "system", "content": "あなたは創作の助手"}, {"role": "user", "content": "キャラを一人"}], "stream": True, **extra}


def sse(text: str) -> list:
    return [json.loads(l[5:]) if l[5:].strip() != "[DONE]" else "[DONE]" for l in text.splitlines() if l.startswith("data:")]


def alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_prompt_conversion_images_schema_model():
    png = base64.b64encode(b"\x89PNG fake").decode()
    b = {"model": "gpt-5.5", "messages": [{"role": "system", "content": "指示"}, {"role": "user", "content": [{"type": "text", "text": "這張圖"}, {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png}"}}]}, {"role": "assistant", "content": "好"}, {"role": "user", "content": "再一個"}], "response_format": {"type": "json_schema", "json_schema": {"name": "x", "schema": {"type": "object"}}}}
    prompt, images, schema, model = to_prompt(b)
    assert "<system>\n指示\n</system>" in prompt and "[附圖 1]" in prompt and prompt.rstrip().endswith("<user>\n再一個\n</user>")
    assert images == [(b"\x89PNG fake", ".png")] and schema == {"type": "object"} and model == "gpt-5.5"
    assert to_prompt(body())[3] is None  # codex-default：不帶 -m
    for bad in ({"model": "x & del", "messages": [{"role": "user", "content": "a"}]}, {"messages": [{"role": "system", "content": "a"}]}, {"messages": [{"role": "tool", "content": "a"}]}):
        with pytest.raises(codex_proxy.ProxyError):
            to_prompt(bad)


def test_ok_sandbox_args_and_cleanup(fake):
    make, log = fake
    r = make("ok").post("/codex/v1/chat/completions", json=body(response_format={"type": "json_schema", "json_schema": {"name": "c", "schema": {"type": "object", "properties": {"name": {"type": "string"}}}}}))
    assert r.status_code == 200
    out = sse(r.text)
    assert out == [{"choices": [{"delta": {"content": '{"name": "リナ"}'}}]}, "[DONE]"]
    rec = json.loads(log.read_text(encoding="utf-8"))
    a = rec["argv"]
    assert a[0] == "exec" and "--ephemeral" in a and "--skip-git-repo-check" in a and a[-2:] == ["--json", "-"]
    assert a[a.index("-s") + 1] == "read-only" and 'approval_policy="never"' in a and 'web_search="disabled"' in a
    assert {a[i + 1] for i, x in enumerate(a) if x == "--disable"} == set(DISABLED_FEATURES)
    assert "-m" not in a
    schema_file = Path(a[a.index("--output-schema") + 1])
    assert rec["cwd_files"] == [] and Path(a[a.index("-C") + 1]) == Path(rec["cwd"])  # 在空資料夾跑
    assert "キャラを一人" in rec["stdin"] and rec["codex_home"] == "/fake-codex-home"
    assert not schema_file.exists() and not Path(rec["cwd"]).exists()  # 暫存資料夾刪掉


def test_tool_use_is_stopped_and_process_tree_killed(fake):
    make, log = fake
    t0 = time.time()
    r = make("tool").post("/codex/v1/chat/completions", json=body())
    out = sse(r.text)
    assert "command_execution" in out[0]["error"]["message"] and "[DONE]" not in out
    assert time.time() - t0 < 20  # 沒有等假 codex 睡完 30 秒
    pid = json.loads(log.read_text(encoding="utf-8"))["pid"]
    assert not alive(pid)  # 整個程序樹都停了（.cmd 底下的 python 也是）


def test_turn_failed_reports_error(fake):
    make, _ = fake
    out = sse(make("failed").post("/codex/v1/chat/completions", json=body()).text)
    assert out == [{"error": {"message": "Codex 失敗：boom"}}]


def test_keepalive_while_waiting(fake, monkeypatch):
    make, _ = fake
    monkeypatch.setattr(codex_proxy, "KEEPALIVE_S", 0.2)
    r = make("slow").post("/codex/v1/chat/completions", json=body())
    assert ": keepalive" in r.text and sse(r.text)[-1] == "[DONE]"


def test_missing_codex_and_models(fake):
    make, _ = fake
    assert make("ok").get("/codex/v1/models").json()["data"][0]["id"] == "codex-default"
    app = FastAPI()
    app.include_router(codex_router(Path("unused-codex.json"), find_exe=lambda: None))
    c = TestClient(app)
    assert c.get("/codex/v1/models").status_code == 503
    assert c.post("/codex/v1/chat/completions", json=body()).status_code == 503


def settings_client(tmp_path, picks=(), logged=True):
    seen = []
    queue_ = list(picks)

    def pick(initial, title):
        seen.append((initial, title))
        return queue_.pop(0)

    app = FastAPI()
    app.include_router(codex_router(tmp_path / "cfg" / "codex.json", find_exe=lambda: "codex", pick=pick, logged_in=lambda exe, env: logged and "CODEX_HOME" in env))
    return TestClient(app), seen


def test_settings_choose_validate_and_clear(tmp_path):
    c, _ = settings_client(tmp_path)
    home = tmp_path / "my-codex-home"
    home.mkdir()
    st = c.get("/codex/settings").json()
    assert st["codexHome"] is None and st["codexFound"] is True  # 還沒選：用 Codex 自己的預設
    st = c.put("/codex/settings", json={"codexHome": f'"{home}"'}).json()  # 貼上帶引號的路徑也收
    assert st["codexHome"] == str(os.path.normpath(home)) and st["effective"] == str(os.path.normpath(home)) and st["exists"] and st["loggedIn"]
    assert str(load_home(tmp_path / "cfg" / "codex.json")) == os.path.normpath(home)
    assert env_with_home(home)["CODEX_HOME"] == str(home)  # codex exec 的子程序用它
    assert c.put("/codex/settings", json={"codexHome": "relative/dir"}).status_code == 400
    assert c.put("/codex/settings", json={"codexHome": str(tmp_path / "nope")}).status_code == 400
    assert str(load_home(tmp_path / "cfg" / "codex.json")) == os.path.normpath(home)  # 填錯不覆蓋原本的
    assert c.put("/codex/settings", json={"codexHome": ""}).json()["codexHome"] is None


def test_settings_pick_cancel_and_choose(tmp_path):
    home = tmp_path / "picked"
    home.mkdir()
    c, seen = settings_client(tmp_path, picks=[None, str(home)])
    assert c.post("/codex/settings/pick").json()["cancelled"] is True
    r = c.post("/codex/settings/pick").json()
    assert r["cancelled"] is False and r["codexHome"] == str(os.path.normpath(home))
    assert "CODEX_HOME" in seen[0][1]  # 視窗標題寫清楚在選什麼


def test_chat_uses_chosen_home(tmp_path, fake):
    make, log = fake
    c, _ = settings_client(tmp_path)
    home = tmp_path / "home2"
    home.mkdir()
    c.put("/codex/settings", json={"codexHome": str(home)})
    env = env_with_home(load_home(tmp_path / "cfg" / "codex.json"))
    assert env["CODEX_HOME"] == str(os.path.normpath(home))
