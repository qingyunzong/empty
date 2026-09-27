"""incdel - persistent incremental index with segments, tombstones and
crash-safe commits.

Storage layout inside the data directory:
  manifest.json        current manifest (checksummed JSON)
  seg_NNNNNN.seg       segment files, each a checksummed JSON document of
                       {"id", "text", "seq"} records
  pending.json         uncommitted add/del operations (best effort; lost on crash)

Commit protocol (fixed order):
  1. write tmp segment, fsync, rename to final segment name
  2. write manifest.tmp, fsync
  3. atomic rename manifest.tmp -> manifest.json   (commit point)
  4. fsync the directory

Fault injection points (arm via INCDEL_FAIL_AT env var or arm_fault()):
  before_rename  - after manifest.tmp fsync, before the atomic rename
  after_rename   - after the atomic rename, before the directory fsync
  merge_mid      - mid-merge: after the merge commit, while deleting
                   obsolete segment files

Exit codes: 0 ok, 2 usage, 3 query syntax error, 4 corrupt manifest,
99 injected crash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

MANIFEST_NAME = "manifest.json"
MANIFEST_TMP_NAME = MANIFEST_NAME + ".tmp"
PENDING_NAME = "pending.json"
PENDING_TMP_NAME = PENDING_NAME + ".tmp"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_QUERY_SYNTAX = 3
EXIT_MANIFEST_CORRUPT = 4
EXIT_CRASH = 99

FAULT_POINTS = ("before_rename", "after_rename", "merge_mid")

_TERM_RE = re.compile(r"[A-Za-z0-9_]+")


class CrashFault(Exception):
    """Simulates a hard process crash at an injected fault point."""

    def __init__(self, point):
        super().__init__("injected crash at fault point: %s" % point)
        self.point = point


class ManifestCorrupt(Exception):
    pass


class QuerySyntaxError(Exception):
    pass


_armed_fault = None


def arm_fault(point):
    """Arm a one-shot fault injection point (None disarms)."""
    global _armed_fault
    if point is not None and point not in FAULT_POINTS:
        raise ValueError("unknown fault point: %r (choose from %s)"
                         % (point, ", ".join(FAULT_POINTS)))
    _armed_fault = point


def _maybe_fault(point):
    global _armed_fault
    if _armed_fault == point:
        _armed_fault = None
        raise CrashFault(point)


def _checksum(payload):
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _wrap(payload):
    return {"payload": payload, "checksum": _checksum(payload)}


def _read_checked(path):
    """Return payload if the file parses and its checksum matches, else None."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            body = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(body, dict) or "payload" not in body or "checksum" not in body:
        return None
    if body["checksum"] != _checksum(body["payload"]):
        return None
    return body["payload"]


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_segment_file(dirpath, name, records):
    payload = {"records": records}
    tmp = os.path.join(dirpath, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_wrap(payload), fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, os.path.join(dirpath, name))


def _read_segment_file(path):
    payload = _read_checked(path)
    if payload is None or not isinstance(payload, dict):
        return None
    records = payload.get("records")
    if not isinstance(records, list):
        return None
    out = {}
    for rec in records:
        if (not isinstance(rec, dict) or not isinstance(rec.get("id"), str)
                or not isinstance(rec.get("text"), str)
                or not isinstance(rec.get("seq"), int)):
            return None
        out[rec["id"]] = (rec["seq"], rec["text"])
    return out


def _commit_manifest(dirpath, manifest):
    """Steps 2-4 of the commit protocol (segment already durable)."""
    tmp = os.path.join(dirpath, MANIFEST_TMP_NAME)
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_wrap(manifest), fh)
        fh.flush()
        os.fsync(fh.fileno())
    _maybe_fault("before_rename")
    os.replace(tmp, os.path.join(dirpath, MANIFEST_NAME))
    _maybe_fault("after_rename")
    _fsync_dir(dirpath)


def _valid_manifest(payload):
    return (isinstance(payload, dict)
            and isinstance(payload.get("segments"), list)
            and all(isinstance(s, str) for s in payload["segments"])
            and isinstance(payload.get("tombstones"), dict)
            and isinstance(payload.get("next_seq"), int)
            and isinstance(payload.get("next_seg"), int))


