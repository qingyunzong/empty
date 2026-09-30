#!/usr/bin/env python3
"""incdel: persistent incremental index with segments, tombstones and merge.

Layout of the data directory:
  manifest.json   committed manifest: {"segments": [...], "next_seg": N}
  seg_XXXXXX.json segment file: {"ops": [["add", id, text], ["del", id], ...]}
  pending.log     uncommitted add/del ops, one JSON op per line

Commit protocol (fixed order):
  1. write tmp segment, fsync, atomic rename to final segment name
  2. write manifest.tmp, fsync
  3. atomic rename manifest.tmp -> manifest.json
  4. fsync the directory

Recovery presents exactly the last complete commit: a crash before the
manifest rename rolls back to the old manifest (unreferenced segment files
are removed); a crash after the rename exposes the new state; an
interrupted merge can never yield a half-new/half-old view because the
manifest switches the segment set atomically.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

MANIFEST = "manifest.json"
MANIFEST_TMP = "manifest.tmp"
PENDING = "pending.log"
SEG_RE = re.compile(r"seg_\d+\.json\Z")
TOKEN_RE = re.compile(r"[a-z0-9]+")
TERM_RE = re.compile(r"[A-Za-z0-9_]+\Z")

EXIT_OK = 0
EXIT_QUERY = 3
EXIT_MANIFEST = 4
EXIT_CRASH = 75

CRASH_POINTS = ("pre_rename", "post_rename", "merge_mid")


class CrashError(Exception):
    """Simulated crash raised at an injected fault point."""


class ManifestCorrupt(Exception):
    pass


class QueryError(Exception):
    pass


def tokenize(text):
    return TOKEN_RE.findall(text.lower())


def parse_query(query):
    """Grammar: term (AND term)* ; term is [A-Za-z0-9_]+ (AND is a keyword)."""
    tokens = query.split()
    if not tokens:
        raise QueryError("empty query")
    terms = []
    expect_term = True
    for tok in tokens:
        if expect_term:
            if tok.upper() == "AND" or not TERM_RE.match(tok):
                raise QueryError("expected term, got %r" % tok)
            terms.append(tok.lower())
            expect_term = False
        else:
            if tok.upper() != "AND":
                raise QueryError("expected AND, got %r" % tok)
            expect_term = True
    if expect_term:
        raise QueryError("dangling AND")
    return terms


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_tmp_fsync(tmp_path, final_path, payload):
    with open(tmp_path, "wb") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, final_path)


class Store:
    def __init__(self, directory, crash_at=None):
        if crash_at is not None and crash_at not in CRASH_POINTS:
            raise ValueError("unknown crash point: %r" % crash_at)
        self.dir = directory
        self.crash_at = crash_at
        self.warnings = []
        os.makedirs(directory, exist_ok=True)
        self._recover()

    # -- crash injection -------------------------------------------------
    def _crash(self, point):
        if self.crash_at == point:
            raise CrashError(point)

    # -- recovery ----------------------------------------------------------
    def _recover(self):
        manifest_path = os.path.join(self.dir, MANIFEST)
        self.segments = []
        self.next_seg = 1
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                segments = data["segments"]
                next_seg = data["next_seg"]
                if not isinstance(segments, list) or not isinstance(next_seg, int):
                    raise ValueError("bad manifest shape")
                if not all(isinstance(s, str) for s in segments):
                    raise ValueError("bad segment name")
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                raise ManifestCorrupt(str(exc))
            self.segments = segments
            self.next_seg = next_seg
        # Roll back incomplete commits / merges: anything not referenced by
        # the (single, authoritative) manifest is removed.
        keep = set(self.segments) | {MANIFEST, PENDING}
        for name in os.listdir(self.dir):
            if name in keep:
                continue
            if name == MANIFEST_TMP or name.endswith(".tmp") or SEG_RE.match(name):
                os.unlink(os.path.join(self.dir, name))

    # -- segment loading ---------------------------------------------------
    def _load_segment(self, name):
        path = os.path.join(self.dir, name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            ops = data["ops"]
            if not isinstance(ops, list):
                raise ValueError("bad ops")
            for op in ops:
                if not (isinstance(op, list) and op and op[0] in ("add", "del")):
                    raise ValueError("bad op")
            return ops
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self.warnings.append("warning: skipping corrupt segment %s (%s)" % (name, exc))
            return []

    def _live_docs(self):
        docs = {}
        for name in self.segments:
            for op in self._load_segment(name):
                if op[0] == "add":
                    docs[op[1]] = op[2]
                else:
                    docs.pop(op[1], None)
        return docs

    # -- pending ops ---------------------------------------------------------
    def _append_pending(self, op):
        path = os.path.join(self.dir, PENDING)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(op) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def _read_pending(self):
        path = os.path.join(self.dir, PENDING)
        ops = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        ops.append(json.loads(line))
        return ops

    def add(self, doc_id, text):
        self._append_pending(["add", doc_id, text])

    def delete(self, doc_id):
        self._append_pending(["del", doc_id])

    # -- commit --------------------------------------------------------------
    def _commit_manifest(self, segments, next_seg):
        manifest = {"segments": segments, "next_seg": next_seg}
        payload = json.dumps(manifest, indent=2).encode("utf-8")
        tmp = os.path.join(self.dir, MANIFEST_TMP)
        with open(tmp, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        self._crash("pre_rename")
        os.replace(tmp, os.path.join(self.dir, MANIFEST))
        self._crash("post_rename")
        _fsync_dir(self.dir)

    def commit(self):
        """Flush pending ops into a new segment. Returns True if a commit happened."""
        ops = self._read_pending()
        if not ops:
            return False
        seg_name = "seg_%06d.json" % self.next_seg
        payload = json.dumps({"ops": ops}, indent=2).encode("utf-8")
        _write_tmp_fsync(os.path.join(self.dir, seg_name + ".tmp"),
                         os.path.join(self.dir, seg_name), payload)
        # The ops now live durably in the segment; pending log is obsolete.
        os.unlink(os.path.join(self.dir, PENDING))
        new_segments = self.segments + [seg_name]
        self._commit_manifest(new_segments, self.next_seg + 1)
        self.segments = new_segments
        self.next_seg += 1
        return True

    # -- merge ---------------------------------------------------------------
    def merge(self):
        """Compact all segments into one, physically dropping tombstoned docs."""
        if not self.segments:
            return False
        docs = self._live_docs()
        seg_name = "seg_%06d.json" % self.next_seg
        ops = [["add", doc_id, docs[doc_id]] for doc_id in sorted(docs)]
        payload = json.dumps({"ops": ops}, indent=2).encode("utf-8")
        _write_tmp_fsync(os.path.join(self.dir, seg_name + ".tmp"),
                         os.path.join(self.dir, seg_name), payload)
        old_segments = list(self.segments)
        self._commit_manifest([seg_name], self.next_seg + 1)
        # New manifest is durable; removing old segments is garbage collection.
        self._crash("merge_mid")
        for name in old_segments:
            try:
                os.unlink(os.path.join(self.dir, name))
            except FileNotFoundError:
                pass
        _fsync_dir(self.dir)
        self.segments = [seg_name]
        self.next_seg += 1
        return True

    # -- query ---------------------------------------------------------------
    def search(self, query):
        terms = parse_query(query)
        docs = self._live_docs()
        hits = [doc_id for doc_id, text in docs.items()
                if all(term in tokenize(text) for term in terms)]
        return sorted(hits)

    def dump(self):
        return self._live_docs()


def _open_store(args):
    crash_at = os.environ.get("INCDEL_CRASH_AT") or None
    try:
        return Store(args.dir, crash_at=crash_at)
    except ManifestCorrupt as exc:
        print("error: corrupt manifest: %s" % exc, file=sys.stderr)
        sys.exit(EXIT_MANIFEST)


def _emit_warnings(store):
    for warning in store.warnings:
        print(warning, file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="incdel")
    parser.add_argument("--dir", default="incdel_data", help="data directory")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add")
    p_add.add_argument("id")
    p_add.add_argument("text")
    p_del = sub.add_parser("del")
    p_del.add_argument("id")
    sub.add_parser("commit")
    p_search = sub.add_parser("search")
    p_search.add_argument("query", nargs="*")
    sub.add_parser("merge")
    sub.add_parser("dump")
    args = parser.parse_args(argv)

    store = _open_store(args)
    try:
        if args.cmd == "add":
            store.add(args.id, args.text)
            print("added %s" % args.id)
        elif args.cmd == "del":
            store.delete(args.id)
            print("deleted %s" % args.id)
        elif args.cmd == "commit":
            print("committed" if store.commit() else "nothing to commit")
        elif args.cmd == "merge":
            print("merged" if store.merge() else "nothing to merge")
        elif args.cmd == "search":
            try:
                hits = store.search(" ".join(args.query))
            except QueryError as exc:
                print("error: bad query: %s" % exc, file=sys.stderr)
                sys.exit(EXIT_QUERY)
            for doc_id in hits:
                print(doc_id)
        elif args.cmd == "dump":
            docs = store.dump()
            for doc_id in sorted(docs):
                print("%s\t%s" % (doc_id, docs[doc_id]))
    except CrashError as exc:
        print("crash injected at %s" % exc, file=sys.stderr)
        sys.exit(EXIT_CRASH)
    _emit_warnings(store)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
