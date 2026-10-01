"""Compile a query AST into a positional dataflow and evaluate it.

The two result kinds are deliberately distinct types and are never merged
into a single collection:

* :class:`PositionalResult` -- documents plus per-document *occurrences*
  (field, positions, paragraph, char span) that serve as locateable evidence.
* :class:`BooleanResult` -- a plain set of document ids with no positions.

Combination rules:

* term / phrase / NEAR            -> positional
* AND / OR of only positional ops -> positional (evidence is concatenated)
* AND / OR mixing in a boolean op -> boolean (positions are dropped, not mixed)
* NOT, ``*``, ``field:*``         -> boolean

``NOT`` is evaluated against the document universe of the queried view
(live index or snapshot): ``NOT q`` = universe - docs(q).
"""
from __future__ import annotations

from collections import namedtuple

from . import query as ast
from .errors import QueryError
from .fields import FieldMatcher

#: A single locateable hit inside one field instance of one document.
Occ = namedtuple("Occ", "field pos_start pos_end paragraph start end")


class BooleanResult:
    """A pure set of matching document ids (no positional information)."""

    kind = "bool"
    __slots__ = ("docs",)

    def __init__(self, docs):
        self.docs = set(docs)


class PositionalResult:
    """Matching document ids plus positional evidence per document."""

    kind = "pos"
    __slots__ = ("occ_map",)

    def __init__(self, occ_map):
        self.occ_map = occ_map  # doc_id -> [Occ, ...]

    @property
    def docs(self):
        return set(self.occ_map)


# ---------------------------------------------------------------------------
# Operators (the compiled dataflow nodes)
# ---------------------------------------------------------------------------

class Op:
    is_positional = False

    def evaluate(self, data, universe):
        raise NotImplementedError


class PositionalOp(Op):
    is_positional = True

    def candidate_docs(self, data, universe):
        """A superset of the matching docs, used to bound evaluation."""
        raise NotImplementedError

    def occurrences(self, data, doc_id):
        """All occurrences of this operator inside one document."""
        raise NotImplementedError

    def evaluate(self, data, universe):
        occ_map = {}
        for doc_id in self.candidate_docs(data, universe):
            occs = self.occurrences(data, doc_id)
            if occs:
                occ_map[doc_id] = occs
        return PositionalResult(occ_map)


class TermOp(PositionalOp):
    def __init__(self, term, matcher):
        self.term = term
        self.matcher = matcher

    def candidate_docs(self, data, universe):
        return set(data.inverted.get(self.term, {}))

    def occurrences(self, data, doc_id):
        return [
            Occ(p.field, p.pos, p.pos, p.paragraph, p.start, p.end)
            for p in data.inverted.get(self.term, {}).get(doc_id, [])
            if self.matcher.match(p.field)
        ]


class PhraseOp(PositionalOp):
    """Phrase constrained to a single field instance and paragraph."""

    def __init__(self, terms, matcher):
        self.terms = tuple(terms)
        self.matcher = matcher

    def candidate_docs(self, data, universe):
        return set(data.inverted.get(self.terms[0], {}))

    def occurrences(self, data, doc_id):
        occs = []
        first = data.inverted.get(self.terms[0], {}).get(doc_id, [])
        for p in first:
            if not self.matcher.match(p.field):
                continue
            last = None
            for offset, term in enumerate(self.terms[1:], 1):
                # Same field instance + consecutive positions: a phrase can
                # never be assembled from tokens of different fields.
                last = data.find(term, doc_id, p.field, p.pos + offset)
                if last is None:
                    break
            else:
                occs.append(Occ(p.field, p.pos, last.pos, p.paragraph, p.start, last.end))
        return occs


class NearOp(PositionalOp):
    """Unordered proximity within one field instance (paragraph-safe)."""

    def __init__(self, left, right, k):
        self.left = left
        self.right = right
        self.k = k

    def candidate_docs(self, data, universe):
        return self.left.candidate_docs(data, universe) & self.right.candidate_docs(data, universe)

    def occurrences(self, data, doc_id):
        lefts = self.left.occurrences(data, doc_id)
        rights = self.right.occurrences(data, doc_id)
        occs = []
        for l in lefts:
            for r in rights:
                if l.field != r.field:
                    continue
                if l.pos_end < r.pos_start:
                    gap = r.pos_start - l.pos_end
                elif r.pos_end < l.pos_start:
                    gap = l.pos_start - r.pos_end
                else:
                    gap = 0
                if gap <= self.k:
                    occs.append(
                        Occ(
                            l.field,
                            min(l.pos_start, r.pos_start),
                            max(l.pos_end, r.pos_end),
                            l.paragraph,
                            min(l.start, r.start),
                            max(l.end, r.end),
                        )
                    )
        return occs


