"""Independent per-document interpreter.

Evaluates a query AST directly against one document's flattened field
instances -- no inverted index involved.  Used to cross-check the
index-based dataflow results on small corpora.
"""
from __future__ import annotations

from .eval import Evidence
from .model import flatten, spec_matches, tokenize
from .query import And, Field, Near, Not, Or, Phrase, Term


class _DocView:
    def __init__(self, doc: dict):
        self.instances = flatten(doc)
        self._tokens = [tokenize(inst.text) for inst in self.instances]

    def matching(self, spec: str) -> list[int]:
        return [i for i, inst in enumerate(self.instances)
                if spec_matches(spec, inst.path)]


def _term_evidence(view: _DocView, term: str, idxs: list[int]) -> list[Evidence]:
    evs = []
    for i in idxs:
        inst = view.instances[i]
        for tok in view._tokens[i]:
            if tok.text == term:
                evs.append(Evidence(
                    inst.path, inst.ordinal, tok.para, tok.pos, tok.pos + 1,
                    tok.start, tok.end, inst.text[tok.start:tok.end],
                ))
    return evs


def _phrase_evidence(view: _DocView, terms: tuple, idxs: list[int]) -> list[Evidence]:
    evs = []
    n = len(terms)
    for i in idxs:
        inst = view.instances[i]
        tokens = view._tokens[i]
        for j in range(0, len(tokens) - n + 1):
            window = tokens[j:j + n]
            if [t.text for t in window] != list(terms):
                continue
            if any(window[k].pos != window[0].pos + k for k in range(n)):
                continue
            if any(t.para != window[0].para for t in window):
                continue
            start, end = window[0].start, window[-1].end
            evs.append(Evidence(
                inst.path, inst.ordinal, window[0].para,
                window[0].pos, window[-1].pos + 1,
                start, end, inst.text[start:end],
            ))
    return evs


def _near_evidence(view: _DocView, left: list[Evidence], right: list[Evidence],
                   distance: int) -> list[Evidence]:
    evs = []
    for ea in left:
        for eb in right:
            if (ea.field_path, ea.instance, ea.paragraph) != (
                    eb.field_path, eb.instance, eb.paragraph):
                continue
            if eb.tok_start >= ea.tok_end:
                gap = eb.tok_start - ea.tok_end
            elif ea.tok_start >= eb.tok_end:
                gap = ea.tok_start - eb.tok_end
            else:
                gap = 0
            if gap <= distance:
                inst = next(inst for inst in view.instances
                            if inst.path == ea.field_path
                            and inst.ordinal == ea.instance)
                start = min(ea.char_start, eb.char_start)
                end = max(ea.char_end, eb.char_end)
                evs.append(Evidence(
                    ea.field_path, ea.instance, ea.paragraph,
                    min(ea.tok_start, eb.tok_start),
                    max(ea.tok_end, eb.tok_end),
                    start, end, inst.text[start:end],
                ))
    return evs


def _eval(node, view: _DocView, idxs: list[int], resolve) -> tuple[bool, list[Evidence]]:
    """Return (matched, evidence). Boolean nodes return empty evidence."""
    if isinstance(node, Term):
        evs = _term_evidence(view, node.text, idxs)
        return bool(evs), evs
    if isinstance(node, Phrase):
        evs = _phrase_evidence(view, node.terms, idxs)
        return bool(evs), evs
    if isinstance(node, Field):
        narrowed = [i for i in idxs
                    if spec_matches(resolve(node.spec), view.instances[i].path)]
        return _eval(node.child, view, narrowed, resolve)
    if isinstance(node, Near):
        lok, levs = _eval(node.left, view, idxs, resolve)
        if not lok:
            return False, []
        rok, revs = _eval(node.right, view, idxs, resolve)
        if not rok:
            return False, []
        evs = _near_evidence(view, levs, revs, node.distance)
        return bool(evs), evs
    if isinstance(node, And):
        lok, levs = _eval(node.left, view, idxs, resolve)
        rok, revs = _eval(node.right, view, idxs, resolve)
        matched = lok and rok
        return matched, (levs + revs) if matched else []
    if isinstance(node, Or):
        lok, levs = _eval(node.left, view, idxs, resolve)
        rok, revs = _eval(node.right, view, idxs, resolve)
        return lok or rok, levs + revs
    if isinstance(node, Not):
        matched, _ = _eval(node.child, view, idxs, resolve)
        return (not matched), []
    raise TypeError(f"unknown node {node!r}")


def evaluate_document(node, doc: dict, resolve) -> tuple[bool, list[Evidence]]:
    """Evaluate a parsed query against a single document."""
    view = _DocView(doc)
    return _eval(node, view, list(range(len(view.instances))), resolve)
