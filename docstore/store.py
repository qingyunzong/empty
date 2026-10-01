"""Persistent, versioned JSON document store.

Layout of a store directory::

    base.json            snapshot {"version": N, "doc": ...} written by reclaim()
    indexes.json         index definitions {"name": "/pattern"}
    wal/<version>.json   one committed patch batch per file

Commit protocol: a batch is applied to a private working copy of the
document while every index is advanced incrementally on its own working
copy.  The batch is then appended to the WAL (tmp file + fsync + atomic
rename) and only afterwards the new immutable Version is published.
Any failure before publish leaves the previous version fully intact
(all-or-nothing), and recovery replays whatever the WAL durably holds.

Injectable interrupt points (hooks) for crash-recovery testing:

* ``wal_tmp_written``   -- tmp log flushed, not yet renamed
* ``wal_committed``     -- log record durable, version not yet published
* ``after_publish``     -- version published, reclaim not yet possible
* ``before_index_publish`` -- index built + caught up, not yet switched in
* ``reclaim_base_written`` -- base snapshot written, WAL not yet truncated
"""

import hashlib
import json
import os
import threading
from copy import deepcopy
from pathlib import Path

from . import engine, strictjson
from .errors import IndexConflictError, PatchError, QueryError
from .index import Index
from .paths import parse_pattern, to_pointer
from .values import sort_key, value_key

SCHEMA = 1


class Version:
    """An immutable, self-consistent view of doc + indexes."""

    __slots__ = ("number", "doc", "indexes")

    def __init__(self, number, doc, indexes):
        self.number = number
        self.doc = doc
        self.indexes = indexes


class Snapshot:
    """A read-only handle pinning one Version; safe across reclaim()."""

    def __init__(self, store, version):
        self._store = store
        self._version = version
        self._released = False

    @property
    def version(self):
        return self._version.number

    def get(self, pointer=""):
        self._check()
        from .paths import parse_pointer
        node = self._version.doc
        for seg in parse_pointer(pointer):
            if isinstance(node, list):
                node = node[int(seg)]
            else:
                node = node[seg]
        return deepcopy(node)

    def query(self, filters, sort_by=None):
        self._check()
        return self._store._run_query(self._version, filters, sort_by)

    def release(self):
        self._released = True

    def _check(self):
        if self._released:
            raise QueryError("snapshot has been released")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()
        return False


def _canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


