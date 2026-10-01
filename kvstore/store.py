"""Single-file log-structured key-value store with nested transactions.

On-disk layout
--------------
  header:  MAGIC (8 bytes)
  record:  u32be payload_len | payload (JSON) | u32be crc32(payload)

Only outermost transactions reach the log. While a transaction is open its
writes live in memory; on outermost commit the store appends one record per
write followed by a single COMMIT record, then fsyncs. Recovery applies
only transactions terminated by a COMMIT record; anything else (torn tail,
records without COMMIT) is discarded, and a corrupt tail is truncated in
place so previously committed records stay intact.

Fault injection
---------------
Four fault points, each one-shot (consumed on first trigger):
  append_before       fail before any commit record is appended   -> E_IO
  append_after        crash after data records, before COMMIT     -> crash
  fsync_fail          fsync of the commit fails                   -> E_IO
  crash_after_commit  crash after the commit is durable           -> crash
"""

import json
import os
import struct
import zlib

from .errors import CorruptError, CrashFault, StorageError, TxnError

MAGIC = b"KVLOG001"
MAX_DEPTH = 3
MAX_RECORD = 1 << 24  # 16 MiB sanity bound for a single record payload

FAULT_POINTS = (
    "append_before",
    "append_after",
    "fsync_fail",
    "crash_after_commit",
)

_PUT = "put"
_DEL = "del"


def _encode_record(record):
    payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + payload + struct.pack(">I", crc)


