"""Persistent, versioned JSON document store.

Durability model (per applied batch):
  1. validate the patch on a private copy (all-or-nothing),
  2. append a CRC-protected record to the write-ahead log,
  3. apply in memory: new version + incrementally updated indexes,
  4. publish: write the version file, then atomically swap HEAD,
  5. truncate the log and reclaim unpinned versions.

Recovery on open replays any logged-but-unpublished records and
discards a torn log tail. Injectable fault points (``Faults``) sit
between these steps so tests can simulate crashes.
"""
from __future__ import annotations

import os
import threading
import zlib

from . import pointers, strictjson
from .index import Index, extract_pairs
from .patch import PatchError, affected_roots, apply_patch
from .query import run_query

__all__ = [
    "DocumentStore",
    "Snapshot",
    "Version",
    "Faults",
    "InjectedFault",
]

LOG_NAME = "log.jsonl"
HEAD_NAME = "HEAD"
INDEX_DEFS_NAME = "indexes.json"
VERSIONS_DIR = "versions"


class InjectedFault(Exception):
    """Raised when a test-injected fault fires."""


class Faults:
    """Injectable interruption points.

    Known points: ``after_log_append``, ``after_index_built``,
    ``after_publish``, ``index_build_scan``, ``index_build_done``.
    """

    def __init__(self):
        self._handlers = {}

    def set(self, point, handler=None):
        if handler is None:
            def handler(point):
                raise InjectedFault(point)
        self._handlers[point] = handler

    def clear(self, point=None):
        if point is None:
            self._handlers.clear()
        else:
            self._handlers.pop(point, None)

    def hit(self, point):
        handler = self._handlers.get(point)
        if handler is not None:
            handler(point)


class Version:
    """Immutable view of one store version."""

    __slots__ = ("num", "docs", "indexes")

    def __init__(self, num, docs, indexes):
        self.num = num
        self.docs = docs
        self.indexes = indexes


