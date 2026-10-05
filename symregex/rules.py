"""规则引擎：命名规则 + 按依赖失效的结果缓存。

缓存条目记录其依赖的 AST 子节点集合；当某条规则的表达式被替换时，
所有依赖旧表达式任一子节点的缓存条目都会失效，避免旧结果污染新判定。
"""
from __future__ import annotations

from .ast import Context
from .parser import parse
from . import engine


class RuleEngine:
    def __init__(self, alphabet):
        self.ctx = Context(alphabet)
        self.rules = {}
        self._cache = {}  # key -> (deps: frozenset[int], value)

    # ---- 规则管理 ----
    def set_rule(self, name, pattern):
        old = self.rules.get(name)
        node = parse(self.ctx, pattern)
        self.rules[name] = node
        if old is not None and old is not node:
            doomed = self.ctx.subnode_ids(old)
            self._cache = {
                k: v for k, v in self._cache.items() if not (v[0] & doomed)
            }
        return node

    def get_rule(self, name):
        try:
            return self.rules[name]
        except KeyError:
            raise KeyError(f"unknown rule: {name!r}") from None

    # ---- 缓存 ----
    @property
    def cache_size(self):
        return len(self._cache)

    def _cached(self, key, nodes, thunk):
        entry = self._cache.get(key)
        if entry is not None:
            return entry[1]
        value = thunk()
        deps = frozenset().union(*(self.ctx.subnode_ids(n) for n in nodes))
        self._cache[key] = (deps, value)
        return value

    # ---- 判定 ----
    def match(self, name, s):
        return self.ctx.match(self.get_rule(name), s)

    def equivalent(self, name_a, name_b, budget=None):
        a, b = self.get_rule(name_a), self.get_rule(name_b)
        key = ("eq", a.nid, b.nid, budget)
        return self._cached(key, (a, b),
                            lambda: engine.shortest_difference(self.ctx, a, b, budget))

    def included(self, name_sub, name_sup, budget=None):
        a, b = self.get_rule(name_sub), self.get_rule(name_sup)
        key = ("inc", a.nid, b.nid, budget)
        return self._cached(key, (a, b),
                            lambda: engine.included(self.ctx, a, b, budget))

    def shortest_difference(self, name_a, name_b, budget=None):
        return self.equivalent(name_a, name_b, budget)
