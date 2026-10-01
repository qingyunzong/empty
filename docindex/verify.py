"""Independent per-document interpreter used to cross-check the index.

This module deliberately does NOT use the inverted index or the compiled
dataflow: it re-tokenizes every field instance of every document and
evaluates the parsed query directly, document by document.  It shares only
the query parser, the tokenizer and the alias-resolution rules (the common
specification), so that ``cross_check`` is a genuine second implementation
of the evaluation semantics.

``NOT`` keeps universe semantics: a document matches ``NOT q`` iff it does
not match ``q``; evaluated over the whole collection this equals
``universe - docs(q)``.
"""
from __future__ import annotations

from . import query as ast
from .errors import QueryError
from .fields import AliasRules, FieldMatcher, get_path, iter_field_instances, parse_path
from .query import parse_query
from .tokenizer import tokenize

# occurrence tuple: (field, pos_start, pos_end, paragraph, start, end)


def _matcher(field_spec, aliases) -> FieldMatcher:
    if field_spec is None:
        return FieldMatcher(None)
    return FieldMatcher(aliases.resolve(field_spec))


def _eval(node, fields, aliases):
    """Evaluate *node* on one document's tokenized fields.

    ``fields`` maps a field instance path to its token list.
    Returns ``(matched, is_positional, occurrences)``.
    """
    if isinstance(node, ast.Term):
        matcher = _matcher(node.field, aliases)
        occs = [
            (path, tok.pos, tok.pos, tok.paragraph, tok.start, tok.end)
            for path, tokens in fields.items()
            if matcher.match(path)
            for tok in tokens
            if tok.term == node.term
        ]
        return (bool(occs), True, occs)

    if isinstance(node, ast.Phrase):
        matcher = _matcher(node.field, aliases)
        terms = node.terms
        n = len(terms)
        occs = []
        for path, tokens in fields.items():
            if not matcher.match(path):
                continue
            for i in range(0, len(tokens) - n + 1):
                window = tokens[i : i + n]
                # consecutive positions => same field instance and paragraph
                if all(window[j].term == terms[j] and window[j].pos == window[0].pos + j for j in range(n)):
                    occs.append((path, window[0].pos, window[-1].pos, window[0].paragraph, window[0].start, window[-1].end))
        return (bool(occs), True, occs)

    if isinstance(node, ast.Near):
        _, lpos, loccs = _eval(node.left, fields, aliases)
        _, rpos, roccs = _eval(node.right, fields, aliases)
        if not lpos or not rpos:
            raise QueryError("NEAR operands must be positional (term, phrase or NEAR)")
        occs = []
        for l in loccs:
            for r in roccs:
                if l[0] != r[0]:
                    continue
                if l[2] < r[1]:
                    gap = r[1] - l[2]
                elif r[2] < l[1]:
                    gap = l[1] - r[2]
                else:
                    gap = 0
                if gap <= node.k:
                    occs.append((l[0], min(l[1], r[1]), max(l[2], r[2]), l[3], min(l[4], r[4]), max(l[5], r[5])))
        return (bool(occs), True, occs)

    if isinstance(node, ast.And):
        parts = [_eval(child, fields, aliases) for child in node.children]
        matched = all(p[0] for p in parts)
        positional = all(p[1] for p in parts)
        occs = [occ for p in parts for occ in p[2]] if positional else []
        return (matched, positional, occs)

    if isinstance(node, ast.Or):
        parts = [_eval(child, fields, aliases) for child in node.children]
        matched = any(p[0] for p in parts)
        positional = all(p[1] for p in parts)
        occs = [occ for p in parts for occ in p[2]] if positional else []
        return (matched, positional, occs)

    if isinstance(node, ast.Not):
        matched, _, _ = _eval(node.child, fields, aliases)
        return (not matched, False, [])

    if isinstance(node, ast.FieldExists):
        matcher = _matcher(node.field, aliases)
        matched = any(matcher.match(path) and tokens for path, tokens in fields.items())
        return (matched, False, [])

    if isinstance(node, ast.AllDocs):
        return (True, False, [])

    raise QueryError(f"cannot evaluate node: {node!r}")


def interpreter_search(query, docs, aliases=None) -> dict:
    """Evaluate *query* over *docs* with the independent interpreter."""
    node = parse_query(query)
    aliases = aliases if aliases is not None else AliasRules()
    doc_ids = []
    hits = {}
    kind = None
    for doc_id in sorted(docs):
        fields = {path: tokenize(text) for path, text in iter_field_instances(docs[doc_id])}
        matched, positional, occs = _eval(node, fields, aliases)
        kind = "pos" if positional else "bool"
        if matched:
            doc_ids.append(doc_id)
            if positional:
                hits[doc_id] = occs
    return {"kind": kind, "doc_ids": doc_ids, "hits": hits}


def cross_check(index, queries, snapshot=None) -> int:
    """Compare index results against the interpreter for every query.

    Raises ``AssertionError`` on the first mismatch; returns the number of
    queries that were verified.
    """
    if snapshot is None:
        docs, aliases = index._docs, index.aliases
    else:
        snap = index._snapshots[snapshot]
        docs, aliases = snap["docs"], snap["aliases"]
    for query in queries:
        actual = index.search(query, snapshot=snapshot)
        expected = interpreter_search(query, docs, aliases)
        assert actual["kind"] == expected["kind"], (
            f"kind mismatch for {query!r}: index={actual['kind']} interpreter={expected['kind']}"
        )
        assert actual["doc_ids"] == expected["doc_ids"], (
            f"doc set mismatch for {query!r}: index={actual['doc_ids']} interpreter={expected['doc_ids']}"
        )
        if actual["kind"] == "pos":
            for doc_id in expected["doc_ids"]:
                from_index = sorted(
                    (h["field"], h["paragraph"], h["span"][0], h["span"][1])
                    for h in actual["hits"]
                    if h["doc_id"] == doc_id
                )
                from_interp = sorted(
                    (field, para, start, end)
                    for (field, _ps, _pe, para, start, end) in expected["hits"].get(doc_id, [])
                )
                assert from_index == from_interp, (
                    f"evidence mismatch for {query!r} doc {doc_id}: index={from_index} interpreter={from_interp}"
                )
            # every hit must locate back into the original field text
            for hit in actual["hits"]:
                text = get_path(docs[hit["doc_id"]], parse_path(hit["field"]))
                assert text[hit["span"][0] : hit["span"][1]] == hit["text"], (
                    f"span does not locate into source for {query!r}: {hit}"
                )
    return len(queries)
