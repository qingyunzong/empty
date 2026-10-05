"""正则表达式 AST：哈希共享（hash-consing）节点、保语言规范化、Brzozowski 导数。

所有节点不可变且在 Context 内唯一（同一结构同一对象），因此：
  - 结构等价 <=> 对象同一，导数等价式不会无限膨胀；
  - nullable / derivative / canonical-str 均可按节点 id 安全记忆化。

规范化规则（每条都可证明保持语言不变，字母表为 Σ）：
  union:   结合/交换/幂等（扁平化+排序+去重）；R|∅ = R；R|~R = Σ*
  inter:   结合/交换/幂等；R&∅ = ∅；R&Σ* = R；R&~R = ∅
  concat:  结合；R·∅ = ∅·R = ∅；R·ε = ε·R = R
  star:    ε* = ∅* = ε；(R*)* = R*
  compl:   ~~R = R
"""
from __future__ import annotations

EMPTY = "empty"    # ∅ 空集
EPS = "eps"        # ε 空串
CHAR = "char"      # 字符集合（字母表的子集）
CONCAT = "concat"
UNION = "union"
INTER = "inter"
COMPL = "compl"
STAR = "star"

_PREC = {UNION: 1, INTER: 2, CONCAT: 3, STAR: 4, COMPL: 4}


class Node:
    """不可变、被 Context 内部唯一化的 AST 节点。"""

    __slots__ = ("tag", "args", "nid", "_hash")

    def __init__(self, tag, args, nid):
        object.__setattr__(self, "tag", tag)
        object.__setattr__(self, "args", args)
        object.__setattr__(self, "nid", nid)
        object.__setattr__(self, "_hash", hash((tag, args)))

    def __setattr__(self, *_):
        raise AttributeError("Node is immutable")

    def __eq__(self, other):
        return self is other

    def __ne__(self, other):
        return self is not other

    def __hash__(self):
        return self._hash

    def __repr__(self):
        return f"Node({self.tag},{self.args!r})"


def _escape(ch):
    return ch if ch.isalnum() else "\\" + ch


