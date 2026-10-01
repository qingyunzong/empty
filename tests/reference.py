"""Brute-force serial reference implementation for differential testing.

Implements the same external semantics as secidx.Store but with no
indexes at all: every query is a full scan of the committed rows
overlaid with the querying transaction's own buffered writes.
"""

from secidx import (
    UniqueViolation, TxnNotActive, NoSuchTxn, NoSuchIndex, IndexExists,
    PkExists, PkNotFound, freeze,
)


class RefTxn:
    def __init__(self, tid):
        self.tid = tid
        self.writes = {}   # pk -> fields dict or None (deleted)
        self.origin = {}   # pk -> "insert" | "modify" (first touch)
        self.active = True


class RefStore:
    def __init__(self):
        self.rows = {}
        self.indexes = {}  # name -> (field, unique)
        self.txns = {}
        self._next = 1

    def begin(self):
        txn = RefTxn(self._next)
        self._next += 1
        self.txns[txn.tid] = txn
        return txn

    def get_txn(self, tid):
        txn = self.txns.get(tid)
        if txn is None:
            raise NoSuchTxn("no such transaction: %r" % (tid,))
        if not txn.active:
            raise TxnNotActive("transaction %r is not active" % (tid,))
        return txn

    def abort(self, txn):
        if not txn.active:
            raise TxnNotActive("transaction %r is not active" % (txn.tid,))
        txn.writes.clear()
        txn.active = False

    def _kill(self, txn):
        txn.writes.clear()
        txn.active = False

    def commit(self, txn):
        if not txn.active:
            raise TxnNotActive("transaction %r is not active" % (txn.tid,))
        # Write-write conflicts against current committed state.
        for pk in txn.writes:
            if txn.origin[pk] == "insert" and pk in self.rows:
                self._kill(txn)
                raise PkExists("pk %r already exists at commit" % (pk,))
            if txn.origin[pk] == "modify" and pk not in self.rows:
                self._kill(txn)
                raise PkNotFound("pk %r not found at commit" % (pk,))
        # Validate unique constraints against current committed state
        # plus this transaction's own writes, by full scan.
        for name, (field, unique) in self.indexes.items():
            if not unique:
                continue
            holders = {}
            for pk, fields in self.rows.items():
                v = fields.get(field)
                if v is not None:
                    holders.setdefault(freeze(v), set()).add(pk)
            for pk, fields in txn.writes.items():
                for key in list(holders):
                    holders[key].discard(pk)
                if fields is not None:
                    v = fields.get(field)
                    if v is not None:
                        holders.setdefault(freeze(v), set()).add(pk)
            for key, pks in holders.items():
                if len(pks) > 1:
                    self._kill(txn)
                    raise UniqueViolation(
                        "unique index %r conflict on commit" % name)
        for pk, fields in txn.writes.items():
            if fields is None:
                self.rows.pop(pk, None)
            else:
                self.rows[pk] = dict(fields)
        txn.writes.clear()
        txn.active = False

    def create_index(self, name, field, unique=False):
        if name in self.indexes:
            raise IndexExists("index %r already exists" % name)
        if unique:
            seen = set()
            for fields in self.rows.values():
                v = fields.get(field)
                if v is None:
                    continue
                if freeze(v) in seen:
                    raise UniqueViolation("duplicate key for %r" % name)
                seen.add(freeze(v))
        self.indexes[name] = (field, bool(unique))

    def _view(self, txn):
        view = dict(self.rows) if txn is None else dict(self.rows)
        if txn is not None:
            for pk, fields in txn.writes.items():
                if fields is None:
                    view.pop(pk, None)
                else:
                    view[pk] = fields
        return view

    def _check_unique(self, txn, pk, fields):
        for name, (field, unique) in self.indexes.items():
            if not unique:
                continue
            v = fields.get(field)
            if v is None:
                continue
            fkey = freeze(v)
            view = self._view(txn)
            for other_pk, other_fields in view.items():
                if other_pk == pk:
                    continue
                ov = other_fields.get(field)
                if ov is not None and freeze(ov) == fkey:
                    return name
        return None

    def insert(self, txn, pk, fields):
        if pk in self._view(txn):
            raise PkExists("pk %r already exists" % (pk,))
        conflict = self._check_unique(txn, pk, fields)
        if conflict is not None:
            self._kill(txn)
            raise UniqueViolation("unique index %r conflict" % conflict)
        txn.writes[pk] = dict(fields)
        txn.origin.setdefault(pk, "insert")

    def update(self, txn, pk, fields):
        if pk not in self._view(txn):
            raise PkNotFound("pk %r not found" % (pk,))
        conflict = self._check_unique(txn, pk, fields)
        if conflict is not None:
            self._kill(txn)
            raise UniqueViolation("unique index %r conflict" % conflict)
        txn.writes[pk] = dict(fields)
        txn.origin.setdefault(pk, "modify")

    def delete(self, txn, pk):
        if pk not in self._view(txn):
            raise PkNotFound("pk %r not found" % (pk,))
        txn.writes[pk] = None
        txn.origin.setdefault(pk, "modify")

    def find(self, txn, index_name, key):
        if index_name not in self.indexes:
            raise NoSuchIndex(index_name)
        field, _ = self.indexes[index_name]
        if key is None:
            return []
        fkey = freeze(key)
        view = self._view(txn)
        out = [{"pk": pk, "fields": fields}
               for pk, fields in view.items()
               if fields.get(field) is not None
               and freeze(fields.get(field)) == fkey]
        out.sort(key=lambda r: freeze(r["pk"]))
        return out

    def scan(self, txn, index_name, start=None, end=None):
        if index_name not in self.indexes:
            raise NoSuchIndex(index_name)
        field, _ = self.indexes[index_name]
        lo = freeze(start) if start is not None else None
        hi = freeze(end) if end is not None else None
        view = self._view(txn)
        out = []
        for pk, fields in view.items():
            v = fields.get(field)
            if v is None:
                continue
            fk = freeze(v)
            if lo is not None and fk < lo:
                continue
            if hi is not None and fk > hi:
                continue
            out.append((fk, pk, fields))
        out.sort(key=lambda t: (t[0], freeze(t[1])))
        return [{"pk": pk, "fields": fields} for _, pk, fields in out]
