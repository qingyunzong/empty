"""Ambiguity analyser.

Strategy
--------
1. Build the branch-labelled NFA of the AST (see automaton.py).  Every
   accepting path corresponds to exactly one parse tree and vice versa.
2. Pumpable epsilon loops: a word has infinitely many parses iff some parse
   contains a star whose body derives the empty string.  We compute the
   shortest (then lexicographically smallest) such word directly and keep it
   as an incumbent witness with pumpable evidence (0 vs 1 body iterations).
3. Synchronized product search: Dijkstra/BFS over pairs of NFA paths that
   consume the same word, ordered by (length, word).  Character moves are
   lockstep; epsilon moves are taken by either side.  Divergence is tracked
   exactly on the parse-action sequences (equal / one-a-prefix / diverged),
   so identical parses reached through different automaton activity are
   normalised and never reported as ambiguous.  Zero-length loops are
   pruned per side (a side may not revisit an NFA state without consuming
   input); any witness lost to this pruning has infinitely many parses and
   is covered by the incumbent from step 2.
4. Budgets: when the step budget or the word-length budget is exhausted the
   result is "unknown" together with a serialisable resume state.
"""
from __future__ import annotations

import heapq
import itertools
from typing import Dict, List, Optional, Tuple

from .astnodes import (Node, Lit, Eps, Union, Cat, Star, validate,
                       compute_nullable, compute_minword, contains_id)
from .automaton import build_nfa
from .parses import Parse, to_json as parse_to_json
from .verifier import verify_parse

_DIV = ("div",)


# ---------------------------------------------------------------------------
# divergence tracking on parse-action sequences
# ---------------------------------------------------------------------------

def _advance(canon, side: int, acts):
    """Update the relation between the two action sequences after `side`
    appends `acts`.  canon is None (equal), ("div",) or ("pre", side, excess).
    """
    if not acts or canon == _DIV:
        return canon
    if canon is None:
        return ("pre", side, tuple(acts))
    _, ahead, excess = canon
    if ahead == side:
        return ("pre", side, tuple(excess) + tuple(acts))
    acts = tuple(acts)
    excess = tuple(excess)
    if acts == excess[:len(acts)]:
        rest = excess[len(acts):]
        return None if not rest else ("pre", ahead, rest)
    if excess == acts[:len(excess)]:
        return ("pre", side, acts[len(excess):])
    return _DIV


def parse_from_actions(actions) -> Parse:
    """Rebuild the parse tree from a path's action sequence."""
    stack: List[list] = []
    roots: List[Parse] = []
    cursor = 0
    for a in actions:
        kind = a[0]
        if kind == "enter":
            stack.append([a[1], cursor, []])
        elif kind == "lit":
            cursor += 1
        elif kind in ("eps", "choice", "iter"):
            pass
        elif kind == "exit":
            if not stack:
                raise ValueError("unbalanced action sequence: extra exit")
            nid, start, children = stack.pop()
            if nid != a[1]:
                raise ValueError("unbalanced action sequence: mismatched exit")
            node = Parse(nid, start, cursor, tuple(children))
            if stack:
                stack[-1][2].append(node)
            else:
                roots.append(node)
        else:
            raise ValueError(f"unknown action {a!r}")
    if stack or len(roots) != 1:
        raise ValueError("action sequence is not a complete path")
    return roots[0]


# ---------------------------------------------------------------------------
# pumpable epsilon-loop witness (nullable star body)
# ---------------------------------------------------------------------------