class DocumentStore:
    def __init__(self, path, initial=None, hooks=None):
        self._dir = Path(path)
        self._hooks = dict(hooks or {})
        self._lock = threading.RLock()
        self._history = []  # (version_number, ops) committed this session
        self._dir.mkdir(parents=True, exist_ok=True)
        (self._dir / "wal").mkdir(exist_ok=True)
        base = self._dir / "base.json"
        if base.exists() or any((self._dir / "wal").glob("*.json")):
            self._recover()
        else:
            doc = deepcopy(initial) if initial is not None else {}
            self._version = Version(0, doc, {})
            self._persist_index_defs()

    # -- hooks ---------------------------------------------------------

    def _fire(self, point, *args):
        hook = self._hooks.get(point)
        if hook is not None:
            hook(*args)

    # -- persistence & recovery ----------------------------------------

    def _wal_path(self, version):
        return self._dir / "wal" / f"{version:020d}.json"

    def _wal_append(self, version, ops):
        record = {"schema": SCHEMA, "version": version, "ops": ops}
        record["sha256"] = hashlib.sha256(
            _canonical(record).encode("utf-8")).hexdigest()
        tmp = self._wal_path(version).with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(strictjson.dumps(record))
            fh.flush()
            os.fsync(fh.fileno())
        self._fire("wal_tmp_written", str(tmp))
        os.replace(tmp, self._wal_path(version))
        self._fire("wal_committed", str(self._wal_path(version)))

    def _recover(self):
        base_file = self._dir / "base.json"
        if base_file.exists():
            rec = strictjson.loads(base_file.read_text(encoding="utf-8"))
            number, doc = rec["version"], rec["doc"]
        else:
            number, doc = 0, {}
        for wal in sorted((self._dir / "wal").glob("*.json")):
            try:
                rec = strictjson.loads(wal.read_text(encoding="utf-8"))
                sha = rec.pop("sha256")
                if hashlib.sha256(
                        _canonical(rec).encode("utf-8")).hexdigest() != sha:
                    break  # corrupt tail: stop replay
                if rec["version"] <= number:
                    continue  # already covered by the base snapshot
                if rec["version"] != number + 1:
                    break  # gap: stop replay
                for op in rec["ops"]:
                    doc, _ = engine.apply_op(doc, op)
                number = rec["version"]
            except Exception:
                break  # unreadable record: treat as torn tail
        defs = self._load_index_defs()
        indexes = {
            name: Index.build(name, parse_pattern(pat), pat, doc)
            for name, pat in defs.items()
        }
        self._version = Version(number, doc, indexes)

    def _load_index_defs(self):
        defs_file = self._dir / "indexes.json"
        if not defs_file.exists():
            return {}
        return strictjson.loads(defs_file.read_text(encoding="utf-8"))

    def _persist_index_defs(self):
        defs = {n: idx.pattern_text for n, idx in self._version.indexes.items()}
        tmp = self._dir / "indexes.json.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(strictjson.dumps(defs))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._dir / "indexes.json")

    # -- batch apply -----------------------------------------------------

    def apply(self, ops):
        """Apply a batch of JSON Patch ops atomically; returns version."""
        if not ops:
            return self._version.number
        with self._lock:
            current = self._version
            working = deepcopy(current.doc)
            work_idx = {n: idx.copy() for n, idx in current.indexes.items()}
            for op in ops:
                working, affected = engine.apply_op(working, op)
                for idx in work_idx.values():
                    for prefix in affected.removals:
                        idx.remove_under(prefix)
                    for prefix in affected.additions:
                        idx.add_subtree(working, prefix)
            number = current.number + 1
            self._wal_append(number, ops)
            self._version = Version(number, working, work_idx)
            self._history.append((number, ops))
            self._fire("after_publish", number)
            return number

    # -- index management --------------------------------------------------

    def create_index(self, name, pattern_text):
        """Build an index, catch up via the commit log, switch atomically.

        The full scan runs against a stable version; batches committed
        meanwhile are replayed from the in-memory log until the index is
        current, then it is published under the lock in one step.
        """
        pattern = parse_pattern(pattern_text)
        with self._lock:
            if name in self._version.indexes:
                raise IndexConflictError(f"index exists: {name!r}")
            base = self._version
        idx = Index.build(name, pattern, pattern_text, base.doc)
        built_at = base.number
        while True:
            with self._lock:
                pending = [ops for ver, ops in self._history
                           if built_at < ver <= self._version.number]
                if not pending and built_at == self._version.number:
                    self._fire("before_index_publish", name)
                    indexes = dict(self._version.indexes)
                    indexes[name] = idx
                    self._version = Version(
                        self._version.number, self._version.doc, indexes)
                    self._persist_index_defs()
                    return idx
                doc = deepcopy(base.doc)
                catch_up = pending
                target = self._version.number
            for ops in catch_up:  # replay outside the lock
                for op in ops:
                    doc, affected = engine.apply_op(doc, op)
                    for prefix in affected.removals:
                        idx.remove_under(prefix)
                    for prefix in affected.additions:
                        idx.add_subtree(doc, prefix)
            built_at = target
            base = self._version

    def drop_index(self, name):
        with self._lock:
            if name not in self._version.indexes:
                raise IndexConflictError(f"unknown index: {name!r}")
            indexes = dict(self._version.indexes)
            del indexes[name]
            self._version = Version(
                self._version.number, self._version.doc, indexes)
            self._persist_index_defs()

    def list_indexes(self):
        return {n: idx.pattern_text
                for n, idx in self._version.indexes.items()}

    # -- queries -----------------------------------------------------------

    def _eval_filter(self, indexes, filt):
        if not isinstance(filt, dict):
            raise QueryError(f"malformed filter: {filt!r}")
        if "and" in filt:
            parts = [self._eval_filter(indexes, f) for f in filt["and"]]
            if not parts:
                return set()
            return set.intersection(*parts)
        name = filt.get("index")
        if name not in indexes:
            raise QueryError(f"unknown index: {name!r}")
        idx = indexes[name]
        if "eq" in filt:
            return set(idx.entries.get(value_key(filt["eq"]), ()))
        if filt.get("exists"):
            return set(idx.locations)
        raise QueryError(f"filter needs 'eq', 'exists' or 'and': {filt!r}")

    def _first_index_name(self, filters):
        for filt in filters:
            if "and" in filt:
                got = self._first_index_name(filt["and"])
                if got:
                    return got
            elif "index" in filt:
                return filt["index"]
        return None

    def _run_query(self, version, filters, sort_by=None):
        if isinstance(filters, dict):
            filters = [filters]
        indexes = version.indexes
        if not filters:
            raise QueryError("at least one filter is required")
        result = set.intersection(
            *[self._eval_filter(indexes, f) for f in filters])
        value_from = sort_by or self._first_index_name(filters)
        locations = indexes[value_from].locations if value_from else {}
        if sort_by is not None:
            if sort_by not in indexes:
                raise QueryError(f"unknown index: {sort_by!r}")
            locs = indexes[sort_by].locations
            ordered = sorted(
                result,
                key=lambda p: sort_key(locs[p]) if p in locs else (99, None))
        else:
            ordered = sorted(result, key=lambda p: tuple(map(str, p)))
        rows = [{"path": to_pointer(p), "value": deepcopy(locations.get(p))}
                for p in ordered]
        return rows

    def query(self, filters, sort_by=None):
        with self._lock:
            return self._run_query(self._version, filters, sort_by)

    # -- snapshots, versions, reclaim ---------------------------------------

    @property
    def version(self):
        return self._version.number

    def get(self, pointer=""):
        with self._lock:
            snap = Snapshot(self, self._version)
        try:
            return snap.get(pointer)
        finally:
            snap.release()

    def open_snapshot(self):
        with self._lock:
            return Snapshot(self, self._version)

    def reclaim(self):
        """Persist a base snapshot of the current version and truncate the
        WAL.  Open snapshots pin their own immutable Version objects, so
        reclaiming old versions never disturbs them."""
        with self._lock:
            version = self._version
            rec = {"schema": SCHEMA, "version": version.number,
                   "doc": version.doc}
            tmp = self._dir / "base.json.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(strictjson.dumps(rec))
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._dir / "base.json")
            self._fire("reclaim_base_written")
            for wal in sorted((self._dir / "wal").glob("*.json")):
                try:
                    num = int(wal.stem)
                except ValueError:
                    continue
                if num <= version.number:
                    wal.unlink()
            return version.number
