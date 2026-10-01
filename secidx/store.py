"""secidx: row store (pk, fields) with transactional secondary indexes.

Semantics:
- Index entries commit in the same transaction as the row writes; the
  committed state never has an index entry pointing at a missing row nor
  a live row missing from an index.
- A unique-index conflict fails the whole transaction with
  UNIQUE_VIOLATION and leaves no partial effects (the transaction is
  rolled back).
- Uncommitted index entries are invisible to other transactions, but a
  transaction sees its own uncommitted writes and its unique checks
  account for them.
- delete removes index entries; update is delete-old + insert-new.
- Rows whose indexed field is absent or JSON null are not indexed
  (SQL NULL semantics for unique indexes).
"""

__all__ = [
    "SecIdxError", "UniqueViolation", "TxnNotActive", "NoSuchTxn",
    "NoSuchIndex", "IndexExists", "PkExists", "PkNotFound", "BadRequest",
    "freeze", "Store",
]


class SecIdxError(Exception):
    code = "INTERNAL"


class UniqueViolation(SecIdxError):
    code = "UNIQUE_VIOLATION"


class TxnNotActive(SecIdxError):
    code = "TXN_NOT_ACTIVE"


class NoSuchTxn(SecIdxError):
    code = "NO_SUCH_TXN"


class NoSuchIndex(SecIdxError):
    code = "NO_SUCH_INDEX"


class IndexExists(SecIdxError):
    code = "INDEX_EXISTS"


class PkExists(SecIdxError):
    code = "PK_EXISTS"


class PkNotFound(SecIdxError):
    code = "PK_NOT_FOUND"


class BadRequest(SecIdxError):
    code = "BAD_REQUEST"


def freeze(value):
    """Canonical hashable + totally ordered form of any JSON value."""
    if value is None:
        return ("null",)
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, (int, float)):
        return ("num", value)
    if isinstance(value, str):
        return ("str", value)
    if isinstance(value, list):
        return ("list", tuple(freeze(v) for v in value))
    if isinstance(value, dict):
        return ("dict", tuple(sorted((str(k), freeze(v)) for k, v in value.items())))
    raise BadRequest("unsupported value type: %s" % type(value).__name__)


def _check_pk(pk):
    if not isinstance(pk, (str, int, float, bool)) or pk is None:
        raise BadRequest("pk must be a JSON string, number or bool")


def _check_fields(fields):
    if not isinstance(fields, dict):
        raise BadRequest("fields must be a JSON object")
    freeze(fields)  # validates all values are JSON-representable


class Index:
    """Committed-state secondary index: frozen key -> set of pks."""

    def __init__(self, name, field, unique):
        self.name = name
        self.field = field
        self.unique = unique
        self.map = {}

    def key_of(self, fields):
        if self.field not in fields:
            return None
        value = fields[self.field]
        if value is None:
            return None
        return freeze(value)

    def add(self, pk, fields):
        key = self.key_of(fields)
        if key is None:
            return
        self.map.setdefault(key, set()).add(pk)

    def remove(self, pk, fields):
        key = self.key_of(fields)
        if key is None:
            return
        holders = self.map.get(key)
        if holders is not None:
            holders.discard(pk)
            if not holders:
                del self.map[key]


class Txn:
    __slots__ = ("tid", "ops", "active")

    def __init__(self, tid):
        self.tid = tid
        self.ops = []  # ("insert"|"update", pk, fields) | ("delete", pk)
        self.active = True


