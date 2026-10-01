"""Independent cross-checking engine.

Builds an NFA by the classical Thompson construction directly from the
*raw* (unnormalized) parser tree, determinizes it by subset construction,
and implements intersection/complement as DFA set operations.  It shares
no code with the derivative engine, so exhaustive comparison of the two
(on small alphabets and short strings) validates both the normalization
rules and the derivative machinery.
"""
from __future__ import annotations

import itertools


class NFA:
    def __init__(self):
        self.n = 0
        self.edges = {}  # src -> list of (lo, hi, dst); lo is None => epsilon

    def new(self):
        self.n += 1
        return self.n - 1

    def add(self, src, lo, hi, dst):
        self.edges.setdefault(src, []).append((lo, hi, dst))


class Dfa:
    __slots__ = ("n", "start", "acc", "trans")

    def __init__(self, n, start, acc, trans):
        self.n = n
        self.start = start
        self.acc = acc
        self.trans = trans  # list of dict: code point -> target


def _embed_dfa(d, nfa):
    """Embed a DFA into an NFA under construction; returns (start, accept)."""
    mapping = {i: nfa.new() for i in range(d.n)}
    for i, row in enumerate(d.trans):
        for cp, tgt in row.items():
            nfa.add(mapping[i], cp, cp, mapping[tgt])
    accept = nfa.new()
    for i in d.acc:
        nfa.add(mapping[i], None, None, accept)
    return mapping[d.start], accept


def _build(raw, nfa, alphabet):
    """Thompson construction; returns (start, accept) NFA states."""
    tag = raw[0]
    if tag == "empty":
        return nfa.new(), nfa.new()
    if tag == "eps":
        s, a = nfa.new(), nfa.new()
        nfa.add(s, None, None, a)
        return s, a
    if tag == "char":
        s, a = nfa.new(), nfa.new()
        nfa.add(s, raw[1], raw[2], a)
        return s, a
    if tag == "concat":
        s, a = _build(raw[1], nfa, alphabet)
        for part in raw[2:]:
            s2, a2 = _build(part, nfa, alphabet)
            nfa.add(a, None, None, s2)
            a = a2
        return s, a
    if tag == "union":
        s, a = nfa.new(), nfa.new()
        for part in raw[1:]:
            s2, a2 = _build(part, nfa, alphabet)
            nfa.add(s, None, None, s2)
            nfa.add(a2, None, None, a)
        return s, a
    if tag == "star":
        s, a = nfa.new(), nfa.new()
        s2, a2 = _build(raw[1], nfa, alphabet)
        nfa.add(s, None, None, s2)
        nfa.add(s, None, None, a)
        nfa.add(a2, None, None, s2)
        nfa.add(a2, None, None, a)
        return s, a
    if tag in ("inter", "compl"):
        return _embed_dfa(raw_to_dfa(raw, alphabet), nfa)
    raise ValueError(f"unknown raw node: {tag!r}")


def nfa_to_dfa(nfa, start, accept, alphabet):
    def closure(states):
        out = set(states)
        stack = list(out)
        while stack:
            s = stack.pop()
            for lo, hi, d in nfa.edges.get(s, ()):
                if lo is None and d not in out:
                    out.add(d)
                    stack.append(d)
        return out

    cps = list(alphabet.chars())
    start_set = frozenset(closure({start}))
    index = {start_set: 0}
    sets = [start_set]
    rows = {}
    queue = [start_set]
    while queue:
        cur = queue.pop()
        row = {}
        for cp in cps:
            nxt = frozenset(
                closure({d for s in cur for lo, hi, d in nfa.edges.get(s, ())
                         if lo is not None and lo <= cp <= hi}))
            if nxt not in index:
                index[nxt] = len(sets)
                sets.append(nxt)
                queue.append(nxt)
            row[cp] = index[nxt]
        rows[index[cur]] = row
    trans = [rows[i] for i in range(len(sets))]
    acc = {i for i, s in enumerate(sets) if accept in s}
    return Dfa(len(sets), 0, acc, trans)


def _complete(d, alphabet):
    cps = list(alphabet.chars())
    sink = d.n
    trans = [dict(row) for row in d.trans] + [{}]
    for i in range(d.n + 1):
        for cp in cps:
            trans[i].setdefault(cp, sink)
    return Dfa(d.n + 1, d.start, set(d.acc), trans)


def dfa_complement(d, alphabet):
    d = _complete(d, alphabet)
    return Dfa(d.n, d.start, set(range(d.n)) - d.acc, d.trans)


def dfa_product(d1, d2, alphabet, how):
    d1, d2 = _complete(d1, alphabet), _complete(d2, alphabet)
    index = {(d1.start, d2.start): 0}
    pairs = [(d1.start, d2.start)]
    rows = {}
    queue = [(d1.start, d2.start)]
    cps = list(alphabet.chars())
    while queue:
        p, q = queue.pop()
        row = {}
        for cp in cps:
            nxt = (d1.trans[p][cp], d2.trans[q][cp])
            if nxt not in index:
                index[nxt] = len(pairs)
                pairs.append(nxt)
                queue.append(nxt)
            row[cp] = index[nxt]
        rows[index[(p, q)]] = row
    trans = [rows[i] for i in range(len(pairs))]
    if how == "and":
        acc = {i for i, (p, q) in enumerate(pairs)
               if p in d1.acc and q in d2.acc}
    else:
        acc = {i for i, (p, q) in enumerate(pairs)
               if p in d1.acc or q in d2.acc}
    return Dfa(len(pairs), 0, acc, trans)


def raw_to_dfa(raw, alphabet):
    tag = raw[0]
    if tag == "inter":
        d = raw_to_dfa(raw[1], alphabet)
        for part in raw[2:]:
            d = dfa_product(d, raw_to_dfa(part, alphabet), alphabet, "and")
        return d
    if tag == "compl":
        return dfa_complement(raw_to_dfa(raw[1], alphabet), alphabet)
    nfa = NFA()
    s, a = _build(raw, nfa, alphabet)
    return nfa_to_dfa(nfa, s, a, alphabet)


def dfa_match(d, s):
    cur = d.start
    for ch in s:
        nxt = d.trans[cur].get(ord(ch))
        if nxt is None:
            return False
        cur = nxt
    return cur in d.acc


def raw_match(raw, s, alphabet):
    return dfa_match(raw_to_dfa(raw, alphabet), s)


def strings_upto(alphabet, max_len):
    """All alphabet strings of length <= max_len, in (length, lex) order."""
    cps = sorted(alphabet.chars())
    for length in range(max_len + 1):
        for tup in itertools.product(cps, repeat=length):
            yield "".join(map(chr, tup))


def brute_force_difference(raw_a, raw_b, alphabet, max_len):
    """Shortest, then lexicographically smallest, string on which the two
    raw expressions disagree (None if they agree up to max_len)."""
    da = raw_to_dfa(raw_a, alphabet)
    db = raw_to_dfa(raw_b, alphabet)
    for s in strings_upto(alphabet, max_len):
        if dfa_match(da, s) != dfa_match(db, s):
            return s
    return None
