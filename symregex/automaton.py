"""符号自动机：以规范化正则表达式为状态的 DFA，迁移按符号区间划分，可最小化。"""
from __future__ import annotations

from collections import deque


class DFA:
    """状态为正则 AST 节点的符号 DFA。

    transitions[i]: {char: target_state_index}（按字符展开存储，
    intervals() 把相邻且目标相同的字符合并为区间）。
    """

    def __init__(self, ctx):
        self.ctx = ctx
        self.states = []        # state index -> Node
        self.index = {}         # Node.nid -> state index
        self.start = 0
        self.transitions = []   # state index -> {char: target index}
        self.accepting = []     # state index -> bool

    def add_state(self, node):
        idx = self.index.get(node.nid)
        if idx is None:
            idx = len(self.states)
            self.index[node.nid] = idx
            self.states.append(node)
            self.transitions.append({})
            self.accepting.append(self.ctx.nullable(node))
        return idx

    def intervals(self, state):
        """返回 [(lo, hi, target)]：按字母表顺序合并相邻同目标字符。"""
        trans = self.transitions[state]
        out = []
        for ch in self.ctx.alphabet:
            tgt = trans[ch]
            if out and out[-1][2] == tgt and ord(ch) == ord(out[-1][1]) + 1:
                out[-1] = (out[-1][0], ch, tgt)
            else:
                out.append((ch, ch, tgt))
        return out

    def match(self, s):
        state = self.start
        for ch in s:
            nxt = self.transitions[state].get(ch)
            if nxt is None:
                return False
            state = nxt
        return self.accepting[state]

    def to_json(self):
        ctx = self.ctx
        return {
            "alphabet": ctx.alphabet_str,
            "states": [ctx.to_str(n) for n in self.states],
            "start": self.start,
            "accepting": [i for i, a in enumerate(self.accepting) if a],
            "transitions": [
                {"from": i, "interval": lo if lo == hi else f"{lo}-{hi}", "to": t}
                for i in range(len(self.states))
                for (lo, hi, t) in self.intervals(i)
            ],
        }


def build_dfa(ctx, root, budget=None):
    """从 root 出发按导数构造 DFA。

    返回 (dfa, frontier, truncated)。budget 限制已探索（展开迁移）的状态数；
    耗尽时 truncated=True，frontier 为未探索节点列表（不视为拒绝）。
    """
    dfa = DFA(ctx)
    dfa.add_state(root)
    queue = deque([root])
    enqueued = {root.nid}
    explored = 0
    while queue:
        if budget is not None and explored >= budget:
            return dfa, list(queue), True
        node = queue.popleft()
        src = dfa.index[node.nid]
        explored += 1
        for ch in ctx.alphabet:
            tgt_node = ctx.derive(node, ch)
            tgt = dfa.add_state(tgt_node)
            dfa.transitions[src][ch] = tgt
            if tgt_node.nid not in enqueued:
                enqueued.add(tgt_node.nid)
                queue.append(tgt_node)
    return dfa, [], False


def minimize(dfa):
    """划分细化最小化。返回新的最小 DFA（状态取各划分块的代表节点）。"""
    ctx = dfa.ctx
    n = len(dfa.states)
    alphabet = ctx.alphabet
    block = [1 if dfa.accepting[i] else 0 for i in range(n)]
    while True:
        sig_to_block = {}
        new_block = [0] * n
        for i in range(n):
            sig = (block[i],) + tuple(block[dfa.transitions[i][c]] for c in alphabet)
            b = sig_to_block.get(sig)
            if b is None:
                b = len(sig_to_block)
                sig_to_block[sig] = b
            new_block[i] = b
        if len(set(new_block)) == len(set(block)):
            break
        block = new_block
    # 重新编号：start 所在块为 0，其余按首次出现顺序
    order = []
    for i in [dfa.start] + list(range(n)):
        if block[i] not in order:
            order.append(block[i])
    remap = {b: i for i, b in enumerate(order)}
    reps = {}
    for i in range(n):
        reps.setdefault(remap[block[i]], i)
    m = len(order)
    mini = DFA(ctx)
    mini.states = [dfa.states[reps[i]] for i in range(m)]
    mini.index = {mini.states[i].nid: i for i in range(m)}
    mini.start = 0
    mini.transitions = [
        {c: remap[block[dfa.transitions[reps[i]][c]]] for c in alphabet}
        for i in range(m)
    ]
    mini.accepting = [dfa.accepting[reps[i]] for i in range(m)]
    return mini
