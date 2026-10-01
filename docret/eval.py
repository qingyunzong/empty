"""Query compilation into a positional dataflow and its execution.

Two disjoint result types are used and never silently mixed:

- ``PosResult``: doc id -> list of positional ``Evidence`` (spans).
- ``DocSetResult``: a plain boolean set of doc ids.

``AND``/``OR`` of two positional operands stay positional; as soon as one
operand is boolean the result is a boolean ``DocSetResult`` and the
positional side is *explicitly* degraded via ``docs_of``.  ``NOT`` always
yields a boolean result (complement over the document universe).  Phrases
and ``NEAR`` require positional operands; feeding them a boolean expression
is a static ``QueryError``.
"""
from __future__ import annotations

from dataclasses import dataclass

from .model import spec_matches
from .query import And, Field, Near, Not, Or, Phrase, QueryError, Term

POS = "pos"
BOOL = "bool"


@dataclass(frozen=True)
class Evidence:
    """One located hit inside a document, traceable to the original text."""
    field_path: str
    instance: int
    paragraph: int
    tok_start: int
    tok_end: int      # exclusive
    char_start: int
    char_end: int     # exclusive
    text: str         # original text of the span

    def to_dict(self) -> dict:
        return {
            "field": self.field_path,
            "instance": self.instance,
            "paragraph": self.paragraph,
            "tokens": [self.tok_start, self.tok_end],
            "span": [self.char_start, self.char_end],
            "text": self.text,
        }


class PosResult:
    """Positional result: doc id -> list of evidence. Never a plain set."""

    kind = POS

    def __init__(self, matches: dict | None = None):
        self.matches: dict[str, list[Evidence]] = matches or {}

    @property
    def docs(self) -> set:
        return set(self.matches)


class DocSetResult:
    """Boolean result: a bare set of doc ids, no positions attached."""

    kind = BOOL

    def __init__(self, docs):
        self.docs = frozenset(docs)


def docs_of(result) -> set:
    """Explicitly degrade any result to a boolean doc set."""
    if isinstance(result, DocSetResult):
        return set(result.docs)
    if isinstance(result, PosResult):
        return set(result.matches)
    raise TypeError(f"unknown result type: {type(result)!r}")


# ---------------------------------------------------------------- operators

class Op:
    kind = None

    def evaluate(self):
        raise NotImplementedError


class TermOp(Op):
    kind = POS

    def __init__(self, state, term: str):
        self.state = state
        self.term = term

    def evaluate(self) -> PosResult:
        matches: dict[str, list[Evidence]] = {}
        for doc_id, postings in self.state.postings.get(self.term, {}).items():
            evs = []
            for p in postings:
                text = self.state.instance_text(doc_id, p.field_path, p.instance)
                evs.append(Evidence(
                    p.field_path, p.instance, p.para, p.pos, p.pos + 1,
                    p.start, p.end, text[p.start:p.end],
                ))
            if evs:
                matches[doc_id] = evs
        return PosResult(matches)


class PhraseOp(Op):
    """Phrase: terms must be consecutive within one field instance+paragraph."""

    kind = POS

    def __init__(self, state, terms: tuple[str, ...]):
        self.state = state
        self.terms = terms

    def evaluate(self) -> PosResult:
        per_term = [self.state.postings.get(t, {}) for t in self.terms]
        common = set(per_term[0])
        for post in per_term[1:]:
            common &= set(post)
        matches: dict[str, list[Evidence]] = {}
        for doc_id in common:
            # index postings of each following term by (field, instance, para, pos)
            followers = []
            for post in per_term[1:]:
                followers.append({
                    (p.field_path, p.instance, p.para, p.pos): p
                    for p in post[doc_id]
                })
            evs = []
            for p0 in per_term[0][doc_id]:
                chain = [p0]
                for i, table in enumerate(followers, start=1):
                    key = (p0.field_path, p0.instance, p0.para, p0.pos + i)
                    nxt = table.get(key)
                    if nxt is None:
                        break
                    chain.append(nxt)
                else:
                    text = self.state.instance_text(doc_id, p0.field_path, p0.instance)
                    start, end = chain[0].start, chain[-1].end
                    evs.append(Evidence(
                        p0.field_path, p0.instance, p0.para,
                        chain[0].pos, chain[-1].pos + 1,
                        start, end, text[start:end],
                    ))
            if evs:
                matches[doc_id] = evs
        return PosResult(matches)