class AndOp(Op):
    def __init__(self, children):
        self.children = list(children)
        self.is_positional = all(c.is_positional for c in self.children)

    def occurrences(self, data, doc_id):
        if not self.is_positional:
            raise QueryError("boolean AND has no positional evidence")
        occs = []
        for child in self.children:
            occs.extend(child.occurrences(data, doc_id))
        return occs

    def evaluate(self, data, universe):
        results = [c.evaluate(data, universe) for c in self.children]
        docs = set.intersection(*(r.docs for r in results)) if results else set()
        if not self.is_positional:
            # A boolean branch was involved: the result is boolean only.
            return BooleanResult(docs)
        occ_map = {}
        for doc_id in docs:
            occs = []
            for child in self.children:
                occs.extend(child.occurrences(data, doc_id))
            occ_map[doc_id] = occs
        return PositionalResult(occ_map)


class OrOp(Op):
    def __init__(self, children):
        self.children = list(children)
        self.is_positional = all(c.is_positional for c in self.children)

    def occurrences(self, data, doc_id):
        if not self.is_positional:
            raise QueryError("boolean OR has no positional evidence")
        occs = []
        for child in self.children:
            occs.extend(child.occurrences(data, doc_id))
        return occs

    def evaluate(self, data, universe):
        results = [c.evaluate(data, universe) for c in self.children]
        docs = set.union(*(r.docs for r in results)) if results else set()
        if not self.is_positional:
            return BooleanResult(docs)
        occ_map = {}
        for doc_id in docs:
            occs = []
            for child in self.children:
                occs.extend(child.occurrences(data, doc_id))
            if occs:
                occ_map[doc_id] = occs
        return PositionalResult(occ_map)


class NotOp(Op):
    """Universe complement: ``NOT q`` = all documents minus docs(q)."""

    def __init__(self, child):
        self.child = child

    def evaluate(self, data, universe):
        return BooleanResult(set(universe) - self.child.evaluate(data, universe).docs)


class AllOp(Op):
    def evaluate(self, data, universe):
        return BooleanResult(set(universe))


class FieldExistsOp(Op):
    """Matches documents where a matching field instance has >= 1 token."""

    def __init__(self, matcher):
        self.matcher = matcher

    def evaluate(self, data, universe):
        return BooleanResult(
            doc_id
            for doc_id in universe
            if any(self.matcher.match(f) for f in data.doc_fields.get(doc_id, ()))
        )


# ---------------------------------------------------------------------------
# Compilation
# ---------------------------------------------------------------------------

def _matcher(field_spec, aliases) -> FieldMatcher:
    if field_spec is None:
        return FieldMatcher(None)
    return FieldMatcher(aliases.resolve(field_spec))


def compile_query(node, aliases) -> Op:
    """Compile a parsed query AST into an operator tree (the dataflow)."""
    if isinstance(node, ast.Term):
        return TermOp(node.term, _matcher(node.field, aliases))
    if isinstance(node, ast.Phrase):
        return PhraseOp(node.terms, _matcher(node.field, aliases))
    if isinstance(node, ast.FieldExists):
        return FieldExistsOp(_matcher(node.field, aliases))
    if isinstance(node, ast.AllDocs):
        return AllOp()
    if isinstance(node, ast.Not):
        return NotOp(compile_query(node.child, aliases))
    if isinstance(node, ast.And):
        return AndOp([compile_query(c, aliases) for c in node.children])
    if isinstance(node, ast.Or):
        return OrOp([compile_query(c, aliases) for c in node.children])
    if isinstance(node, ast.Near):
        left = compile_query(node.left, aliases)
        right = compile_query(node.right, aliases)
        for side in (left, right):
            if not isinstance(side, (TermOp, PhraseOp, NearOp)):
                raise QueryError("NEAR operands must be positional (term, phrase or NEAR)")
        return NearOp(left, right, node.k)
    raise QueryError(f"cannot compile node: {node!r}")
