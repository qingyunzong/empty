"""Simplified Serializable Snapshot Isolation (SSI) transaction engine.

Semantics:
  * Every transaction records its read set and write set.
  * Reads come from the snapshot as of the transaction's begin timestamp
    (plus the transaction's own buffered writes).
  * Write/write conflicts are resolved first-committer-wins: the later
    committer of the same key aborts with WRITE_CONFLICT.
  * At commit time the engine looks for the dangerous structure: a pair of
    concurrent transactions T1, T2 where T1 read a key T2 wrote and T2 read
    a key T1 wrote (a cycle of rw-antidependencies).  The current committer
    aborts with SERIALIZATION_FAILURE.
  * Two transactions are concurrent iff their [begin, commit] intervals
    overlap.
  * Read-only transactions never abort.
"""

WRITE_CONFLICT = "WRITE_CONFLICT"
SERIALIZATION_FAILURE = "SERIALIZATION_FAILURE"


class WriteConflict(Exception):
    """Another transaction committed a write to the same key first."""

    code = WRITE_CONFLICT


class SerializationFailure(Exception):
    """A dangerous rw-antidependency cycle was detected at commit."""

    code = SERIALIZATION_FAILURE


class UnknownTransaction(Exception):
    """The transaction id does not refer to an active transaction."""

    code = "UNKNOWN_TRANSACTION"


class _Txn:
    __slots__ = ("tid", "begin_ts", "commit_ts", "read_set", "write_set", "status")

    def __init__(self, tid, begin_ts):
        self.tid = tid
        self.begin_ts = begin_ts
        self.commit_ts = None
        self.read_set = {}    # key -> value observed in the snapshot
        self.write_set = {}   # key -> buffered value
        self.status = "active"

    @property
    def read_only(self):
        return not self.write_set


class Engine:
    def __init__(self, initial=None):
        self._clock = 0
        self._history = {}  # key -> list of (commit_ts, value), ascending
        for key, value in (initial or {}).items():
            self._history[key] = [(0, value)]
        self._txns = {}
        self._committed_writers = []  # committed txns that had writes
        self._next_tid = 1

    # -- transaction lifecycle -------------------------------------------

    def begin(self):
        tid = self._next_tid
        self._next_tid += 1
        self._txns[tid] = _Txn(tid, self._clock)
        return tid

    def read(self, tid, key):
        txn = self._active(tid)
        if key in txn.write_set:
            return txn.write_set[key]
        if key not in txn.read_set:
            txn.read_set[key] = self._snapshot_read(key, txn.begin_ts)
        return txn.read_set[key]

    def write(self, tid, key, value):
        self._active(tid).write_set[key] = value

    def commit(self, tid):
        txn = self._active(tid)
        if txn.read_only:
            # Read-only transactions never abort.
            txn.status = "committed"
            txn.commit_ts = self._clock
            return "OK"
        self._check_write_conflicts(txn)
        self._check_dangerous_structure(txn)
        self._clock += 1
        txn.commit_ts = self._clock
        txn.status = "committed"
        for key, value in txn.write_set.items():
            self._history.setdefault(key, []).append((self._clock, value))
        self._committed_writers.append(txn)
        return "OK"

    def abort(self, tid):
        self._active(tid).status = "aborted"

    # -- conflict detection ----------------------------------------------

    def _check_write_conflicts(self, txn):
        for key in txn.write_set:
            versions = self._history.get(key)
            if versions and versions[-1][0] > txn.begin_ts:
                txn.status = "aborted"
                raise WriteConflict(
                    f"key {key!r} was committed by another transaction "
                    f"after T{txn.tid} began"
                )

    def _check_dangerous_structure(self, txn):
        for other in self._committed_writers:
            if not self._concurrent(txn, other):
                continue
            # rw-antidependency in both directions -> cycle.
            if set(txn.read_set) & set(other.write_set) and \
                    set(other.read_set) & set(txn.write_set):
                txn.status = "aborted"
                raise SerializationFailure(
                    f"rw-antidependency cycle between T{txn.tid} and "
                    f"T{other.tid}"
                )

    @staticmethod
    def _concurrent(txn, other):
        # Intervals [begin_ts, commit_ts] overlap.  ``other`` is already
        # committed (before txn's commit), so overlap reduces to: other did
        # not commit before txn's snapshot was taken.
        return other.commit_ts > txn.begin_ts

    # -- helpers ----------------------------------------------------------

    def _active(self, tid):
        txn = self._txns.get(tid)
        if txn is None or txn.status != "active":
            raise UnknownTransaction(f"no active transaction with id {tid}")
        return txn

    def _snapshot_read(self, key, ts):
        value = None
        for commit_ts, version in self._history.get(key, ()):  # ascending
            if commit_ts > ts:
                break
            value = version
        return value

    def set(self, key, value):
        """Directly commit a value outside any transaction (test setup)."""
        self._clock += 1
        self._history.setdefault(key, []).append((self._clock, value))

    def dump(self):
        """Return the latest committed value of every key."""
        return {key: versions[-1][1] for key, versions in self._history.items()}