class Index:
    def __init__(self, dirpath):
        self.dir = dirpath
        os.makedirs(dirpath, exist_ok=True)
        self.warnings = []
        self._segments = []      # list of (name, {id: (seq, text)})
        self.tombstones = {}     # id -> seq (committed, not yet merged)
        self.next_seq = 0
        self.next_seg = 0
        self.pending_adds = {}   # id -> (seq, text)
        self.pending_dels = {}   # id -> seq
        self._load()

    # ---------------- recovery ----------------

    def _load(self):
        entries = set(os.listdir(self.dir))
        manifest = None
        if MANIFEST_NAME in entries:
            payload = _read_checked(os.path.join(self.dir, MANIFEST_NAME))
            if payload is None or not _valid_manifest(payload):
                raise ManifestCorrupt(
                    "manifest.json is unreadable or fails its checksum")
            manifest = payload
        if manifest is None:
            manifest = {"segments": [], "tombstones": {},
                        "next_seq": 0, "next_seg": 0}

        referenced = set(manifest["segments"])
        on_disk = {f for f in entries if f.endswith(".seg")}
        orphans = on_disk - referenced
        missing = referenced - on_disk
        crash_evidence = (MANIFEST_TMP_NAME in entries
                          or any(f.endswith(".seg.tmp") for f in entries)
                          or bool(orphans) or bool(missing))

        # Roll back to the last complete commit: drop leftover tmp files and
        # segments that no committed manifest references.
        for junk in entries:
            if (junk == MANIFEST_TMP_NAME or junk == PENDING_TMP_NAME
                    or junk.endswith(".seg.tmp")):
                os.remove(os.path.join(self.dir, junk))
        for name in sorted(orphans):
            os.remove(os.path.join(self.dir, name))
        if crash_evidence:
            # Uncommitted operations belong to the failed commit: drop them
            # so recovery presents exactly the last complete commit.
            stale_pending = os.path.join(self.dir, PENDING_NAME)
            if os.path.exists(stale_pending):
                os.remove(stale_pending)
            _fsync_dir(self.dir)
        for name in sorted(missing):
            self.warnings.append(
                "segment %s referenced by manifest is missing" % name)

        for name in manifest["segments"]:
            if name in missing:
                continue
            recs = _read_segment_file(os.path.join(self.dir, name))
            if recs is None:
                self.warnings.append("skipping corrupt segment %s" % name)
                continue
            self._segments.append((name, recs))

        self.tombstones = {str(k): int(v)
                           for k, v in manifest["tombstones"].items()}
        self.next_seq = manifest["next_seq"]
        self.next_seg = manifest["next_seg"]

        # Uncommitted operations survive a clean shutdown only; a crash
        # discards them so recovery presents the last complete commit.
        if not crash_evidence and PENDING_NAME in entries:
            payload = _read_checked(os.path.join(self.dir, PENDING_NAME))
            if payload is None:
                self.warnings.append("discarding corrupt pending.json")
            else:
                for item in payload.get("adds", []):
                    if item["seq"] >= self.next_seq:
                        self.pending_adds[item["id"]] = (item["seq"], item["text"])
                for item in payload.get("dels", []):
                    if item["seq"] >= self.next_seq:
                        self.pending_dels[item["id"]] = item["seq"]

    def _save_pending(self):
        path = os.path.join(self.dir, PENDING_NAME)
        if not self.pending_adds and not self.pending_dels:
            if os.path.exists(path):
                os.remove(path)
                _fsync_dir(self.dir)
            return
        payload = {
            "adds": [{"id": i, "text": t, "seq": s}
                     for i, (s, t) in self.pending_adds.items()],
            "dels": [{"id": i, "seq": s} for i, s in self.pending_dels.items()],
        }
        tmp = os.path.join(self.dir, PENDING_TMP_NAME)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_wrap(payload), fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(self.dir)

    # ---------------- operations ----------------

    def add(self, doc_id, text):
        self.pending_adds[doc_id] = (self.next_seq, text)
        self.next_seq += 1
        self._save_pending()

    def delete(self, doc_id):
        self.pending_dels[doc_id] = self.next_seq
        self.next_seq += 1
        self._save_pending()

    def _manifest(self):
        return {
            "segments": [name for name, _ in self._segments],
            "tombstones": dict(self.tombstones),
            "next_seq": self.next_seq,
            "next_seg": self.next_seg,
        }

    def commit(self):
        manifest = self._manifest()
        new_seg = None
        records = []
        if self.pending_adds:
            new_seg = "seg_%06d.seg" % self.next_seg
            records = [{"id": i, "text": t, "seq": s}
                       for i, (s, t) in sorted(self.pending_adds.items(),
                                               key=lambda kv: kv[1][0])]
            _write_segment_file(self.dir, new_seg, records)
            manifest["segments"] = manifest["segments"] + [new_seg]
            manifest["next_seg"] += 1
        for doc_id, seq in self.pending_dels.items():
            prev = manifest["tombstones"].get(doc_id)
            if prev is None or seq > prev:
                manifest["tombstones"][doc_id] = seq
        manifest["next_seq"] = self.next_seq
        _commit_manifest(self.dir, manifest)
        if new_seg is not None:
            self._segments.append(
                (new_seg, {r["id"]: (r["seq"], r["text"]) for r in records}))
        self.tombstones = dict(manifest["tombstones"])
        self.next_seg = manifest["next_seg"]
        self.pending_adds.clear()
        self.pending_dels.clear()
        self._save_pending()

    def merge(self):
        """Compact all segments into one, physically dropping tombstoned and
        superseded records, then clear the tombstone list."""
        latest = self._latest()
        visible = {i: st for i, st in latest.items()
                   if self._del_seq(i) is None or self._del_seq(i) < st[0]}
        old_names = [name for name, _ in self._segments]
        manifest = self._manifest()
        new_seg = None
        records = []
        if visible:
            new_seg = "seg_%06d.seg" % self.next_seg
            records = [{"id": i, "text": t, "seq": s}
                       for i, (s, t) in sorted(visible.items(),
                                               key=lambda kv: kv[1][0])]
            _write_segment_file(self.dir, new_seg, records)
            manifest["segments"] = [new_seg]
            manifest["next_seg"] += 1
        else:
            manifest["segments"] = []
        manifest["tombstones"] = {}
        manifest["next_seq"] = self.next_seq
        _commit_manifest(self.dir, manifest)
        # Obsolete segments are removed only after the new manifest is the
        # commit point, so a crash here can never expose a half-merged state.
        removed = 0
        for name in old_names:
            os.remove(os.path.join(self.dir, name))
            removed += 1
            if removed == 1:
                _maybe_fault("merge_mid")
        if old_names:
            _fsync_dir(self.dir)
        if new_seg is not None:
            self._segments = [(new_seg, {r["id"]: (r["seq"], r["text"])
                                         for r in records})]
        else:
            self._segments = []
        self.tombstones = {}
        self.next_seg = manifest["next_seg"]
        self.pending_adds.clear()
        self.pending_dels.clear()
        self._save_pending()

    # ---------------- queries ----------------

    def _latest(self):
        best = {}
        for _name, recs in self._segments:
            for doc_id, (seq, text) in recs.items():
                cur = best.get(doc_id)
                if cur is None or seq > cur[0]:
                    best[doc_id] = (seq, text)
        for doc_id, (seq, text) in self.pending_adds.items():
            cur = best.get(doc_id)
            if cur is None or seq > cur[0]:
                best[doc_id] = (seq, text)
        return best

    def _del_seq(self, doc_id):
        seqs = [s for s in (self.tombstones.get(doc_id),
                            self.pending_dels.get(doc_id)) if s is not None]
        return max(seqs) if seqs else None

    def visible_docs(self):
        out = {}
        for doc_id, (seq, text) in self._latest().items():
            del_seq = self._del_seq(doc_id)
            if del_seq is not None and del_seq > seq:
                continue
            out[doc_id] = text
        return out

    def search(self, query):
        terms = parse_query(query)
        hits = []
        for doc_id, text in self.visible_docs().items():
            tokens = {t.lower() for t in _TERM_RE.findall(text)}
            if all(t in tokens for t in terms):
                hits.append(doc_id)
        return sorted(hits)