class Store:
    def __init__(self):
        self.rows = {}      # committed: pk -> fields dict
        self.indexes = {}   # name -> Index (committed state only)
        self.txns = {}      # tid -> Txn
        self._next_tid = 1

    # ---- transactions -------------------------------------------------

    def begin(self):
        txn = Txn(self._next_tid)
        self._next_tid += 1
        self.txns[txn.tid] = txn
        return txn

    def get_txn(self, tid):
        txn = self.txns.get(tid)
        if txn is None:
            raise NoSuchTxn("no such transaction: %r" % (tid,))
        if not txn.active:
            raise TxnNotActive("transaction %r is not active" % (tid,))
        return txn

    def _kill(self, txn):
        """Roll back a failed transaction: discard all its effects."""
        txn.ops.clear()
        txn.active = False

    def abort(self, txn):
        if not txn.active:
            raise TxnNotActive("transaction %r is not active" % (txn.tid,))
        txn.ops.clear()
        txn.active = False

    def commit(self, txn):
        if not txn.active:
            raise TxnNotActive("transaction %r is not active" % (txn.tid,))
        # Write-write conflict check: replay the buffered ops against the
        # *current* committed pks. Another transaction may have committed
        # a row with the same pk (or deleted one we updated) since our
        # writes were buffered; the transaction then fails as a whole.
        sim = set(self.rows)
        for op in txn.ops:
            kind, pk = op[0], op[1]
            if kind == "insert":
                if pk in sim:
                    self._kill(txn)
                    raise PkExists("pk %r already exists at commit" % (pk,))
                sim.add(pk)
            elif kind == "update":
                if pk not in sim:
                    self._kill(txn)
                    raise PkNotFound("pk %r not found at commit" % (pk,))
            else:  # delete
                if pk not in sim:
                    self._kill(txn)
                    raise PkNotFound("pk %r not found at commit" % (pk,))
                sim.discard(pk)
        # Re-validate unique constraints against the *current* committed
        # state: other transactions may have committed conflicting keys
        # since this transaction's writes were buffered. The transaction
        # applies atomically, so validate its final write set.
        final = {}
        for op in txn.ops:
            final[op[1]] = None if op[0] == "delete" else op[2]
        for idx in self.indexes.values():
            if not idx.unique:
                continue
            holders = {key: set(pks) for key, pks in idx.map.items()}
            for pk, fields in final.items():
                old = self.rows.get(pk)
                if old is not None:
                    old_key = idx.key_of(old)
                    if old_key is not None:
                        holders.get(old_key, set()).discard(pk)
                if fields is not None:
                    new_key = idx.key_of(fields)
                    if new_key is not None:
                        holders.setdefault(new_key, set()).add(pk)
            if any(len(pks) > 1 for pks in holders.values()):
                self._kill(txn)
                raise UniqueViolation(
                    "unique index %r conflict on commit" % idx.name)
        # Apply row + index writes atomically (single-threaded apply).
        for op in txn.ops:
            kind, pk = op[0], op[1]
            if kind == "delete":
                old = self.rows.pop(pk, None)
                if old is not None:
                    for idx in self.indexes.values():
                        idx.remove(pk, old)
            elif kind == "insert":
                fields = dict(op[2])
                self.rows[pk] = fields
                for idx in self.indexes.values():
                    idx.add(pk, fields)
            else:  # update == delete old + insert new
                fields = dict(op[2])
                old = self.rows.get(pk)
                if old is not None:
                    for idx in self.indexes.values():
                        idx.remove(pk, old)
                self.rows[pk] = fields
                for idx in self.indexes.values():
                    idx.add(pk, fields)
        txn.ops.clear()
        txn.active = False

    # ---- DDL ----------------------------------------------------------

    def create_index(self, name, field, unique=False):
        if not isinstance(name, str) or not name:
            raise BadRequest("index name must be a non-empty string")
        if not isinstance(field, str) or not field:
            raise BadRequest("index field must be a non-empty string")
        if name in self.indexes:
            raise IndexExists("index %r already exists" % name)
        idx = Index(name, field, bool(unique))
        if idx.unique:
            seen = {}
            for pk, fields in self.rows.items():
                key = idx.key_of(fields)
                if key is None:
                    continue
                if key in seen:
                    raise UniqueViolation(
                        "duplicate key in existing rows for unique index %r"
                        % name)
                seen[key] = pk
        for pk, fields in self.rows.items():
            idx.add(pk, fields)
        self.indexes[name] = idx
        return idx

    # ---- writes -------------------------------------------------------

    def insert(self, txn, pk, fields):
        _check_pk(pk)
        _check_fields(fields)
        if pk in self._view(txn):
            raise PkExists("pk %r already exists" % (pk,))
        conflict = self._unique_conflict(txn.ops, pk, fields)
        if conflict is not None:
            self._kill(txn)
            raise UniqueViolation(
                "unique index %r conflict" % conflict)
        txn.ops.append(("insert", pk, dict(fields)))

    def update(self, txn, pk, fields):
        _check_pk(pk)
        _check_fields(fields)
        if pk not in self._view(txn):
            raise PkNotFound("pk %r not found" % (pk,))
        conflict = self._unique_conflict(txn.ops, pk, fields)
        if conflict is not None:
            self._kill(txn)
            raise UniqueViolation(
                "unique index %r conflict" % conflict)
        txn.ops.append(("update", pk, dict(fields)))

    def delete(self, txn, pk):
        _check_pk(pk)
        if pk not in self._view(txn):
            raise PkNotFound("pk %r not found" % (pk,))
        txn.ops.append(("delete", pk))

    # ---- reads --------------------------------------------------------

    def find(self, txn, index_name, key):
        """Rows whose indexed field equals key, via the index."""
        idx = self._index(index_name)
        if key is None:
            return []  # null keys are never indexed
        fkey = freeze(key)
        pks = set(idx.map.get(fkey, ()))
        if txn is not None:
            for pk, fields in self._final_states(txn).items():
                pks.discard(pk)
                if fields is not None and idx.key_of(fields) == fkey:
                    pks.add(pk)
        view = self._view(txn)
        return [self._row(pk, view[pk])
                for pk in sorted(pks, key=freeze) if pk in view]

    def scan(self, txn, index_name, start=None, end=None):
        """Rows with index key in [start, end] (inclusive), key order."""
        idx = self._index(index_name)
        lo = freeze(start) if start is not None else None
        hi = freeze(end) if end is not None else None

        def in_range(key):
            return (lo is None or key >= lo) and (hi is None or key <= hi)

        pairs = set()
        for key, holders in idx.map.items():
            if in_range(key):
                for pk in holders:
                    pairs.add((key, pk))
        if txn is not None:
            for pk, fields in self._final_states(txn).items():
                old = self.rows.get(pk)
                if old is not None:
                    old_key = idx.key_of(old)
                    if old_key is not None:
                        pairs.discard((old_key, pk))
                if fields is not None:
                    new_key = idx.key_of(fields)
                    if new_key is not None and in_range(new_key):
                        pairs.add((new_key, pk))
        view = self._view(txn)
        return [self._row(pk, view[pk])
                for key, pk in sorted(pairs, key=lambda p: (p[0], freeze(p[1])))
                if pk in view]

    # ---- internals ----------------------------------------------------

    def _index(self, name):
        idx = self.indexes.get(name)
        if idx is None:
            raise NoSuchIndex("no such index: %r" % (name,))
        return idx

    @staticmethod
    def _row(pk, fields):
        return {"pk": pk, "fields": fields}

    def _view(self, txn):
        """Committed rows overlaid with the transaction's own writes."""
        if txn is None:
            return self.rows
        view = dict(self.rows)
        for op in txn.ops:
            if op[0] == "delete":
                view.pop(op[1], None)
            else:
                view[op[1]] = op[2]
        return view

    def _final_states(self, txn):
        """Final per-pk state of a transaction's buffered writes."""
        final = {}
        for op in txn.ops:
            if op[0] == "delete":
                final[op[1]] = None
            else:
                final[op[1]] = op[2]
        return final

    def _unique_conflict(self, prior_ops, pk, fields):
        """Name of a unique index violated by writing (pk, fields).

        Checks the committed indexes adjusted by prior_ops (the writes
        already buffered by this transaction, in order). Returns None if
        there is no conflict.
        """
        for idx in self.indexes.values():
            if not idx.unique:
                continue
            fkey = idx.key_of(fields)
            if fkey is None:
                continue
            holders = set(idx.map.get(fkey, ()))
            for op in prior_ops:
                holders.discard(op[1])
                if op[0] != "delete" and idx.key_of(op[2]) == fkey:
                    holders.add(op[1])
            holders.discard(pk)
            if holders:
                return idx.name
        return None