class Snapshot:
    """Read-only pinned view of one store version."""

    def __init__(self, store, version):
        self._store = store
        self.version = version
        self._closed = False
        store._pin(version.num)

    @property
    def num(self):
        return self.version.num

    def _check(self):
        if self._closed:
            raise RuntimeError("snapshot is closed")

    def get(self, doc_id):
        self._check()
        return self.version.docs[doc_id]

    def doc_ids(self):
        self._check()
        return sorted(self.version.docs)

    def query(self, query):
        self._check()
        return run_query(self.version.docs, self.version.indexes, query)

    def index_count(self, name):
        self._check()
        return self.version.indexes[name].entry_count()

    def close(self):
        if not self._closed:
            self._closed = True
            self._store._unpin(self.version.num)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class DocumentStore:
    """A directory-backed, versioned collection of JSON documents."""

    def __init__(self, path, faults=None, auto_gc=True):
        self.path = path
        self.faults = faults if faults is not None else Faults()
        self.auto_gc = auto_gc
        self._lock = threading.RLock()
        self._versions = {}
        self._pins = {}
        self._latest = 0
        self._index_defs = {}
        self._oplog = {}
        self._builds = 0
        os.makedirs(os.path.join(path, VERSIONS_DIR), exist_ok=True)
        self._recover()

    # ---------------------------------------------------------- paths
    def _log_path(self):
        return os.path.join(self.path, LOG_NAME)

    def _head_path(self):
        return os.path.join(self.path, HEAD_NAME)

    def _version_path(self, num):
        return os.path.join(self.path, VERSIONS_DIR, "v%d.json" % num)

    # ------------------------------------------------------- recovery
    def _recover(self):
        head = self._read_head()
        docs = self._load_version_docs(head) if head else {}
        self._index_defs = self._load_index_defs()
        base = Version(head, docs, {})
        for name, pattern in self._index_defs.items():
            base.indexes[name] = Index.build(name, pattern, docs)
        self._versions[head] = base
        self._latest = head
        records, valid_bytes, total_bytes = self._scan_log()
        for rec in records:
            if rec.get("version") != self._latest + 1:
                break  # already published or inconsistent: stop replay
            self._apply_record(rec)
        if self._latest != head:
            self._publish(self._versions[self._latest])
        if total_bytes:
            self._truncate_log()
        if self.auto_gc:
            self._gc()

    def _read_head(self):
        try:
            with open(self._head_path(), "r", encoding="utf-8") as fh:
                return int(fh.read().strip())
        except (OSError, ValueError):
            return 0

    def _load_version_docs(self, num):
        with open(self._version_path(num), "r", encoding="utf-8") as fh:
            payload = strictjson.loads(fh.read())
        return payload["docs"]

    def _load_index_defs(self):
        try:
            with open(os.path.join(self.path, INDEX_DEFS_NAME), encoding="utf-8") as fh:
                raw = strictjson.loads(fh.read())
        except OSError:
            return {}
        return {name: tuple(pointers.parse(pattern)) for name, pattern in raw.items()}

    def _scan_log(self):
        records = []
        valid = 0
        try:
            with open(self._log_path(), "rb") as fh:
                data = fh.read()
        except OSError:
            return [], 0, 0
        for line in data.splitlines(keepends=True):
            ok = False
            try:
                crc_text, payload = line.decode("utf-8").rstrip("\n").split(" ", 1)
                if zlib.crc32(payload.encode("utf-8")) == int(crc_text):
                    records.append(strictjson.loads(payload))
                    ok = True
            except (ValueError, UnicodeDecodeError):
                ok = False
            if not ok:
                break  # torn tail: everything from here is discarded
            valid += len(line)
        return records, valid, len(data)

    # ----------------------------------------------------- durability
    def _append_log(self, rec):
        payload = strictjson.dumps(rec)
        line = "%d %s\n" % (zlib.crc32(payload.encode("utf-8")), payload)
        with open(self._log_path(), "a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())

    def _truncate_log(self):
        with open(self._log_path(), "w", encoding="utf-8"):
            pass

    def _publish(self, version):
        tmp = self._version_path(version.num) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(strictjson.dumps({"version": version.num, "docs": version.docs}))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._version_path(version.num))
        tmp_head = self._head_path() + ".tmp"
        with open(tmp_head, "w", encoding="utf-8") as fh:
            fh.write(str(version.num))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_head, self._head_path())

    def _persist_index_defs(self):
        raw = {name: pointers.format(list(pattern)) for name, pattern in self._index_defs.items()}
        tmp = os.path.join(self.path, INDEX_DEFS_NAME + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(strictjson.dumps(raw))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, os.path.join(self.path, INDEX_DEFS_NAME))

    # -------------------------------------------------------- versions
    def _apply_record(self, rec):
        base = self._versions[self._latest]
        doc_id = rec["doc"]
        if rec["kind"] == "put":
            new_doc = rec["value"]
            roots = [""]
        elif rec["kind"] == "patch":
            if doc_id not in base.docs:
                raise KeyError(doc_id)
            new_doc = apply_patch(base.docs[doc_id], rec["ops"])
            roots = affected_roots(rec["ops"])
        else:
            raise ValueError("unknown log record kind: %r" % rec.get("kind"))
        new_docs = dict(base.docs)
        new_docs[doc_id] = new_doc
        new_indexes = dict(base.indexes)
        for name, idx in base.indexes.items():
            added = extract_pairs(new_doc, idx.pattern, roots)
            new_indexes[name] = idx.updated(doc_id, roots, added)
        num = rec["version"]
        self._versions[num] = Version(num, new_docs, new_indexes)
        self._latest = num
        self._oplog[num] = [(doc_id, list(roots), new_doc)]

    def _commit(self, rec):
        """Shared commit pipeline for put/apply (caller holds the lock)."""
        self._append_log(rec)
        self.faults.hit("after_log_append")
        self._apply_record(rec)
        self.faults.hit("after_index_built")
        self._publish(self._versions[self._latest])
        self.faults.hit("after_publish")
        self._truncate_log()
        if self.auto_gc:
            self._gc()
        return self._latest

    # ----------------------------------------------------------- gc
    def _gc(self):
        pinned = {num for num, count in self._pins.items() if count > 0}
        keep = pinned | {self._latest}
        for num in list(self._versions):
            if num not in keep:
                del self._versions[num]
                if not self._builds:
                    self._oplog.pop(num, None)
        vdir = os.path.join(self.path, VERSIONS_DIR)
        for fname in os.listdir(vdir):
            if fname.startswith("v") and fname.endswith(".json"):
                try:
                    num = int(fname[1:-5])
                except ValueError:
                    continue
                if num not in keep and num <= self._latest:
                    try:
                        os.remove(os.path.join(vdir, fname))
                    except OSError:
                        pass

    def gc(self):
        with self._lock:
            self._gc()

    # -------------------------------------------------------- pins
    def _pin(self, num):
        with self._lock:
            self._pins[num] = self._pins.get(num, 0) + 1

    def _unpin(self, num):
        with self._lock:
            self._pins[num] = self._pins.get(num, 1) - 1

    # --------------------------------------------------------- public
    def put(self, doc_id, value):
        """Create or replace a whole document as a new version."""
        if not isinstance(doc_id, str):
            raise TypeError("doc_id must be a string")
        strictjson.dumps(value)  # validates JSON-ness of the value
        with self._lock:
            rec = {"kind": "put", "doc": doc_id, "value": value,
                   "version": self._latest + 1}
            return self._commit(rec)

    def apply(self, doc_id, ops):
        """Apply a JSON Patch batch to one document, all-or-nothing."""
        with self._lock:
            base = self._versions[self._latest]
            if doc_id not in base.docs:
                raise KeyError(doc_id)
            apply_patch(base.docs[doc_id], ops)  # validate before logging
            rec = {"kind": "patch", "doc": doc_id, "ops": ops,
                   "version": self._latest + 1}
            return self._commit(rec)

    def create_index(self, name, pattern):
        """Build an index, catch up concurrent patches, switch atomically.

        The full scan runs outside the lock against an immutable base
        version; patches committed meanwhile are replayed from the op
        log before the new index is swapped into each version's index
        map (a single dict replacement per version).
        """
        segments = tuple(pointers.parse(pattern))
        with self._lock:
            if name in self._index_defs:
                raise ValueError("index already exists: %r" % name)
            base_num = self._latest
            base_docs = self._versions[base_num].docs
            self._builds += 1
        try:
            idx = Index.build(
                name, segments, base_docs,
                on_scan=lambda doc_id: self.faults.hit("index_build_scan"),
            )
            self.faults.hit("index_build_done")
            with self._lock:
                per_version = {base_num: idx}
                current = idx
                for num in range(base_num + 1, self._latest + 1):
                    for doc_id, roots, new_doc in self._oplog.get(num, ()):
                        added = extract_pairs(new_doc, segments, roots)
                        current = current.updated(doc_id, roots, added)
                    per_version[num] = current
                self._index_defs[name] = segments
                self._persist_index_defs()
                for num, version_idx in per_version.items():
                    version = self._versions.get(num)
                    if version is not None:
                        version.indexes = dict(version.indexes, **{name: version_idx})
        finally:
            with self._lock:
                self._builds -= 1

    def _version(self, num=None):
        with self._lock:
            key = self._latest if num is None else num
            try:
                return self._versions[key]
            except KeyError:
                raise KeyError("version not available: %r" % key)

    def get(self, doc_id, version=None):
        return self._version(version).docs[doc_id]

    def query(self, query, version=None):
        ver = self._version(version)
        return run_query(ver.docs, ver.indexes, query)

    def snapshot(self, version=None):
        return Snapshot(self, self._version(version))

    def versions(self):
        with self._lock:
            return sorted(self._versions)

    @property
    def latest(self):
        with self._lock:
            return self._latest

    def index_count(self, name, version=None):
        return self._version(version).indexes[name].entry_count()

    def index_entries(self, name, version=None):
        idx = self._version(version).indexes[name]
        out = []
        for vk, pairs in idx.entries.items():
            for doc_id, path in pairs:
                out.append((doc_id, path, vk))
        return sorted(out)

    def close(self):
        pass
