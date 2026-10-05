"""判定引擎：match / equivalent / included / shortest_difference。

shortest_difference 在左右表达式的导数积空间上做 BFS，
按（长度，字典序）返回首个可区分串；若积空间全部一致则给出
等价证明图（双模拟）；状态预算耗尽时返回 unknown 与可序列化前沿，
前沿可通过 resume_difference 恢复继续探索（未探索状态不视为拒绝）。
"""
from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import dataclass, field

from .ast import Context
from .parser import parse

EQUIVALENT = "equivalent"
DIFFERENT = "different"
UNKNOWN = "unknown"


def fingerprint(alphabet_str, left_str, right_str, visited=None, queue=None):
    """把 (字母表, 左式, 右式, 已访问对, 前沿队列) 绑定为防篡改指纹。"""
    payload = json.dumps([alphabet_str, left_str, right_str,
                          visited or [], queue or []],
                         ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class DiffResult:
    status: str                      # EQUIVALENT / DIFFERENT / UNKNOWN
    counterexample: str | None = None
    side: str | None = None          # "left" / "right"：反例被哪一侧接受
    proof: dict | None = None        # 等价时的双模拟证明图
    state: dict | None = None        # unknown 时的可保存前沿
    explored: int = 0

    @property
    def equivalent(self):
        return self.status == EQUIVALENT


def match(ctx, node, s):
    return ctx.match(node, s)


def _make_proof(ctx, left, right, pairs):
    """由已完成探索的 pair 集合构造双模拟证明图（迁移按区间合并）。"""
    index = {(l.nid, r.nid): i for i, (l, r) in enumerate(pairs)}
    edges = []
    for i, (l, r) in enumerate(pairs):
        # 按字母表顺序把相邻且目标 pair 相同的字符合并为区间
        spans = []
        for ch in ctx.alphabet:
            tgt = index[(ctx.derive(l, ch).nid, ctx.derive(r, ch).nid)]
            if spans and spans[-1][2] == tgt and ord(ch) == ord(spans[-1][1]) + 1:
                spans[-1] = (spans[-1][0], ch, tgt)
            else:
                spans.append((ch, ch, tgt))
        for lo, hi, tgt in spans:
            edges.append([i, [lo, hi], tgt])
    return {
        "kind": "equivalence-proof",
        "alphabet": ctx.alphabet_str,
        "left": ctx.to_str(left),
        "right": ctx.to_str(right),
        "pairs": [[ctx.to_str(l), ctx.to_str(r)] for l, r in pairs],
        "edges": edges,
    }


def _make_state(ctx, left, right, pairs, queue):
    visited = [[ctx.to_str(l), ctx.to_str(r)] for l, r in pairs]
    frontier = [[ctx.to_str(l), ctx.to_str(r), prefix]
                for l, r, prefix in queue]
    return {
        "kind": "frontier",
        "alphabet": ctx.alphabet_str,
        "left": ctx.to_str(left),
        "right": ctx.to_str(right),
        "fingerprint": fingerprint(ctx.alphabet_str, ctx.to_str(left),
                                   ctx.to_str(right), visited, frontier),
        "visited": visited,
        "queue": frontier,
    }


def _bfs(ctx, left, right, budget, pairs, queue):
    seen = {(l.nid, r.nid) for l, r in pairs}
    pairs = list(pairs)
    dq = deque(queue)
    explored = 0
    while dq:
        if budget is not None and explored >= budget:
            return DiffResult(
                UNKNOWN,
                state=_make_state(ctx, left, right, pairs, list(dq)),
                explored=explored,
            )
        l, r, prefix = dq.popleft()
        key = (l.nid, r.nid)
        if key in seen:
            continue
        seen.add(key)
        pairs.append((l, r))
        explored += 1
        if ctx.nullable(l) != ctx.nullable(r):
            return DiffResult(
                DIFFERENT,
                counterexample=prefix,
                side="left" if ctx.nullable(l) else "right",
                explored=explored,
            )
        for ch in ctx.alphabet:
            dq.append((ctx.derive(l, ch), ctx.derive(r, ch), prefix + ch))
    return DiffResult(EQUIVALENT,
                      proof=_make_proof(ctx, left, right, pairs),
                      explored=explored)


def shortest_difference(ctx, left, right, budget=None):
    """返回按（长度，字典序）最短的差异样本；等价时返回证明图。

    budget 限制探索的 pair 状态数，耗尽时返回 UNKNOWN 与可保存前沿。
    """
    return _bfs(ctx, left, right, budget, [], [(left, right, "")])


def resume_difference(state, budget=None):
    """从保存的前沿恢复探索。

    前沿绑定了原表达式与字母表：指纹校验失败（表达式/字母表被替换
    或状态被篡改）会抛出 ValueError，而不是把未探索状态当作拒绝。
    """
    if not isinstance(state, dict) or state.get("kind") != "frontier":
        raise ValueError("not a frontier state")
    alphabet = state["alphabet"]
    left_s, right_s = state["left"], state["right"]
    expect = fingerprint(alphabet, left_s, right_s,
                         state.get("visited"), state.get("queue"))
    if state.get("fingerprint") != expect:
        raise ValueError("frontier fingerprint mismatch: "
                         "state is tampered or not bound to these expressions")
    ctx = Context(alphabet)
    left, right = parse(ctx, left_s), parse(ctx, right_s)
    pairs = [(parse(ctx, l), parse(ctx, r)) for l, r in state["visited"]]
    queue = [(parse(ctx, l), parse(ctx, r), p) for l, r, p in state["queue"]]
    return _bfs(ctx, left, right, budget, pairs, queue)


def equivalent(ctx, left, right, budget=None):
    return shortest_difference(ctx, left, right, budget)


def included(ctx, sub, sup, budget=None):
    """判断 L(sub) ⊆ L(sup)。等价于 L(sub & ~sup) 为空。

    返回 DiffResult：EQUIVALENT 表示包含成立；DIFFERENT 时
    counterexample 是属于 sub 但不属于 sup 的最短证人。
    """
    diff = ctx.inter(sub, ctx.compl(sup))
    return shortest_difference(ctx, diff, ctx.empty, budget)


def verify_proof(ctx, left, right, proof):
    """验证等价证明图是否为 (left, right) 在当前字母表上的有效双模拟。"""
    try:
        if not isinstance(proof, dict) or proof.get("kind") != "equivalence-proof":
            return False
        if proof["alphabet"] != ctx.alphabet_str:
            return False
        if proof["left"] != ctx.to_str(left) or proof["right"] != ctx.to_str(right):
            return False
        pairs = [(parse(ctx, l), parse(ctx, r)) for l, r in proof["pairs"]]
        if not pairs or pairs[0] != (left, right):
            return False
        index = {}
        for i, (l, r) in enumerate(pairs):
            if ctx.nullable(l) != ctx.nullable(r):
                return False
            index.setdefault((l.nid, r.nid), i)
        # 每个 pair 的每条出边都必须落在证明中的对应 pair 上，且覆盖全字母表
        edge_map = {}
        for src, (lo, hi), tgt in proof["edges"]:
            for code in range(ord(lo), ord(hi) + 1):
                ch = chr(code)
                if ch not in ctx.alphabet_set:
                    return False
                if (src, ch) in edge_map:
                    return False  # 区间重叠
                edge_map[(src, ch)] = tgt
        for i, (l, r) in enumerate(pairs):
            for ch in ctx.alphabet:
                tgt = edge_map.get((i, ch))
                if tgt is None:
                    return False  # 字母表未覆盖完整
                want = index.get((ctx.derive(l, ch).nid, ctx.derive(r, ch).nid))
                if want is None or tgt >= len(pairs) or tgt != want:
                    return False
        return True
    except (KeyError, IndexError, TypeError, ValueError):
        return False