def parse_query(query):
    terms = query.split()
    if not terms:
        raise QuerySyntaxError("empty query")
    for term in terms:
        if not _TERM_RE.fullmatch(term):
            raise QuerySyntaxError("invalid term: %r" % term)
    return [t.lower() for t in terms]


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="incdel",
        description="persistent incremental index (segments + tombstones)")
    parser.add_argument("--dir", required=True, help="data directory")
    sub = parser.add_subparsers(dest="command", required=True)
    p_add = sub.add_parser("add", help="stage add of id/text")
    p_add.add_argument("id")
    p_add.add_argument("text", nargs="+")
    p_del = sub.add_parser("del", help="stage tombstone for id")
    p_del.add_argument("id")
    sub.add_parser("commit", help="durably commit staged operations")
    p_search = sub.add_parser("search", help="AND-search space-separated terms")
    p_search.add_argument("query", nargs="+")
    sub.add_parser("merge", help="compact segments, drop tombstoned records")
    sub.add_parser("dump", help="print visible id<TAB>text pairs")
    args = parser.parse_args(argv)

    arm_fault(os.environ.get("INCDEL_FAIL_AT"))

    try:
        index = Index(args.dir)
    except ManifestCorrupt as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_MANIFEST_CORRUPT
    for warning in index.warnings:
        print("warning: %s" % warning, file=sys.stderr)

    try:
        if args.command == "add":
            index.add(args.id, " ".join(args.text))
        elif args.command == "del":
            index.delete(args.id)
        elif args.command == "commit":
            index.commit()
        elif args.command == "merge":
            index.merge()
        elif args.command == "search":
            try:
                hits = index.search(" ".join(args.query))
            except QuerySyntaxError as exc:
                print("error: bad query: %s" % exc, file=sys.stderr)
                return EXIT_QUERY_SYNTAX
            for doc_id in hits:
                print(doc_id)
        elif args.command == "dump":
            for doc_id, text in sorted(index.visible_docs().items()):
                print("%s\t%s" % (doc_id, text))
    except CrashFault as exc:
        print("CRASH: injected fault at %s" % exc.point, file=sys.stderr)
        os._exit(EXIT_CRASH)  # hard crash: no cleanup, like a real failure
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
