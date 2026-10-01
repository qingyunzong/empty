"""Simplified Serializable Snapshot Isolation (SSI).

Semantics:
  * Every transaction records a read set and a write set.
  * Two transactions are *concurrent* iff their snapshot intervals
    [begin_ts, commit_ts] overlap.
  * Write-write conflicts between concurrent transactions are resolved
    first-committer-wins: the later committer aborts with WRITE_CONFLICT.
  * At commit time the engine looks for a dangerous structure: a cycle of
    rw-antidependencies (T1 reads a key T2 writes while T2 reads a key T1
    writes, possibly through a longer chain of concurrent transactions).
    If committing the current transaction would close such a cycle, the
    committer aborts with SERIALIZATION_FAILURE.
  * Read-only transactions never abort.
"""

SERIALIZATION_FAILURE = "SERIALIZATION_FAILURE"
WRITE_CONFLICT = "WRITE_CONFLICT"


class SSIError(Exception):
    """Raised for protocol-level errors (unknown transaction, etc.)."""


class Transaction:
    __slots__ = ("id", "begin_ts", "commit_ts", "read_set", "write_set",
                 "read_only", "status")

    def __init__(self, tx_id, begin_ts):
        self.id = tx_id
        self.begin_ts = begin_ts
        self.commit_ts = None
        self.read_set = set()
        self.write_set = {}  # key -> value (insertion ordered)
        self.read_only = True
        self.status = "active"  # active | committed | aborted

    def concurrent(self, other):
        """True iff the snapshot intervals of the two transactions overlap."""
        self_end = self.commit_ts if self.commit_ts is not None else float("inf")
        other_end = other.commit_ts if other.commit_ts is not None else float("inf")
        return self.begin_ts < other_end and other.begin_ts < self_end


class Engine:
    """A single-version-store engine executing transactions under SSI."""

    def __init__(self):
        self._clock = 0
        self._versions = {}   # key -> list of (commit_ts, value), ascending
        self._txs = {}        # tx id -> Transaction
        self._committed = []  # committed transactions, in commit order
        self._next_id = 0

    def _tick(self):
        self._clock += 1
        return self._clock

    def begin(self, tx_id=None):
        if tx_id is None:
            self._next_id += 1
            tx_id = "tx%d" % self._next_id
        existing = self._txs.get(tx_id)
        if existing is not None and existing.status == "active":
            raise SSIError("transaction %r is already active" % tx_id)
        tx = Transaction(tx_id, self._tick())
        self._txs[tx_id] = tx
        return tx

    def _active(self, tx_id):
        tx = self._txs.get(tx_id)
        if tx is None:
            raise SSIError("unknown transaction %r" % tx_id)
        if tx.status != "active":
            raise SSIError("transaction %r is not active (%s)" % (tx_id, tx.status))
        return tx

    def read(self, tx_id, key):
        tx = self._active(tx_id)
        tx.read_set.add(key)
        if key in tx.write_set:
            return tx.write_set[key]
        for ts, value in reversed(self._versions.get(key, [])):
            if ts <= tx.begin_ts:
                return value
        return None

    def write(self, tx_id, key, value):
        tx = self._active(tx_id)
        tx.write_set[key] = value
        tx.read_only = False

    def abort(self, tx_id):
        tx = self._active(tx_id)
        tx.status = "aborted"

    def commit(self, tx_id):
        """Commit `tx_id`. Returns None on success, or an error code string."""
        tx = self._active(tx_id)
        if not tx.read_only:
            # First-committer-wins for write-write conflicts.
            for other in self._committed:
                if other.concurrent(tx) and not tx.write_set.keys().isdisjoint(other.write_set):
                    tx.status = "aborted"
                    return WRITE_CONFLICT
            # Dangerous structure: would this commit close an rw-antidependency cycle?
            if self._closes_cycle(tx):
                tx.status = "aborted"
                return SERIALIZATION_FAILURE
            tx.commit_ts = self._tick()
            for key, value in tx.write_set.items():
                self._versions.setdefault(key, []).append((tx.commit_ts, value))
        else:
            tx.commit_ts = self._tick()
        tx.status = "committed"
        self._committed.append(tx)
        return None

    def _closes_cycle(self, tx):
        """True iff adding `tx` to the committed set closes a cycle of
        rw-antidependency edges between concurrent transactions.

        Edge U -> V exists when U and V are concurrent and U reads a key
        that V writes (U did not see V's write, so U must precede V in any
        equivalent serial order).
        """
        nodes = [o for o in self._committed if o.concurrent(tx)]
        nodes.append(tx)
        adj = {n.id: set() for n in nodes}
        for u in nodes:
            for v in nodes:
                if u is v:
                    continue
                if u.concurrent(v) and not u.read_set.isdisjoint(v.write_set):
                    adj[u.id].add(v.id)
        # The committed set alone is acyclic, so any new cycle passes through
        # tx: search for a path from a successor of tx back to tx.
        stack = list(adj[tx.id])
        seen = set()
        while stack:
            cur = stack.pop()
            if cur == tx.id:
                return True
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(adj[cur])
        return False

    def snapshot(self):
        """Current committed state of the store (latest version per key)."""
        return {key: versions[-1][1] for key, versions in self._versions.items()}