class Context:
    """绑定有限字母表的表达式上下文：节点唯一化 + 导数/可空性缓存。"""

    def __init__(self, alphabet):
        if isinstance(alphabet, str):
            alphabet = tuple(alphabet)
        alphabet = tuple(sorted(set(alphabet)))
        if not alphabet:
            raise ValueError("alphabet must be non-empty")
        for ch in alphabet:
            if not (isinstance(ch, str) and len(ch) == 1):
                raise ValueError(f"alphabet symbols must be single chars: {ch!r}")
        self.alphabet = alphabet
        self.alphabet_set = frozenset(alphabet)
        self.alphabet_str = "".join(alphabet)
        self._intern = {}
        self._nullable = {}
        self._deriv = {}
        self._str = {}
        self.empty = self._mk(EMPTY, ())
        self.eps = self._mk(EPS, ())
        self.full_char = self.char(self.alphabet_set)
        # Σ* ：相对当前字母表的全语言
        self.sigma_star = self.star(self.full_char)

    # ---- 内部：哈希共享 ----
    def _mk(self, tag, args):
        key = (tag, args)
        node = self._intern.get(key)
        if node is None:
            node = Node(tag, args, len(self._intern))
            self._intern[key] = node
        return node

    # ---- 智能构造器（规范化） ----
    def char(self, chars):
        s = frozenset(chars)
        unknown = s - self.alphabet_set
        if unknown:
            raise ValueError(f"chars outside alphabet: {sorted(unknown)!r}")
        if not s:
            return self.empty
        return self._mk(CHAR, (s,))

    def union(self, *rs):
        flat = []
        for r in rs:
            if r.tag == UNION:
                flat.extend(r.args)
            elif r.tag == EMPTY:
                continue
            else:
                flat.append(r)
        if not flat:
            return self.empty
        if all(r.tag == CHAR for r in flat):
            return self.char(frozenset().union(*(r.args[0] for r in flat)))
        seen = set(flat)
        for r in flat:
            if r.tag == COMPL and r.args[0] in seen:
                return self.sigma_star
            if self._mk(COMPL, (r,)) in seen:
                return self.sigma_star
        uniq = sorted(seen, key=lambda n: n.nid)
        if len(uniq) == 1:
            return uniq[0]
        return self._mk(UNION, tuple(uniq))

    def inter(self, *rs):
        flat = []
        for r in rs:
            if r.tag == EMPTY:
                return self.empty
            if r.tag == INTER:
                flat.extend(r.args)
            elif r.tag == COMPL and r.args[0].tag == EMPTY:
                continue  # Σ* 是交的单位元
            else:
                flat.append(r)
        if not flat:
            return self.sigma_star
        if all(r.tag == CHAR for r in flat):
            return self.char(frozenset.intersection(
                *(r.args[0] for r in flat)))
        seen = set(flat)
        for r in flat:
            if r.tag == COMPL and r.args[0] in seen:
                return self.empty
            if self._mk(COMPL, (r,)) in seen:
                return self.empty
        uniq = sorted(seen, key=lambda n: n.nid)
        if len(uniq) == 1:
            return uniq[0]
        return self._mk(INTER, tuple(uniq))

    def concat(self, *rs):
        flat = []
        for r in rs:
            if r.tag == EMPTY:
                return self.empty
            if r.tag == EPS:
                continue
            if r.tag == CONCAT:
                flat.extend(r.args)
            else:
                flat.append(r)
        if not flat:
            return self.eps
        if len(flat) == 1:
            return flat[0]
        return self._mk(CONCAT, tuple(flat))

    def star(self, r):
        if r.tag in (EPS, EMPTY):
            return self.eps
        if r.tag == STAR:
            return r
        return self._mk(STAR, (r,))

    def compl(self, r):
        # 注意：~[a] 不是字符集 [^a]——{a} 的补还包含 ε 与更长的串，
        # 因此字符节点的补不能规范化（字符集的并/交则可以合并）。
        if r.tag == COMPL:
            return r.args[0]
        return self._mk(COMPL, (r,))

    # ---- 可空性（ε 是否在语言中） ----
    def nullable(self, r):
        v = self._nullable.get(r.nid)
        if v is None:
            t = r.tag
            if t == EMPTY:
                v = False
            elif t == EPS:
                v = True
            elif t == CHAR:
                v = False
            elif t == STAR:
                v = True
            elif t == COMPL:
                v = not self.nullable(r.args[0])
            elif t == UNION:
                v = any(self.nullable(a) for a in r.args)
            elif t == INTER:
                v = all(self.nullable(a) for a in r.args)
            elif t == CONCAT:
                v = all(self.nullable(a) for a in r.args)
            else:  # pragma: no cover
                raise AssertionError(t)
            self._nullable[r.nid] = v
        return v

    # ---- Brzozowski 导数 ----
    def derive(self, r, c):
        if c not in self.alphabet_set:
            raise ValueError(f"symbol {c!r} not in alphabet")
        key = (r.nid, c)
        v = self._deriv.get(key)
        if v is None:
            v = self._derive(r, c)
            self._deriv[key] = v
        return v

    def _derive(self, r, c):
        t = r.tag
        if t in (EMPTY, EPS):
            return self.empty
        if t == CHAR:
            return self.eps if c in r.args[0] else self.empty
        if t == UNION:
            return self.union(*(self.derive(a, c) for a in r.args))
        if t == INTER:
            return self.inter(*(self.derive(a, c) for a in r.args))
        if t == COMPL:
            return self.compl(self.derive(r.args[0], c))
        if t == STAR:
            return self.concat(self.derive(r.args[0], c), r)
        if t == CONCAT:
            args = r.args
            terms = []
            for i, a in enumerate(args):
                da = self.derive(a, c)
                if da.tag != EMPTY:
                    terms.append(self.concat(da, *args[i + 1:]))
                if not self.nullable(a):
                    break
            return self.union(*terms)
        raise AssertionError(t)  # pragma: no cover

    # ---- 匹配 ----
    def match(self, r, s):
        for ch in s:
            r = self.derive(r, ch)
        return self.nullable(r)

    # ---- 规范化文本（可被 parser 重新解析，用于证明/前沿序列化） ----
    def to_str(self, r):
        s = self._str.get(r.nid)
        if s is None:
            s = self._to_str(r, 0)
            self._str[r.nid] = s
        return s

    def _to_str(self, r, parent_prec):
        t = r.tag
        if t == EMPTY:
            return "#"
        if t == EPS:
            return "@"
        if t == CHAR:
            return self._char_str(r.args[0])
        if t == STAR:
            return self._to_str(r.args[0], _PREC[STAR]) + "*"
        if t == COMPL:
            return "~" + self._to_str(r.args[0], _PREC[COMPL])
        if t == CONCAT:
            s = "".join(self._to_str(a, _PREC[CONCAT]) for a in r.args)
        elif t == INTER:
            s = "&".join(self._to_str(a, _PREC[INTER]) for a in r.args)
        elif t == UNION:
            s = "|".join(self._to_str(a, _PREC[UNION]) for a in r.args)
        else:  # pragma: no cover
            raise AssertionError(t)
        if _PREC[t] < parent_prec:
            return "(" + s + ")"
        return s

    def _char_str(self, s):
        if s == self.alphabet_set:
            return "."
        if len(s) == 1:
            return _escape(next(iter(s)))
        chars = sorted(s)
        parts = []
        i = 0
        while i < len(chars):
            j = i
            while j + 1 < len(chars) and ord(chars[j + 1]) == ord(chars[j]) + 1:
                j += 1
            if j > i + 1:
                parts.append(_escape(chars[i]) + "-" + _escape(chars[j]))
            else:
                parts.extend(_escape(chars[k]) for k in range(i, j + 1))
            i = j + 1
        return "[" + "".join(parts) + "]"

    # ---- 子节点遍历（缓存依赖分析用） ----
    def subnode_ids(self, r):
        seen = set()
        stack = [r]
        while stack:
            n = stack.pop()
            if n.nid in seen:
                continue
            seen.add(n.nid)
            if n.tag != CHAR:
                stack.extend(n.args)
        return seen
