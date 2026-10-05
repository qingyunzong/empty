"""独立核对实现：Thompson 构造 + 子集构造 + 集合运算（交/补）DFA。

不使用 Brzozowski 导数，用于测试中对小字母表、短表达式交叉验证
接受语言与等价性。交与补通过确定化后的完全 DFA 做集合运算。
"""
from __future__ import annotations

from collections import deque

from . import ast as A


class _NFA:
    def __init__(self):
        self.n = 0
        self.eps = []          # state -> set(state)
        self.sym = []          # state -> {char: set(state)}
        self.start = 0
        self.accepts = set()

    def add(self):
        self.eps.append(set())
        self.sym.append({})
        self.n += 1
        return self.n - 1


def _fragment(ctx, node):
    """返回 (nfa, start, accepts)。交/补节点先确定化再嵌入。"""
    if node.tag in (A.INTER, A.COMPL):
        dfa = to_dfa(ctx, node)
        return _dfa_to_fragment(dfa)
    nfa = _NFA()
    start, accepts = _build(ctx, nfa, node)
    nfa.start = start
    nfa.accepts = accepts
    return nfa, start, accepts


def _dfa_to_fragment(dfa):
    start, trans, accepts, alphabet = dfa
    nfa = _NFA()
    for _ in range(len(trans)):
        nfa.add()
    for i, row in enumerate(trans):
        for ch, tgt in row.items():
            nfa.sym[i].setdefault(ch, set()).add(tgt)
    nfa.start = start
    nfa.accepts = set(accepts)
    return nfa, nfa.start, nfa.accepts


def _build(ctx, nfa, node):
    t = node.tag
    if t == A.EMPTY:
        s = nfa.add()
        f = nfa.add()
        return s, {f}
    if t == A.EPS:
        s = nfa.add()
        f = nfa.add()
        nfa.eps[s].add(f)
        return s, {f}
    if t == A.CHAR:
        s = nfa.add()
        f = nfa.add()
        for ch in node.args[0]:
            nfa.sym[s].setdefault(ch, set()).add(f)
        return s, {f}
    if t == A.CONCAT:
        first_start = None
        prev_accepts = None
        for child in node.args:
            cstart, caccepts = _fragment_into(ctx, nfa, child)
            if first_start is None:
                first_start = cstart
            if prev_accepts is not None:
                for a in prev_accepts:
                    nfa.eps[a].add(cstart)
            prev_accepts = caccepts
        return first_start, prev_accepts
    if t == A.UNION:
        s = nfa.add()
        accepts = set()
        for child in node.args:
            cstart, caccepts = _fragment_into(ctx, nfa, child)
            nfa.eps[s].add(cstart)
            accepts |= caccepts
        return s, accepts
    if t == A.STAR:
        s = nfa.add()
        f = nfa.add()
        cstart, caccepts = _fragment_into(ctx, nfa, node.args[0])
        nfa.eps[s].update((cstart, f))
        for a in caccepts:
            nfa.eps[a].update((cstart, f))
        return s, {f}
    raise AssertionError(t)  # pragma: no cover


def _fragment_into(ctx, nfa, node):
    if node.tag in (A.INTER, A.COMPL):
        dfa = to_dfa(ctx, node)
        frag, fstart, faccepts = _dfa_to_fragment(dfa)
        base = nfa.n
        for i in range(frag.n):
            nfa.add()
        for i in range(frag.n):
            nfa.eps[base + i] = {base + j for j in frag.eps[i]}
            nfa.sym[base + i] = {c: {base + j for j in tgts}
                                 for c, tgts in frag.sym[i].items()}
        return base + fstart, {base + a for a in faccepts}
    return _build(ctx, nfa, node)


def _eps_closure(nfa, states):
    stack = list(states)
    out = set(states)
    while stack:
        s = stack.pop()
        for t in nfa.eps[s]:
            if t not in out:
                out.add(t)
                stack.append(t)
    return out


def to_dfa(ctx, node):
    """Thompson 构造 + 子集构造。返回 (start, transitions, accepts, alphabet)。

    transitions: list[dict[char, int]]，对字母表完全。
    """
    if node.tag == A.INTER:
        dfa = to_dfa(ctx, node.args[0])
        for child in node.args[1:]:
            dfa = _product(dfa, to_dfa(ctx, child), ctx.alphabet,
                           lambda a, b: a and b)
        return dfa
    if node.tag == A.COMPL:
        start, trans, accepts, alphabet = to_dfa(ctx, node.args[0])
        return start, trans, set(range(len(trans))) - accepts, alphabet
    nfa, _, _ = _fragment(ctx, node)
    alphabet = ctx.alphabet
    start_set = frozenset(_eps_closure(nfa, {nfa.start}))
    states = [start_set]
    index = {start_set: 0}
    trans = []
    queue = deque([start_set])
    while queue:
        cur = queue.popleft()
        row = {}
        for ch in alphabet:
            nxt = set()
            for s in cur:
                nxt |= nfa.sym[s].get(ch, set())
            nxt = frozenset(_eps_closure(nfa, nxt))
            if nxt not in index:
                index[nxt] = len(states)
                states.append(nxt)
                queue.append(nxt)
            row[ch] = index[nxt]
        trans.append(row)
    accepts = {i for i, st in enumerate(states) if st & nfa.accepts}
    return index[start_set], trans, accepts, tuple(alphabet)


def _product(d1, d2, alphabet, accept_op):
    s1, t1, a1, _ = d1
    s2, t2, a2, _ = d2
    start = (s1, s2)
    states = [start]
    index = {start: 0}
    trans = []
    accepts = set()
    queue = deque([start])
    while queue:
        cur = queue.popleft()
        i = index[cur]
        row = {}
        for ch in alphabet:
            nxt = (t1[cur[0]][ch], t2[cur[1]][ch])
            if nxt not in index:
                index[nxt] = len(states)
                states.append(nxt)
                queue.append(nxt)
            row[ch] = index[nxt]
        trans.append(row)
        if accept_op(cur[0] in a1, cur[1] in a2):
            accepts.add(i)
    return index[start], trans, accepts, tuple(alphabet)


def dfa_match(dfa, s):
    start, trans, accepts, _ = dfa
    state = start
    for ch in s:
        state = trans[state][ch]
    return state in accepts


def match(ctx, node, s):
    return dfa_match(to_dfa(ctx, node), s)


def equivalent(ctx, a, b):
    """精确等价判定：两个完全 DFA 的积空间 BFS。"""
    da = to_dfa(ctx, a)
    db = to_dfa(ctx, b)
    start = (da[0], db[0])
    seen = {start}
    queue = deque([start])
    while queue:
        x, y = queue.popleft()
        if (x in da[2]) != (y in db[2]):
            return False
        for ch in ctx.alphabet:
            nxt = (da[1][x][ch], db[1][y][ch])
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return True