def _minparse(node: Node, pos: int, minword: Dict[int, str]) -> Parse:
    """Parse of minword(node) starting at pos."""
    nid = node.id
    if isinstance(node, Lit):
        return Parse(nid, pos, pos + 1, ())
    if isinstance(node, Eps):
        return Parse(nid, pos, pos, ())
    if isinstance(node, Union):
        for c in node.children:
            if minword[c.id] == minword[nid]:
                inner = _minparse(c, pos, minword)
                return Parse(nid, pos, inner.end, (inner,))
        raise RuntimeError("internal error: no minword branch")
    if isinstance(node, Cat):
        parts = []
        cur = pos
        for c in node.children:
            p = _minparse(c, cur, minword)
            parts.append(p)
            cur = p.end
        return Parse(nid, pos, cur, tuple(parts))
    if isinstance(node, Star):
        return Parse(nid, pos, pos, ())
    raise TypeError(node)


def _eps_parse(node: Node, pos: int, nullable: Dict[int, bool]) -> Parse:
    """A parse of the empty word; requires a nullable node."""
    nid = node.id
    if isinstance(node, Eps):
        return Parse(nid, pos, pos, ())
    if isinstance(node, Union):
        for c in node.children:
            if nullable[c.id]:
                inner = _eps_parse(c, pos, nullable)
                return Parse(nid, pos, pos, (inner,))
        raise RuntimeError("internal error: no nullable branch")
    if isinstance(node, Cat):
        return Parse(nid, pos, pos,
                     tuple(_eps_parse(c, pos, nullable) for c in node.children))
    if isinstance(node, Star):
        return Parse(nid, pos, pos, ())
    raise RuntimeError("internal error: node is not nullable")


def _gparse(node: Node, sid: int, pos: int, variant: str,
            nullable: Dict[int, bool], minword: Dict[int, str]) -> Parse:
    """Parse of the minimal word whose parse tree contains star `sid`.

    At `sid` itself the variant selects 0 iterations ("zero") or 1 epsilon
    iteration of the body ("one"); this pair is the pumpable evidence.
    """
    nid = node.id
    if nid == sid:
        if variant == "zero":
            return Parse(sid, pos, pos, ())
        return Parse(sid, pos, pos, (_eps_parse(node.child, pos, nullable),))
    if isinstance(node, Union):
        for c in node.children:
            if contains_id(c, sid):
                inner = _gparse(c, sid, pos, variant, nullable, minword)
                return Parse(nid, pos, inner.end, (inner,))
        raise RuntimeError("internal error: star not in union")
    if isinstance(node, Cat):
        parts = []
        cur = pos
        for c in node.children:
            if contains_id(c, sid):
                p = _gparse(c, sid, cur, variant, nullable, minword)
            else:
                p = _minparse(c, cur, minword)
            parts.append(p)
            cur = p.end
        return Parse(nid, pos, cur, tuple(parts))
    if isinstance(node, Star):
        inner = _gparse(node.child, sid, pos, variant, nullable, minword)
        return Parse(nid, pos, inner.end, (inner,))
    raise RuntimeError("internal error: star not below this node")


def _pump_witness(root: Node, nullable: Dict[int, bool],
                  minword: Dict[int, str]) -> Optional[dict]:
    """Shortest, then lexicographically smallest word that has a parse
    containing a star whose body derives the empty string (an infinitely
    ambiguous, pumpable word), or None."""
    best_memo: Dict[int, Optional[Tuple[str, int]]] = {}

    def best(node: Node) -> Optional[Tuple[str, int]]:
        if node.id in best_memo:
            return best_memo[node.id]
        res = None
        if isinstance(node, Star):
            cands: List[Tuple[str, int]] = []
            if nullable[node.child.id]:
                cands.append(("", node.id))
            b = best(node.child)
            if b is not None:
                cands.append(b)
            if cands:
                res = min(cands, key=lambda ws: (len(ws[0]), ws[0], ws[1]))
        elif isinstance(node, Union):
            cands = [b for b in (best(c) for c in node.children) if b is not None]
            if cands:
                res = min(cands, key=lambda ws: (len(ws[0]), ws[0], ws[1]))
        elif isinstance(node, Cat):
            cands = []
            for i, child in enumerate(node.children):
                b = best(child)
                if b is None:
                    continue
                word = "".join(minword[c.id] for c in node.children[:i])
                word += b[0]
                word += "".join(minword[c.id] for c in node.children[i + 1:])
                cands.append((word, b[1]))
            if cands:
                res = min(cands, key=lambda ws: (len(ws[0]), ws[0], ws[1]))
        best_memo[node.id] = res
        return res

    found = best(root)
    if found is None:
        return None
    word, sid = found
    return {"word": word, "star_id": sid,
            "parse_zero": _gparse(root, sid, 0, "zero", nullable, minword),
            "parse_one": _gparse(root, sid, 0, "one", nullable, minword)}


