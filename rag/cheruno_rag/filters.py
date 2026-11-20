"""filter：只執行設定檔 filter 清單寫的規則，依序套用；被淘汰的記下是哪條規則。設定檔沒寫規則＝全部保留。

規則（每條是 {type: ..., 參數..., name?: 自訂名稱}）：
  min_chars {value}          整段字數（系統提示＋所有台詞）少於 value
  max_chars {value}          整段字數多於 value
  min_turns {value}          台詞輪數少於 value
  max_turns {value}          台詞輪數多於 value
  dedupe {}                  內容完全相同的只留第一筆
  require_meta {keys: [...]} 這些 meta 欄位空的淘汰
  where {key, equals?|in?|contains?, negate?}   meta 條件不符合的淘汰（negate: true 反過來＝符合的淘汰）
  regex_exclude {pattern, scope?}  scope：all（預設）｜system｜turns｜meta:<鍵>；比對到就淘汰
  regex_include {pattern, scope?}  比對不到就淘汰
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from typing import Any

from .normalize import Conversation

RULE_TYPES = ("min_chars", "max_chars", "min_turns", "max_turns", "dedupe", "require_meta", "where", "regex_exclude", "regex_include")


class FilterError(ValueError):
    pass


def _scope_text(c: Conversation, scope: str) -> str:
    if scope == "all":
        return c.system + "\n" + "\n".join(t for _r, t in c.turns)
    if scope == "system":
        return c.system
    if scope == "turns":
        return "\n".join(t for _r, t in c.turns)
    if scope.startswith("meta:"):
        v = c.meta.get(scope[5:])
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    raise FilterError(f"不認得的 scope：{scope}（all｜system｜turns｜meta:<鍵>）")


def _meta_match(v: Any, rule: dict) -> bool:
    if "equals" in rule:
        return v == rule["equals"]
    if "in" in rule:
        return v in rule["in"]
    if "contains" in rule:
        return isinstance(v, (str, list)) and rule["contains"] in v
    raise FilterError("where 要有 equals、in 或 contains 其中一個")


class FilterChain:
    def __init__(self, rules: list[dict]):
        self.rules = []
        for i, r in enumerate(rules):
            t = r.get("type")
            if t not in RULE_TYPES:
                raise FilterError(f"filter 第 {i + 1} 條的 type「{t}」不認得（可用：{', '.join(RULE_TYPES)}）")
            if t.startswith("regex_"):
                r = {**r, "_re": re.compile(r["pattern"])}
            self.rules.append((r.get("name") or f"{i + 1}:{t}", r))
        self.seen: set[str] = set()
        self.counts: Counter = Counter()

    def check(self, c: Conversation) -> str | None:
        """通過回 None；淘汰回規則名稱"""
        for name, r in self.rules:
            t = r["type"]
            drop = False
            if t == "min_chars":
                drop = c.n_chars < r["value"]
            elif t == "max_chars":
                drop = c.n_chars > r["value"]
            elif t == "min_turns":
                drop = len(c.turns) < r["value"]
            elif t == "max_turns":
                drop = len(c.turns) > r["value"]
            elif t == "dedupe":
                h = hashlib.sha256(json.dumps([c.system, c.turns], ensure_ascii=False).encode()).hexdigest()
                drop = h in self.seen
                self.seen.add(h)
            elif t == "require_meta":
                drop = any(c.meta.get(k) in (None, "", [], {}) for k in r["keys"])
            elif t == "where":
                hit = _meta_match(c.meta.get(r["key"]), r)
                drop = hit if r.get("negate") else not hit
            elif t == "regex_exclude":
                drop = bool(r["_re"].search(_scope_text(c, r.get("scope", "all"))))
            elif t == "regex_include":
                drop = not r["_re"].search(_scope_text(c, r.get("scope", "all")))
            if drop:
                self.counts[name] += 1
                return name
        return None