class Store:
    """A transactional key-value store backed by one append-only log file."""

    def __init__(self, path, faults=None):
        self.path = path
        # Mutable set of armed fault points; each is consumed when it fires.
        self.faults = set(faults or ())
        unknown = self.faults - set(FAULT_POINTS)
        if unknown:
            raise StorageError("unknown fault point(s): %s" % ", ".join(sorted(unknown)))
        self._committed = {}
        self._stack = []  # list of write-sets: {key: ("put", value) | ("del", None)}
        self._file = None

    # ------------------------------------------------------------------ #
    # construction / recovery
    # ------------------------------------------------------------------ #

    @classmethod
    def create(cls, path, faults=None):
        """Open a fresh store, truncating any existing log."""
        store = cls(path, faults)
        store._file = open(path, "w+b")
        store._file.write(MAGIC)
        store._file.flush()
        os.fsync(store._file.fileno())
        return store

    @classmethod
    def recover(cls, path, faults=None):
        """Open an existing store and replay its log.

        Committed transactions are applied; a corrupt tail record is
        truncated without discarding earlier committed data. A non-empty
        file with a bad header is unrecoverable and raises E_CORRUPT.
        """
        if not os.path.exists(path):
            return cls.create(path, faults)
        store = cls(path, faults)
        store._file = open(path, "r+b")
        try:
            store._replay()
        except Exception:
            store.close()
            raise
        return store

    def close(self):
        if self._file is not None:
            self._file.flush()
            self._file.close()
            self._file = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # ------------------------------------------------------------------ #
    # fault injection
    # ------------------------------------------------------------------ #

    def _consume(self, point):
        """Return True (once) if the given fault point is armed."""
        if point in self.faults:
            self.faults.discard(point)
            return True
        return False

    # ------------------------------------------------------------------ #
    # transactions
    # ------------------------------------------------------------------ #

    def begin(self):
        if len(self._stack) >= MAX_DEPTH:
            raise TxnError("maximum transaction nesting depth (%d) exceeded" % MAX_DEPTH)
        self._stack.append({})

    def put(self, key, value):
        self._require_txn("put")
        if not isinstance(key, str):
            raise TxnError("keys must be strings")
        self._stack[-1][key] = (_PUT, value)

    def delete(self, key):
        self._require_txn("del")
        self._stack[-1][key] = (_DEL, None)

    def commit(self):
        """Commit the innermost transaction.

        An inner commit merges its write-set into the parent transaction.
        The outermost commit persists the write-set to the log; if the
        persist fails (append_before / fsync_fail) the whole transaction
        is aborted and nothing becomes visible.
        """
        if not self._stack:
            raise TxnError("commit without an active transaction")
        writes = self._stack.pop()
        if self._stack:
            self._stack[-1].update(writes)
            return
        self._persist(writes)  # raises on failure; txn is then fully aborted

    def rollback(self):
        """Abort the innermost transaction, discarding only its own layer."""
        if not self._stack:
            raise TxnError("rollback without an active transaction")
        self._stack.pop()

    def _require_txn(self, op):
        if not self._stack:
            raise TxnError("%s without an active transaction" % op)

    # ------------------------------------------------------------------ #
    # views
    # ------------------------------------------------------------------ #

    def view(self):
        """The currently visible view: committed state plus open txn layers."""
        visible = dict(self._committed)
        for writes in self._stack:
            for key, (op, value) in writes.items():
                if op == _PUT:
                    visible[key] = value
                else:
                    visible.pop(key, None)
        return visible

    # ------------------------------------------------------------------ #
    # persistence
    # ------------------------------------------------------------------ #

    def _persist(self, writes):
        if self._consume("append_before"):
            raise StorageError("injected fault: append_before")

        offset = self._end_offset()
        blob = bytearray()
        for key in sorted(writes):
            op, value = writes[key]
            if op == _PUT:
                blob += _encode_record({"op": "put", "k": key, "v": value})
            else:
                blob += _encode_record({"op": "del", "k": key})
        self._file.write(bytes(blob))
        self._file.flush()  # data records reach the OS before COMMIT

        if self._consume("append_after"):
            raise CrashFault("append_after")

        self._file.write(_encode_record({"op": "commit"}))
        try:
            self._fsync()
        except StorageError:
            # Whole transaction aborts: strip its partial records so no
            # part of it can ever become visible after recovery.
            self._truncate(offset)
            raise

        # Durable: apply to committed state.
        for key, (op, value) in writes.items():
            if op == _PUT:
                self._committed[key] = value
            else:
                self._committed.pop(key, None)

        if self._consume("crash_after_commit"):
            raise CrashFault("crash_after_commit")

    def _fsync(self):
        self._file.flush()
        if self._consume("fsync_fail"):
            raise StorageError("injected fault: fsync_fail")
        try:
            os.fsync(self._file.fileno())
        except OSError as exc:
            raise StorageError("fsync failed: %s" % exc)

    def _end_offset(self):
        self._file.seek(0, os.SEEK_END)
        return self._file.tell()

    def _truncate(self, offset):
        self._file.truncate(offset)
        self._file.seek(0, os.SEEK_END)
        self._file.flush()
        os.fsync(self._file.fileno())

    # ------------------------------------------------------------------ #
    # recovery
    # ------------------------------------------------------------------ #

    def _replay(self):
        f = self._file
        f.seek(0)
        magic = f.read(len(MAGIC))
        if magic != MAGIC:
            if magic == b"" and os.fstat(f.fileno()).st_size == 0:
                f.write(MAGIC)
                f.flush()
                os.fsync(f.fileno())
                return
            raise CorruptError("bad log header in %s" % self.path)

        pending = []
        while True:
            offset = f.tell()
            header = f.read(4)
            if header == b"":
                break  # clean EOF
            record = self._read_record(offset, header)
            if record is None:
                # Corrupt tail: truncate; committed records before it survive.
                self._truncate(offset)
                break
            if record["op"] == "commit":
                for rec in pending:
                    self._apply(rec)
                pending = []
            else:
                pending.append(record)
        # Leftover pending records belong to a txn that never committed.
        f.seek(0, os.SEEK_END)

    def _read_record(self, offset, header):
        f = self._file
        if len(header) < 4:
            return None
        (length,) = struct.unpack(">I", header)
        if length == 0 or length > MAX_RECORD:
            return None
        payload = f.read(length)
        if len(payload) < length:
            return None
        crc_raw = f.read(4)
        if len(crc_raw) < 4:
            return None
        (crc,) = struct.unpack(">I", crc_raw)
        if crc != zlib.crc32(payload) & 0xFFFFFFFF:
            return None
        try:
            record = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        if not isinstance(record, dict) or record.get("op") not in ("put", "del", "commit"):
            return None
        return record

    def _apply(self, record):
        if record["op"] == "put":
            self._committed[record["k"]] = record["v"]
        else:
            self._committed.pop(record["k"], None)
