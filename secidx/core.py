"""secidx core: transactional row store with secondary indexes.

Semantics
---------
* Rows are ``(pk, fields)`` pairs; ``fields`` is a dict of JSON values.
* Secondary indexes (unique or non-unique) can be created on any field.
* Index entries commit atomically with the row data in the same transaction:
  a committed index never points at a missing row, and a committed row is
  never missing from an index that covers one of its fields.
* A unique-index conflict aborts the *whole* transaction with
  ``UNIQUE_VIOLATION`` and leaves no partial effects.
* Uncommitted index entries are invisible to other transactions, but a
  transaction sees (and uniqueness-checks) its own uncommitted writes.
* ``delete`` removes index entries synchronously; ``update`` is equivalent
  to delete-old + insert-new.

Concurrency model
-----------------
Optimistic, first-writer-wins.  A transaction stages its writes privately;
unique keys and primary keys it touches are reserved so that a concurrent
transaction touching the same unique key fails immediately with
``UNIQUE_VIOLATION`` and one touching the same row fails with
``TXN_CONFLICT``.  This makes interleaved executions equivalent to some
serial order of the committed transactions.
"""

from __future__ import annotations

import json


class ErrorCode:
    UNIQUE_VIOLATION = "UNIQUE_VIOLATION"
    TXN_CONFLICT = "TXN_CONFLICT"
    DUPLICATE_PK = "DUPLICATE_PK"
    NOT_FOUND = "NOT_FOUND"
    NO_SUCH_TXN = "NO_SUCH_TXN"
    TXN_EXISTS = "TXN_EXISTS"
    INDEX_EXISTS = "INDEX_EXISTS"
    NO_SUCH_INDEX = "NO_SUCH_INDEX"
    BAD_REQUEST = "BAD_REQUEST"


class SecIdxError(Exception):
    """Base error carrying a stable machine-readable code."""

    code = ErrorCode.BAD_REQUEST

    def __init__(self, message: str = ""):
        super().__init__(message)
        self.message = message


class UniqueViolation(SecIdxError):
    code = ErrorCode.UNIQUE_VIOLATION


class TxnConflict(SecIdxError):
    code = ErrorCode.TXN_CONFLICT


class DuplicatePk(SecIdxError):
    code = ErrorCode.DUPLICATE_PK


class NotFound(SecIdxError):
    code = ErrorCode.NOT_FOUND


class NoSuchTxn(SecIdxError):
    code = ErrorCode.NO_SUCH_TXN


class TxnExists(SecIdxError):
    code = ErrorCode.TXN_EXISTS


class IndexExists(SecIdxError):
    code = ErrorCode.INDEX_EXISTS


class NoSuchIndex(SecIdxError):
    code = ErrorCode.NO_SUCH_INDEX


class BadRequest(SecIdxError):
    code = ErrorCode.BAD_REQUEST