# ---------------------------------------------------------------------------
# resume-state (de)serialisation
# ---------------------------------------------------------------------------

def _canon_to_json(canon):
    if canon is None:
        return None
    if canon == _DIV:
        return ["div"]
    return ["pre", canon[1], [list(a) for a in canon[2]]]


def _canon_from_json(data):
    if data is None:
        return None
    if data == ["div"]:
        return _DIV
    return ("pre", data[1], tuple(tuple(a) for a in data[2]))


def _actions_to_json(acts):
    return [list(a) for a in acts]


def _actions_from_json(data):
    return tuple(tuple(a) for a in data)


# ---------------------------------------------------------------------------
# main entry point
# ---------------------------------------------------------------------------

def analyze(root: Node, max_steps: int = 100000,
            max_word_len: Optional[int] = None,
            resume: Optional[dict] = None) -> dict:
    """Analyse `root` for ambiguity.

    Returns a JSON-able dict with status "ambiguous", "unambiguous" or
    "unknown".  `max_steps` bounds product-state expansions per call;
    `max_word_len` bounds the witness length explored; `resume` accepts the
    "resume" object of a previous "unknown" result to continue the search.
    """
    validate(root)
    nullable = compute_nullable(root)
    minword = compute_minword(root)
    nfa = build_nfa(root)
    pump = _pump_witness(root, nullable, minword)
    if pump is not None:
        for t in (pump["parse_zero"], pump["parse_one"]):
            ok, err = verify_parse(root, pump["word"], t)
            if not ok:
                raise RuntimeError(f"internal error: pump evidence rejected: {err}")
    incumbent_word = pump["word"] if pump else None

    heap: list = []
    visited = set()
    paused: list = []
    counter = itertools.count()
    steps = 0

    def push(word, p, q, canon, seq1, seq2, seg1, seg2):
        heapq.heappush(heap, ((len(word), word, next(counter)),
                              (p, q, canon, seq1, seq2, seg1, seg2)))

    if resume:
        for e in resume.get("heap", []):
            push(e["word"], e["p"], e["q"], _canon_from_json(e["canon"]),
                 _actions_from_json(e["seq1"]), _actions_from_json(e["seq2"]),
                 frozenset(e["seg1"]), frozenset(e["seg2"]))
        for e in resume.get("paused", []):
            push(e["word"], e["p"], e["q"], _canon_from_json(e["canon"]),
                 _actions_from_json(e["seq1"]), _actions_from_json(e["seq2"]),
                 frozenset(e["seg1"]), frozenset(e["seg2"]))
        for k in resume.get("visited", []):
            visited.add((k["p"], k["q"], _canon_from_json(k["canon"]),
                         frozenset(k["seg1"]), frozenset(k["seg2"])))
    else:
        push("", nfa.start, nfa.start, None, (), (),
             frozenset({nfa.start}), frozenset({nfa.start}))

    def stats() -> dict:
        return {"product_states_explored": len(visited),
                "frontier": len(heap), "paused": len(paused),
                "nfa_states": nfa.n_states, "steps": steps}

    def finish_pump() -> dict:
        return {"status": "ambiguous", "word": pump["word"], "infinite": True,
                "pump": {"star_id": pump["star_id"],
                         "note": "star body derives the empty string; the "
                                 "epsilon iteration can be pumped arbitrarily",
                         "iterations_witnessed": [0, 1]},
                "parses": [parse_to_json(pump["parse_zero"]),
                           parse_to_json(pump["parse_one"])],
                "stats": stats()}

    def entry_to_json(word, payload) -> dict:
        p, q, canon, seq1, seq2, seg1, seg2 = payload
        return {"word": word, "p": p, "q": q, "canon": _canon_to_json(canon),
                "seq1": _actions_to_json(seq1), "seq2": _actions_to_json(seq2),
                "seg1": sorted(seg1), "seg2": sorted(seg2)}

    def make_unknown(reason: str) -> dict:
        resume_state = {
            "heap": [entry_to_json(key[1], pl) for key, pl in heap],
            "paused": [entry_to_json(w, pl) for w, pl in paused],
            "visited": [{"p": k[0], "q": k[1], "canon": _canon_to_json(k[2]),
                         "seg1": sorted(k[3]), "seg2": sorted(k[4])}
                        for k in visited],
        }
        out = {"status": "unknown", "reason": reason,
               "resume": resume_state, "stats": stats()}
        if pump is not None:
            out["incumbent"] = {"word": incumbent_word, "infinite": True,
                                "pump": {"star_id": pump["star_id"]}}
        return out

    while heap:
        if steps >= max_steps:
            return make_unknown("step_budget_exhausted")
        (wlen, word, _), payload = heapq.heappop(heap)
        p, q, canon, seq1, seq2, seg1, seg2 = payload
        key = (p, q, canon, seg1, seg2)
        if key in visited:
            continue
        if incumbent_word is not None and (wlen, word) >= (len(incumbent_word), incumbent_word):
            return finish_pump()
        if p == nfa.final and q == nfa.final and canon is not None:
            t1 = parse_from_actions(seq1)
            t2 = parse_from_actions(seq2)
            if t1 == t2:
                raise RuntimeError("internal error: divergent paths gave equal parses")
            for t in (t1, t2):
                ok, err = verify_parse(root, word, t)
                if not ok:
                    raise RuntimeError(f"internal error: evidence rejected: {err}")
            return {"status": "ambiguous", "word": word, "infinite": False,
                    "pump": None,
                    "parses": [parse_to_json(t1), parse_to_json(t2)],
                    "stats": stats()}
        char_pairs = []
        for (c, acts1, d1) in nfa.char_trans.get(p, ()):
            for (c2, acts2, d2) in nfa.char_trans.get(q, ()):
                if c == c2:
                    char_pairs.append((c, acts1, d1, acts2, d2))
        if char_pairs and max_word_len is not None and wlen >= max_word_len:
            paused.append((word, payload))
            continue
        visited.add(key)
        steps += 1
        for (c, acts1, d1, acts2, d2) in char_pairs:
            push(word + c, d1, d2,
                 _advance(_advance(canon, 1, acts1), 2, acts2),
                 seq1 + acts1, seq2 + acts2,
                 frozenset({d1}), frozenset({d2}))
        for (acts, d) in nfa.eps_trans.get(p, ()):
            if d not in seg1:
                push(word, d, q, _advance(canon, 1, acts), seq1 + acts, seq2,
                     seg1 | {d}, seg2)
        for (acts, d) in nfa.eps_trans.get(q, ()):
            if d not in seg2:
                push(word, p, d, _advance(canon, 2, acts), seq1, seq2 + acts,
                     seg1, seg2 | {d})

    if paused:
        return make_unknown("word_length_budget_exhausted")
    if pump is not None:
        return finish_pump()
    return {"status": "unambiguous",
            "certificate": {
                "method": "exhaustive synchronised product of the "
                          "branch-labelled automaton",
                "product_states_explored": len(visited),
                "nfa_states": nfa.n_states,
                "pumpable_epsilon_loop": False},
            "stats": stats()}