class FieldOp(Op):
    """Restrict a positional child to instances whose path matches a spec."""

    kind = POS

    def __init__(self, spec: str, child: Op):
        self.spec = spec
        self.child = child

    def evaluate(self) -> PosResult:
        inner = self.child.evaluate()
        if not isinstance(inner, PosResult):  # defensive; compile() enforces
            raise QueryError("field restriction requires a positional operand")
        matches = {}
        for doc_id, evs in inner.matches.items():
            kept = [e for e in evs if spec_matches(self.spec, e.field_path)]
            if kept:
                matches[doc_id] = kept
        return PosResult(matches)


class NearOp(Op):
    """Proximity: spans of both sides within ``distance`` tokens, same
    field instance and paragraph."""

    kind = POS

    def __init__(self, state, left: Op, right: Op, distance: int):
        self.state = state
        self.left = left
        self.right = right
        self.distance = distance

    def evaluate(self) -> PosResult:
        left = self.left.evaluate()
        right = self.right.evaluate()
        matches: dict[str, list[Evidence]] = {}
        for doc_id in left.matches.keys() & right.matches.keys():
            evs = []
            for ea in left.matches[doc_id]:
                for eb in right.matches[doc_id]:
                    if (ea.field_path, ea.instance, ea.paragraph) != (
                            eb.field_path, eb.instance, eb.paragraph):
                        continue
                    if eb.tok_start >= ea.tok_end:
                        gap = eb.tok_start - ea.tok_end
                    elif ea.tok_start >= eb.tok_end:
                        gap = ea.tok_start - eb.tok_end
                    else:
                        gap = 0  # overlapping spans
                    if gap <= self.distance:
                        text = self.state.instance_text(doc_id, ea.field_path, ea.instance)
                        start = min(ea.char_start, eb.char_start)
                        end = max(ea.char_end, eb.char_end)
                        evs.append(Evidence(
                            ea.field_path, ea.instance, ea.paragraph,
                            min(ea.tok_start, eb.tok_start),
                            max(ea.tok_end, eb.tok_end),
                            start, end, text[start:end],
                        ))
            if evs:
                matches[doc_id] = evs
        return PosResult(matches)


class AndOp(Op):
    def __init__(self, left: Op, right: Op):
        self.left = left
        self.right = right
        self.kind = POS if left.kind == POS and right.kind == POS else BOOL

    def evaluate(self):
        left = self.left.evaluate()
        right = self.right.evaluate()
        if self.kind == POS:
            common = left.matches.keys() & right.matches.keys()
            return PosResult({
                d: left.matches[d] + right.matches[d] for d in common
            })
        return DocSetResult(docs_of(left) & docs_of(right))


class OrOp(Op):
    def __init__(self, left: Op, right: Op):
        self.left = left
        self.right = right
        self.kind = POS if left.kind == POS and right.kind == POS else BOOL

    def evaluate(self):
        left = self.left.evaluate()
        right = self.right.evaluate()
        if self.kind == POS:
            matches = {d: list(evs) for d, evs in left.matches.items()}
            for d, evs in right.matches.items():
                matches.setdefault(d, []).extend(evs)
            return PosResult(matches)
        return DocSetResult(docs_of(left) | docs_of(right))


class NotOp(Op):
    """Boolean complement over the full document universe."""

    kind = BOOL

    def __init__(self, state, child: Op):
        self.state = state
        self.child = child

    def evaluate(self) -> DocSetResult:
        return DocSetResult(set(self.state.docs) - docs_of(self.child.evaluate()))


# ---------------------------------------------------------------- compiler

def compile_query(node, state, resolve_spec) -> Op:
    """Compile an AST into an operator tree bound to an index state.

    ``resolve_spec`` maps a field name (possibly an alias) to a concrete
    field spec string.
    """
    if isinstance(node, Term):
        return TermOp(state, node.text)
    if isinstance(node, Phrase):
        return PhraseOp(state, node.terms)
    if isinstance(node, Field):
        child = compile_query(node.child, state, resolve_spec)
        if child.kind != POS:
            raise QueryError(
                f"field restriction {node.spec!r} requires a positional "
                "operand (phrases/terms), not a boolean expression"
            )
        return FieldOp(resolve_spec(node.spec), child)
    if isinstance(node, Near):
        left = compile_query(node.left, state, resolve_spec)
        right = compile_query(node.right, state, resolve_spec)
        if left.kind != POS or right.kind != POS:
            raise QueryError("NEAR requires positional operands on both sides")
        return NearOp(state, left, right, node.distance)
    if isinstance(node, And):
        return AndOp(compile_query(node.left, state, resolve_spec),
                     compile_query(node.right, state, resolve_spec))
    if isinstance(node, Or):
        return OrOp(compile_query(node.left, state, resolve_spec),
                    compile_query(node.right, state, resolve_spec))
    if isinstance(node, Not):
        return NotOp(state, compile_query(node.child, state, resolve_spec))
    raise QueryError(f"cannot compile node {node!r}")