def _key(value) -> str:
    """Canonical internal representation of an index key."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def pk_sort_key(pk):
    """Deterministic ordering for JSON pks: numbers, then strings, then repr."""
    if isinstance(pk, bool):
        return (2, repr(pk))
    if isinstance(pk, (int, float)):
        return (0, pk)
    if isinstance(pk, str):
        return (1, pk)
    return (2, repr(pk))


class Index:
    """Committed secondary index on one field."""

    def __init__(self, field: str, unique: bool):
        self.field = field
        self.unique = unique
        # internal key -> set of pks (committed entries only)
        self.map: dict[str, set] = {}

    def add(self, value, pk) -> None:
        self.map.setdefault(_key(value), set()).add(pk)

    def remove(self, value, pk) -> None:
        key = _key(value)
        pks = self.map.get(key)
        if pks is None:
            return
        pks.discard(pk)
        if not pks:
            del self.map[key]

    def pks_for(self, value) -> set:
        return set(self.map.get(_key(value), ()))


class Transaction:
    """Private write-set of one in-flight transaction."""

    def __init__(self, txn_id: str):
        self.txn_id = txn_id
        # pk -> fields dict (insert/update) or None (delete)
        self.staged: dict = {}
        # unique keys reserved by this txn: (field, internal key)
        self.reserved_keys: set = set()
        # pks this txn has written
        self.reserved_pks: set = set()

    @property
    def active(self) -> bool:
        return self.staged is not None


class Database:
    def __init__(self):
        self.rows: dict = {}            # committed pk -> fields dict
        self.indexes: dict[str, Index] = {}
        self.txns: dict[str, Transaction] = {}
        # cross-transaction reservations of uncommitted writes
        self._reserved_keys: dict[tuple, str] = {}   # (field, key) -> txn_id
        self._reserved_pks: dict = {}                # pk -> txn_id

    # ------------------------------------------------------------------ txns

    def begin(self, txn_id: str) -> None:
        if txn_id in self.txns:
            raise TxnExists(f"transaction {txn_id!r} already active")
        self.txns[txn_id] = Transaction(txn_id)

    def commit(self, txn_id: str) -> None:
        txn = self._txn(txn_id)
        # Uniqueness was validated (and keys reserved) at write time, so the
        # commit itself cannot fail: apply data and index entries atomically.
        for pk, new_fields in txn.staged.items():
            old_fields = self.rows.get(pk)
            if old_fields is not None:
                self._index_remove(pk, old_fields)
            if new_fields is None:
                self.rows.pop(pk, None)
            else:
                self.rows[pk] = dict(new_fields)
                self._index_add(pk, new_fields)
        self._release(txn)

    def abort(self, txn_id: str) -> None:
        txn = self._txn(txn_id)
        self._release(txn)

    def _release(self, txn: Transaction) -> None:
        for fk in txn.reserved_keys:
            if self._reserved_keys.get(fk) == txn.txn_id:
                del self._reserved_keys[fk]
        for pk in txn.reserved_pks:
            if self._reserved_pks.get(pk) == txn.txn_id:
                del self._reserved_pks[pk]
        txn.staged = None
        del self.txns[txn.txn_id]

    def _txn(self, txn_id: str) -> Transaction:
        txn = self.txns.get(txn_id)
        if txn is None:
            raise NoSuchTxn(f"no active transaction {txn_id!r}")
        return txn

    def _fail(self, txn: Transaction, exc: SecIdxError):
        """Abort ``txn`` wholesale, then raise ``exc`` (no partial effects)."""
        self._release(txn)
        raise exc

    # ---------------------------------------------------------------- indexes

    def create_index(self, field: str, unique: bool = False) -> None:
        if field in self.indexes:
            raise IndexExists(f"index on field {field!r} already exists")
        index = Index(field, unique)
        for pk, fields in self.rows.items():
            if field not in fields:
                continue
            if unique:
                existing = index.pks_for(fields[field])
                if existing:
                    raise UniqueViolation(
                        f"duplicate key {fields[field]!r} for unique index "
                        f"on {field!r} (pks {sorted(existing | {pk})})"
                    )
            index.add(fields[field], pk)
        self.indexes[field] = index

    def _index_add(self, pk, fields: dict) -> None:
        for field, index in self.indexes.items():
            if field in fields:
                index.add(fields[field], pk)

    def _index_remove(self, pk, fields: dict) -> None:
        for field, index in self.indexes.items():
            if field in fields:
                index.remove(fields[field], pk)

    # ------------------------------------------------------------------ DML

    def insert(self, txn_id: str, pk, fields: dict) -> None:
        txn = self._txn(txn_id)
        self._reserve_pk(txn, pk)
        visible = self._visible_row(txn, pk)
        if visible is not None:
            raise DuplicatePk(f"pk {pk!r} already exists")
        self._check_unique(txn, pk, fields)
        txn.staged[pk] = dict(fields)

    def update(self, txn_id: str, pk, fields: dict) -> None:
        """Merge ``fields`` into the row; old index entries are replaced."""
        txn = self._txn(txn_id)
        self._reserve_pk(txn, pk)
        current = self._visible_row(txn, pk)
        if current is None:
            raise NotFound(f"pk {pk!r} not found")
        new_fields = dict(current)
        new_fields.update(fields)
        self._check_unique(txn, pk, new_fields)
        txn.staged[pk] = new_fields

    def delete(self, txn_id: str, pk) -> None:
        txn = self._txn(txn_id)
        self._reserve_pk(txn, pk)
        if self._visible_row(txn, pk) is None:
            raise NotFound(f"pk {pk!r} not found")
        txn.staged[pk] = None

    def _reserve_pk(self, txn: Transaction, pk) -> None:
        owner = self._reserved_pks.get(pk)
        if owner is not None and owner != txn.txn_id:
            self._fail(txn, TxnConflict(
                f"pk {pk!r} has uncommitted writes from transaction {owner!r}"))
        self._reserved_pks[pk] = txn.txn_id
        txn.reserved_pks.add(pk)

    def _visible_row(self, txn: Transaction, pk):
        """Row as seen by ``txn``: committed state plus its own writes."""
        if pk in txn.staged:
            return txn.staged[pk]
        return self.rows.get(pk)

    def _check_unique(self, txn: Transaction, pk, fields: dict) -> None:
        for field, index in self.indexes.items():
            if not index.unique or field not in fields:
                continue
            value = fields[field]
            ikey = _key(value)
            # 1. committed entries still visible to this txn
            for other_pk in index.pks_for(value):
                if other_pk == pk:
                    continue
                effective = self._visible_row(txn, other_pk)
                if effective is not None and \
                        effective.get(field, _MISSING) != _MISSING and \
                        _key(effective[field]) == ikey:
                    self._fail(txn, UniqueViolation(
                        f"unique index {field!r}: key {value!r} already held "
                        f"by committed pk {other_pk!r}"))
            # 2. this txn's own uncommitted writes
            for other_pk, staged_fields in txn.staged.items():
                if other_pk == pk or staged_fields is None:
                    continue
                if staged_fields.get(field, _MISSING) != _MISSING and \
                        _key(staged_fields[field]) == ikey:
                    self._fail(txn, UniqueViolation(
                        f"unique index {field!r}: key {value!r} already "
                        f"staged for pk {other_pk!r} in this transaction"))
            # 3. keys reserved by other in-flight transactions
            owner = self._reserved_keys.get((field, ikey))
            if owner is not None and owner != txn.txn_id:
                self._fail(txn, UniqueViolation(
                    f"unique index {field!r}: key {value!r} reserved by "
                    f"transaction {owner!r}"))
            txn.reserved_keys.add((field, ikey))
            self._reserved_keys[(field, ikey)] = txn.txn_id

    # ---------------------------------------------------------------- queries

    def find(self, txn_id: str, field: str, value) -> list:
        """Rows whose ``field`` equals ``value``; uses the index if present.

        Always returns a list (``[]`` when nothing matches, never an error).
        """
        txn = self._txn(txn_id)
        index = self.indexes.get(field)
        result = {}
        if index is not None:
            candidates = index.pks_for(value)
        else:
            candidates = [pk for pk, f in self.rows.items()
                          if f.get(field, _MISSING) != _MISSING
                          and f[field] == value]
        for pk in candidates:
            effective = self._visible_row(txn, pk)
            if effective is not None and \
                    effective.get(field, _MISSING) != _MISSING and \
                    effective[field] == value:
                result[pk] = effective
        # own uncommitted inserts/updates are not in the committed index yet
        for pk, staged_fields in txn.staged.items():
            if staged_fields is not None and \
                    staged_fields.get(field, _MISSING) != _MISSING and \
                    staged_fields[field] == value:
                result[pk] = staged_fields
        return [{"pk": pk, "fields": dict(result[pk])}
                for pk in sorted(result, key=pk_sort_key)]

    def scan(self, txn_id: str) -> list:
        """All rows visible to ``txn``, sorted by pk."""
        txn = self._txn(txn_id)
        visible = dict(self.rows)
        for pk, staged_fields in txn.staged.items():
            if staged_fields is None:
                visible.pop(pk, None)
            else:
                visible[pk] = staged_fields
        return [{"pk": pk, "fields": dict(visible[pk])}
                for pk in sorted(visible, key=pk_sort_key)]


class _Missing:
    pass


_MISSING = _Missing()
