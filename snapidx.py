"""snapidx: in-memory snapshot index with optional write-ahead persistence.

Semantics:
  - begin/commit/rollback form a transaction stack (nesting allowed).
  - Inner commit merges changes into the parent layer; only the outermost
    commit touches committed state, bumps the commit sequence, snapshots,
    and appends to the log.
  - Committing an empty transaction is legal and does not bump the sequence.
  - rollback discards only the current (innermost) layer.
  - Uncommitted changes are invisible to every snapshot; a commit only
    affects snapshots taken after it.
  - del of a missing id is a no-op; re-add of the same id overwrites.
  - Persistence: records are appended only at outermost commit. Recovery
    replays complete records, ignores uncommitted records, and discards a
    trailing half-written record with a warning.
"""

from __future__ import annotations

import json
import os
import sys
import threading

_DELETED = object()


class SnapIdxError(Exception):
    """Base error; CLI maps it to exit code 3."""


class UnknownSnapshotError(SnapIdxError):
    pass


class NoTransactionError(SnapIdxError):
    pass


class SnapIdx:
    def __init__(self, log_path: str | None = None, warn=None):
        self._committed: dict[str, str] = {}
        self._seq = 0
        self._snapshots: dict[int, dict[str, str]] = {0: {}}
        self._tx_stack: list[dict[str, object]] = []
        self._log_path = log_path
        self._warn = warn if warn is not None else (
            lambda msg: print(msg, file=sys.stderr))
        self._lock = threading.RLock()
        if log_path is not None:
            self._recover()

    # -- transactions -----------------------------------------------------

    def begin(self) -> None:
        with self._lock:
            self._tx_stack.append({})

    def commit(self) -> int:
        """Commit the innermost transaction; returns the commit sequence."""
        with self._lock:
            if not self._tx_stack:
                raise NoTransactionError("commit without active transaction")
            layer = self._tx_stack.pop()
            if self._tx_stack:
                # Nested commit: merge into parent layer, nothing else.
                self._tx_stack[-1].update(layer)
                return self._seq
            if not layer:
                # Empty transaction: legal, sequence does not advance.
                return self._seq
            self._apply(layer, self._committed)
            self._seq += 1
            self._snapshots[self._seq] = dict(self._committed)
            if self._log_path is not None:
                self._append_log(layer, self._seq)
            return self._seq

    def rollback(self) -> None:
        """Discard only the innermost transaction layer."""
        with self._lock:
            if not self._tx_stack:
                raise NoTransactionError("rollback without active transaction")
            self._tx_stack.pop()

    # -- mutations ----------------------------------------------------------

    def add(self, doc_id: str, text: str) -> None:
        with self._lock:
            if self._tx_stack:
                self._tx_stack[-1][doc_id] = text
            else:
                # Implicit single-operation transaction.
                self.begin()
                self._tx_stack[-1][doc_id] = text
                self.commit()

    def delete(self, doc_id: str) -> None:
        with self._lock:
            if doc_id not in self._view():
                return  # no-op
            if self._tx_stack:
                self._tx_stack[-1][doc_id] = _DELETED
            else:
                self.begin()
                self._tx_stack[-1][doc_id] = _DELETED
                self.commit()

    # -- queries ------------------------------------------------------------

    @property
    def sequence(self) -> int:
        return self._seq

    def search(self, term: str, snapshot: int | None = None) -> list[str]:
        with self._lock:
            if snapshot is None:
                data = self._view()
            else:
                if snapshot not in self._snapshots:
                    raise UnknownSnapshotError(f"unknown snapshot: {snapshot}")
                data = self._snapshots[snapshot]
            return sorted(k for k, v in data.items() if term in v)

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _apply(layer: dict[str, object], target: dict[str, str]) -> None:
        for key, value in layer.items():
            if value is _DELETED:
                target.pop(key, None)
            else:
                target[key] = value  # type: ignore[assignment]

    def _view(self) -> dict[str, str]:
        view = dict(self._committed)
        for layer in self._tx_stack:
            self._apply(layer, view)
        return view

    def _append_log(self, layer: dict[str, object], seq: int) -> None:
        records = []
        for key, value in layer.items():
            if value is _DELETED:
                records.append({"op": "del", "id": key})
            else:
                records.append({"op": "add", "id": key, "text": value})
        records.append({"commit": seq})
        with open(self._log_path, "a", encoding="utf-8") as fh:
            for record in records:
                fh.write(json.dumps(record) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def _recover(self) -> None:
        if not os.path.exists(self._log_path):
            return
        with open(self._log_path, "rb") as fh:
            raw = fh.read()
        pending: list[dict] = []
        for line in raw.split(b"\n"):
            if not line:
                continue  # trailing newline / blank padding
            try:
                record = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._warn(
                    f"snapidx: discarding incomplete log record: {line!r}")
                break
            if not isinstance(record, dict):
                self._warn(f"snapidx: discarding malformed log record: {line!r}")
                break
            if "commit" in record:
                # Only records sealed by a commit marker are applied;
                # anything left in `pending` afterwards is uncommitted and
                # therefore ignored.
                for op in pending:
                    if op.get("op") == "add":
                        self._committed[op["id"]] = op["text"]
                    elif op.get("op") == "del":
                        self._committed.pop(op["id"], None)
                pending = []
                self._seq = int(record["commit"])
                self._snapshots[self._seq] = dict(self._committed)
            else:
                pending.append(record)


# -- CLI --------------------------------------------------------------------

EXIT_ERROR = 3


def _run_repl(db: SnapIdx, instream, outstream) -> int:
    for line in instream:
        parts = line.split()
        if not parts:
            continue
        cmd, args = parts[0], parts[1:]
        try:
            if cmd == "begin":
                db.begin()
                print("ok", file=outstream)
            elif cmd == "add":
                doc_id, text = args[0], " ".join(args[1:])
                db.add(doc_id, text)
                print("ok", file=outstream)
            elif cmd == "del":
                db.delete(args[0])
                print("ok", file=outstream)
            elif cmd == "commit":
                print(f"seq {db.commit()}", file=outstream)
            elif cmd == "rollback":
                db.rollback()
                print("ok", file=outstream)
            elif cmd == "search":
                snapshot = None
                term_args = list(args)
                if "--snapshot" in term_args:
                    idx = term_args.index("--snapshot")
                    snapshot = int(term_args[idx + 1])
                    term_args = term_args[:idx]
                hits = db.search(" ".join(term_args), snapshot=snapshot)
                print(" ".join(hits), file=outstream)
            elif cmd in ("exit", "quit"):
                return 0
            else:
                print(f"error: unknown command: {cmd}", file=sys.stderr)
                return EXIT_ERROR
        except SnapIdxError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        except (IndexError, ValueError) as exc:
            print(f"error: bad arguments for {cmd}: {exc}", file=sys.stderr)
            return EXIT_ERROR
    return 0


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="snapidx",
        description="In-memory snapshot index; reads commands from stdin.")
    parser.add_argument("--log", metavar="PATH", default=None,
                        help="write-ahead log used for commit persistence")
    ns = parser.parse_args(argv)
    db = SnapIdx(log_path=ns.log)
    return _run_repl(db, sys.stdin, sys.stdout)


if __name__ == "__main__":
    sys.exit(main())
