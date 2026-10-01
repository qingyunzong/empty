"""Index: atomic state, batch updates, aliases, snapshots, cache, persistence.

The index is copy-on-write: every committed batch builds a brand new
``_State`` (postings + statistics) and swaps it in one assignment, so index
and statistics are always updated atomically and snapshots are simply
references to older states.

The candidate cache is keyed by ``(state_version, alias_version, query)`` so
any index commit or alias-rule change invalidates previous entries.
"""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass

from .eval import DocSetResult, PosResult, compile_query
from .model import Posting, flatten, tokenize
from .query import parse


class BatchError(Exception):
    """A batch operation failed; the index was left untouched."""


class AliasError(Exception):
    """Invalid alias rule (e.g. a cycle)."""


class _State:
    """Immutable index state: docs, instances, postings, stats."""

    __slots__ = ("version", "docs", "instances", "postings", "stats",
                 "_text_by_key")

    def __init__(self, version: int, docs: dict):
        self.version = version
        self.docs = docs
        self.instances: dict[str, list] = {}
        self.postings: dict[str, dict[str, list[Posting]]] = {}
        self._text_by_key: dict[tuple, str] = {}
        field_stats: dict[str, dict[str, int]] = {}
        total_tokens = 0
        for doc_id, doc in docs.items():
            instances = flatten(doc)
            self.instances[doc_id] = instances
            for inst in instances:
                self._text_by_key[(doc_id, inst.path, inst.ordinal)] = inst.text
                tokens = tokenize(inst.text)
                total_tokens += len(tokens)
                fstat = field_stats.setdefault(inst.path, {"instances": 0, "tokens": 0})
                fstat["instances"] += 1
                fstat["tokens"] += len(tokens)
                for tok in tokens:
                    self.postings.setdefault(tok.text, {}).setdefault(doc_id, []).append(
                        Posting(inst.path, inst.ordinal, tok.para, tok.pos,
                                tok.start, tok.end)
                    )
        self.stats = {
            "doc_count": len(docs),
            "total_tokens": total_tokens,
            "term_count": len(self.postings),
            "fields": field_stats,
        }

    def instance_text(self, doc_id: str, path: str, ordinal: int) -> str:
        return self._text_by_key[(doc_id, path, ordinal)]


@dataclass(frozen=True)
class Snapshot:
    """An immutable view of the index at a point in time."""
    state: _State
    aliases: dict
    alias_version: int


class QueryResult:
    """Outcome of a query: kind ('pos'/'bool'), doc ids, per-doc evidence."""

    def __init__(self, kind: str, docs, evidence: dict | None = None):
        self.kind = kind
        self.docs = sorted(docs)
        self.evidence = evidence or {}

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "count": len(self.docs),
            "docs": self.docs,
            "hits": [
                {
                    "doc": doc_id,
                    "evidence": [e.to_dict() for e in self.evidence.get(doc_id, [])],
                }
                for doc_id in self.docs
            ],
        }


def resolve_alias(name: str, aliases: dict) -> str:
    """Resolve an alias chain to a concrete field spec; detect cycles."""
    seen: list[str] = []
    current = name
    while current in aliases:
        if current in seen:
            cycle = " -> ".join(seen + [current])
            raise AliasError(f"alias cycle detected: {cycle}")
        seen.append(current)
        current = aliases[current]
    return current


# ---------------------------------------------------------------- batch ops

def _parse_path(path: str) -> list[str]:
    parts = [p for p in str(path).split(".") if p != ""]
    if not parts:
        raise BatchError(f"invalid empty path {path!r}")
    return parts


def _navigate(container, parts: list[str], create: bool):
    """Walk to the parent of the last segment; return (parent, last_key)."""
    current = container
    for i, part in enumerate(parts[:-1]):
        nxt = parts[i + 1]
        if isinstance(current, list):
            if not part.isdigit() or int(part) >= len(current):
                raise BatchError(f"bad list index {part!r} in path")
            current = current[int(part)]
        elif isinstance(current, dict):
            if part not in current:
                if not create:
                    raise BatchError(f"missing path segment {part!r}")
                current[part] = [] if nxt.isdigit() else {}
            current = current[part]
        else:
            raise BatchError(f"cannot descend into scalar at {part!r}")
    last = parts[-1]
    if isinstance(current, list):
        if not last.isdigit() or int(last) >= len(current):
            raise BatchError(f"bad list index {last!r} in path")
        return current, int(last)
    if not isinstance(current, dict):
        raise BatchError("cannot address field inside a scalar")
    return current, last


def _get(container, parts: list[str]):
    parent, key = _navigate(container, parts, create=False)
    if isinstance(parent, list):
        return parent[key]
    if key not in parent:
        raise BatchError(f"path {'.'.join(parts)!r} does not exist")
    return parent[key]


def _set(container, parts: list[str], value, overwrite_ok=True):
    parent, key = _navigate(container, parts, create=True)
    if isinstance(parent, list):
        parent[key] = value
        return
    if not overwrite_ok and key in parent:
        raise BatchError(f"target path {'.'.join(parts)!r} already exists")
    parent[key] = value


def _delete(container, parts: list[str]):
    parent, key = _navigate(container, parts, create=False)
    if isinstance(parent, list):
        del parent[key]
        return
    if key not in parent:
        raise BatchError(f"path {'.'.join(parts)!r} does not exist")
    del parent[key]


