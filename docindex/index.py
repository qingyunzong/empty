"""Positional index with atomic commits, batches, snapshots and caching.

State transitions (add/delete/batch/alias) are copy-on-write: a new
:class:`IndexData` and new statistics are built first and swapped in
together with a bumped ``index_version``, so the inverted index and the
statistics are always updated atomically.

The candidate cache maps ``(query, alias_version, index_version, view)`` to
the candidate document set; changing alias rules bumps ``alias_version``
and therefore invalidates cached candidates by rule version.
"""
from __future__ import annotations

import copy
import json
from collections import namedtuple

from .compile import PositionalResult, compile_query
from .errors import BatchError, SnapshotError
from .fields import (
    AliasRules,
    delete_path,
    get_path,
    iter_field_instances,
    move_path,
    parse_path,
    set_path,
)
from .query import parse_query
from .tokenizer import tokenize

Posting = namedtuple("Posting", "doc_id field pos paragraph start end")


class IndexData:
    """Inverted positional index plus per-document field information."""

    def __init__(self, docs):
        self.docs = docs
        self.inverted: dict[str, dict[str, list[Posting]]] = {}
        # doc_id -> set of field instance paths that contain >= 1 token
        self.doc_fields: dict[str, set] = {}
        self._lookup: dict[str, dict] = {}
        for doc_id, doc in docs.items():
            fields = set()
            for path, text in iter_field_instances(doc):
                tokens = tokenize(text)
                if tokens:
                    fields.add(path)
                for tok in tokens:
                    posting = Posting(doc_id, path, tok.pos, tok.paragraph, tok.start, tok.end)
                    self.inverted.setdefault(tok.term, {}).setdefault(doc_id, []).append(posting)
            self.doc_fields[doc_id] = fields

    def find(self, term, doc_id, field, pos):
        """O(1) posting lookup used by phrase evaluation."""
        lookup = self._lookup.get(term)
        if lookup is None:
            lookup = {
                (p.doc_id, p.field, p.pos): p
                for postings in self.inverted.get(term, {}).values()
                for p in postings
            }
            self._lookup[term] = lookup
        return lookup.get((doc_id, field, pos))


def compute_stats(data: IndexData) -> dict:
    fields: dict[str, dict] = {}
    total_tokens = 0
    for by_doc in data.inverted.values():
        for doc_id, postings in by_doc.items():
            for p in postings:
                total_tokens += 1
                entry = fields.setdefault(p.field, {"doc_ids": set(), "token_count": 0})
                entry["doc_ids"].add(doc_id)
                entry["token_count"] += 1
    return {
        "num_docs": len(data.docs),
        "num_tokens": total_tokens,
        "num_field_instances": sum(len(v) for v in data.doc_fields.values()),
        "fields": {
            name: {"doc_count": len(info["doc_ids"]), "token_count": info["token_count"]}
            for name, info in sorted(fields.items())
        },
    }


_View = namedtuple("_View", "data aliases alias_version index_version tag")


class Index:
    """A multi-field positional document index."""

    def __init__(self):
        self._docs: dict[str, dict] = {}
        self._data = IndexData(self._docs)
        self._stats = compute_stats(self._data)
        self.aliases = AliasRules()
        self._index_version = 0
        self._snapshots: dict[str, dict] = {}
        self._cache: dict = {}

    # ------------------------------------------------------------------
    # atomic state transitions
    # ------------------------------------------------------------------
    def _commit(self, new_docs) -> None:
        """Atomically swap in new docs, a rebuilt index and new statistics."""
        new_data = IndexData(new_docs)
        new_stats = compute_stats(new_data)
        self._docs = new_docs
        self._data = new_data
        self._stats = new_stats
        self._index_version += 1

    def add_doc(self, doc_id: str, doc: dict) -> None:
        if not isinstance(doc, dict):
            raise BatchError("document must be a JSON object")
        new_docs = copy.deepcopy(self._docs)
        new_docs[str(doc_id)] = doc
        self._commit(new_docs)

    def delete_doc(self, doc_id: str) -> None:
        if doc_id not in self._docs:
            raise BatchError(f"no such document: {doc_id!r}")
        new_docs = copy.deepcopy(self._docs)
        del new_docs[doc_id]
        self._commit(new_docs)

    def apply_batch(self, ops: list) -> dict:
        """Apply a batch of mutations atomically.

        All operations are validated and applied to a private copy first;
        if any operation fails, nothing is committed and the index and
        statistics are left untouched.
        """
        if not isinstance(ops, list) or not ops:
            raise BatchError("batch must be a non-empty list of operations")
        new_docs = copy.deepcopy(self._docs)
        for i, op in enumerate(ops):
            try:
                self._apply_op(new_docs, op)
            except BatchError:
                raise
            except Exception as exc:  # normalize to BatchError, no commit
                raise BatchError(f"batch op {i} failed: {exc}") from exc
        self._commit(new_docs)
        return {"applied": len(ops), "index_version": self._index_version}

    @staticmethod
    def _apply_op(docs, op) -> None:
        if not isinstance(op, dict):
            raise BatchError(f"invalid operation: {op!r}")
        kind = op.get("op")
        if kind == "add_doc":
            if not isinstance(op.get("doc"), dict):
                raise BatchError("add_doc requires an object 'doc'")
            docs[str(op["doc_id"])] = op["doc"]
        elif kind == "delete_doc":
            doc_id = str(op["doc_id"])
            if doc_id not in docs:
                raise BatchError(f"no such document: {doc_id!r}")
            del docs[doc_id]
        elif kind == "set_field":
            doc = docs.get(str(op["doc_id"]))
            if doc is None:
                raise BatchError(f"no such document: {op['doc_id']!r}")
            set_path(doc, parse_path(op["path"]), op.get("value"))
        elif kind == "delete_field":
            doc = docs.get(str(op["doc_id"]))
            if doc is None:
                raise BatchError(f"no such document: {op['doc_id']!r}")
            delete_path(doc, parse_path(op["path"]))
        elif kind == "move_field":
            doc = docs.get(str(op["doc_id"]))
            if doc is None:
                raise BatchError(f"no such document: {op['doc_id']!r}")
            move_path(doc, parse_path(op["from"]), parse_path(op["to"]))
        else:
            raise BatchError(f"unknown batch operation: {kind!r}")

    # ------------------------------------------------------------------
    # alias rules
    # ------------------------------------------------------------------
    def set_aliases(self, rules) -> None:
        """Replace alias rules (bumps the rule version, invalidating cache)."""
        self.aliases.set_rules(rules)

    # ------------------------------------------------------------------
    # snapshots
    # ------------------------------------------------------------------
    def create_snapshot(self, name: str) -> None:
        if name in self._snapshots:
            raise SnapshotError(f"snapshot already exists: {name!r}")
        frozen_aliases = AliasRules(copy.deepcopy(self.aliases.rules))
        frozen_aliases.version = self.aliases.version
        self._snapshots[name] = {
            "docs": copy.deepcopy(self._docs),
            "aliases": frozen_aliases,
            "alias_version": self.aliases.version,
            "index_version": self._index_version,
            "data": None,  # built lazily
        }

    def _view(self, snapshot) -> _View:
        if snapshot is None:
            return _View(self._data, self.aliases, self.aliases.version, self._index_version, "live")
        snap = self._snapshots.get(snapshot)
        if snap is None:
            raise SnapshotError(f"no such snapshot: {snapshot!r}")
        if snap["data"] is None:
            snap["data"] = IndexData(snap["docs"])
        return _View(snap["data"], snap["aliases"], snap["alias_version"], snap["index_version"], f"snap:{snapshot}")

    # ------------------------------------------------------------------
    # querying
    # ------------------------------------------------------------------
    def search(self, query: str, snapshot: str | None = None) -> dict:
        view = self._view(snapshot)
        op = compile_query(parse_query(query), view.aliases)
        universe = set(view.data.docs)
        key = (query, view.alias_version, view.index_version, view.tag)
        candidates = self._cache.get(key)
        occ_map = None
        if candidates is None:
            result = op.evaluate(view.data, universe)
            candidates = frozenset(result.docs)
            self._cache[key] = candidates
            if isinstance(result, PositionalResult):
                occ_map = result.occ_map
        response = {
            "query": query,
            "snapshot": snapshot,
            "kind": "pos" if op.is_positional else "bool",
            "count": len(candidates),
            "doc_ids": sorted(candidates),
        }
        if op.is_positional:
            hits = []
            for doc_id in sorted(candidates):
                occs = occ_map[doc_id] if occ_map is not None else op.occurrences(view.data, doc_id)
                doc = view.data.docs[doc_id]
                for occ in occs:
                    text = get_path(doc, parse_path(occ.field))
                    hits.append(
                        {
                            "doc_id": doc_id,
                            "field": occ.field,
                            "paragraph": occ.paragraph,
                            "span": [occ.start, occ.end],
                            "text": text[occ.start : occ.end],
                        }
                    )
            response["hits"] = hits
        return response

    @property
    def cache_size(self) -> int:
        return len(self._cache)

    def stats(self) -> dict:
        return {
            **self._stats,
            "index_version": self._index_version,
            "alias_version": self.aliases.version,
            "snapshots": sorted(self._snapshots),
            "cache_entries": len(self._cache),
        }

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------
    def save(self, path: str) -> None:
        payload = {
            "format": 1,
            "docs": self._docs,
            "aliases": self.aliases.rules,
            "alias_version": self.aliases.version,
            "index_version": self._index_version,
            "snapshots": {
                name: {
                    "docs": snap["docs"],
                    "aliases": snap["aliases"].rules,
                    "alias_version": snap["alias_version"],
                    "index_version": snap["index_version"],
                }
                for name, snap in self._snapshots.items()
            },
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)

    @classmethod
    def restore(cls, path: str) -> "Index":
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        if payload.get("format") != 1:
            raise SnapshotError("unsupported store format")
        index = cls()
        index._docs = payload["docs"]
        index.aliases = AliasRules(payload.get("aliases"))
        index.aliases.version = payload.get("alias_version", 0)
        index._index_version = payload.get("index_version", 0)
        index._data = IndexData(index._docs)
        index._stats = compute_stats(index._data)
        for name, snap in payload.get("snapshots", {}).items():
            frozen = AliasRules(snap.get("aliases"))
            frozen.version = snap.get("alias_version", 0)
            index._snapshots[name] = {
                "docs": snap["docs"],
                "aliases": frozen,
                "alias_version": snap.get("alias_version", 0),
                "index_version": snap.get("index_version", 0),
                "data": None,
            }
        return index