def _apply_op(docs: dict, op: dict) -> None:
    kind = op.get("op")
    if kind == "add_doc":
        doc_id = str(op["doc"])
        if doc_id in docs:
            raise BatchError(f"document {doc_id!r} already exists")
        document = op["document"]
        if not isinstance(document, dict):
            raise BatchError("document must be a JSON object")
        docs[doc_id] = copy.deepcopy(document)
    elif kind == "remove_doc":
        doc_id = str(op["doc"])
        if doc_id not in docs:
            raise BatchError(f"document {doc_id!r} does not exist")
        del docs[doc_id]
    elif kind == "set":
        doc_id = str(op["doc"])
        if doc_id not in docs:
            raise BatchError(f"document {doc_id!r} does not exist")
        _set(docs[doc_id], _parse_path(op["path"]), copy.deepcopy(op.get("value")))
    elif kind == "delete":
        doc_id = str(op["doc"])
        if doc_id not in docs:
            raise BatchError(f"document {doc_id!r} does not exist")
        _delete(docs[doc_id], _parse_path(op["path"]))
    elif kind == "move":
        doc_id = str(op["doc"])
        if doc_id not in docs:
            raise BatchError(f"document {doc_id!r} does not exist")
        src = _parse_path(op["from"])
        dst = _parse_path(op["to"])
        value = _get(docs[doc_id], src)
        # validate the target before mutating so a failed move changes nothing
        parent, key = _navigate(docs[doc_id], dst, create=True)
        if isinstance(parent, dict) and key in parent:
            raise BatchError(f"target path {op['to']!r} already exists")
        _delete(docs[doc_id], src)
        _set(docs[doc_id], dst, value, overwrite_ok=False)
    else:
        raise BatchError(f"unknown batch op {kind!r}")


# ---------------------------------------------------------------- index

class Index:
    def __init__(self):
        self._state = _State(0, {})
        self._aliases: dict[str, str] = {}
        self._alias_version = 0
        self._cache: dict = {}

    # ---------------- aliases

    def set_alias(self, name: str, spec: str) -> None:
        trial = dict(self._aliases)
        trial[name] = spec
        resolve_alias(name, trial)  # raises AliasError on cycles
        self._aliases = trial
        self._alias_version += 1
        self._cache.clear()

    def remove_alias(self, name: str) -> None:
        if name not in self._aliases:
            raise AliasError(f"unknown alias {name!r}")
        trial = dict(self._aliases)
        del trial[name]
        self._aliases = trial
        self._alias_version += 1
        self._cache.clear()

    @property
    def aliases(self) -> dict:
        return dict(self._aliases)

    # ---------------- mutation

    def apply_batch(self, ops: list[dict]) -> None:
        """Apply a batch of ops atomically; any failure rolls everything back."""
        new_docs = copy.deepcopy(self._state.docs)
        for op in ops:
            _apply_op(new_docs, op)  # raises BatchError -> nothing committed
        self._state = _State(self._state.version + 1, new_docs)
        self._cache.clear()

    def add_document(self, doc_id: str, document: dict) -> None:
        self.apply_batch([{"op": "add_doc", "doc": doc_id, "document": document}])

    def remove_document(self, doc_id: str) -> None:
        self.apply_batch([{"op": "remove_doc", "doc": doc_id}])

    # ---------------- snapshots / stats

    def snapshot(self) -> Snapshot:
        return Snapshot(self._state, dict(self._aliases), self._alias_version)

    def stats(self, snapshot: Snapshot | None = None) -> dict:
        state = snapshot.state if snapshot else self._state
        return copy.deepcopy(state.stats)

    @property
    def cache_size(self) -> int:
        return len(self._cache)

    # ---------------- query

    def query(self, text: str, snapshot: Snapshot | None = None) -> QueryResult:
        if snapshot is not None:
            state, aliases, aver = snapshot.state, snapshot.aliases, snapshot.alias_version
        else:
            state, aliases, aver = self._state, self._aliases, self._alias_version
        key = (state.version, aver, " ".join(text.split()))
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        ast = parse(text)
        program = compile_query(ast, state, lambda name: resolve_alias(name, aliases))
        raw = program.evaluate()
        if isinstance(raw, PosResult):
            result = QueryResult("pos", raw.docs, raw.matches)
        elif isinstance(raw, DocSetResult):
            result = QueryResult("bool", raw.docs, {})
        else:  # pragma: no cover - defensive
            raise TypeError(f"unexpected result {type(raw)!r}")
        self._cache[key] = result
        return result

    # ---------------- persistence

    def save(self, path: str) -> None:
        payload = {
            "format": 1,
            "docs": self._state.docs,
            "aliases": self._aliases,
            "alias_version": self._alias_version,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "Index":
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
        if payload.get("format") != 1:
            raise ValueError("unsupported index file format")
        index = cls()
        for name, spec in payload.get("aliases", {}).items():
            index.set_alias(name, spec)
        docs = payload.get("docs", {})
        if docs:
            index.apply_batch([
                {"op": "add_doc", "doc": doc_id, "document": doc}
                for doc_id, doc in docs.items()
            ])
        return index
