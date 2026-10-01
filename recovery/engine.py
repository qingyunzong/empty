"""Steal/no-force buffer manager with ARIES-style recovery.

In-memory state (buffer pool, dirty page table, transaction table) is
volatile: `crash()` discards it and only the on-disk page file and WAL
survive. `recover()` performs:
  1. analysis  - locate the most recent checkpoint (dirty pages + active
                 transactions) and determine the redo start LSN;
  2. redo      - replay history forward from that LSN, applying a record
                 only when its LSN is greater than the page's pageLSN
                 (idempotent);
  3. undo      - roll back transactions still active at the crash point,
                 writing a compensation log record (CLR) per undone
                 update, in reverse LSN order.
"""

import os

from .storage import (
    PageFile,
    get_page_lsn,
    locate,
    read_slot,
    set_page_lsn,
    write_slot,
)
from .wal import WAL


class LockConflict(Exception):
    """Raised when a key is locked by another active transaction.

    Strict 2PL is what makes before-image undo correct: a key may not be
    overwritten by a second transaction while the first is still active.
    """

    def __init__(self, key, holder):
        super().__init__(f"key {key} is locked by transaction {holder}")
        self.key = key
        self.holder = holder


class Engine:
    def __init__(self, datadir):
        os.makedirs(datadir, exist_ok=True)
        self.wal = WAL(os.path.join(datadir, "wal.log"))
        self.pages = PageFile(os.path.join(datadir, "pages.db"))
        self._buffer = {}  # page_no -> bytearray (volatile)
        self._dirty = {}   # page_no -> recLSN, first LSN dirtied since flush
        self._txns = {}    # txn id -> last LSN (volatile txn table)
        self._locks = {}   # key -> txn id (volatile, strict 2PL)
        self._next_lsn = self.wal.max_lsn() + 1

    # ------------------------------------------------------------------ log
    def _append(self, record):
        record["lsn"] = self._next_lsn
        self._next_lsn += 1
        return self.wal.append(record)

    # -------------------------------------------------------------- buffer
    def _load_page(self, page_no):
        if page_no not in self._buffer:
            self._buffer[page_no] = self.pages.read_page(page_no)
        return self._buffer[page_no]

    # ---------------------------------------------------------- operations
    def put(self, txn, key, value):
        if txn in self._txns:
            prev = self._txns[txn]
        else:
            prev = self._append({"type": "begin", "txn": txn})
            self._txns[txn] = prev
        holder = self._locks.get(key)
        if holder is not None and holder != txn and holder in self._txns:
            raise LockConflict(key, holder)
        page_no, slot = locate(key)
        page = self._load_page(page_no)
        before = read_slot(page, slot)
        lsn = self._append({
            "type": "update", "txn": txn, "page": page_no, "key": key,
            "before": before, "after": value, "prev": prev,
        })
        write_slot(page, slot, value)
        set_page_lsn(page, lsn)
        self._dirty.setdefault(page_no, lsn)
        self._txns[txn] = lsn
        self._locks[key] = txn

    def _release_locks(self, txn):
        for key in [k for k, t in self._locks.items() if t == txn]:
            del self._locks[key]

    def commit(self, txn):
        if txn not in self._txns:
            raise ValueError(f"transaction {txn} is not active")
        prev = self._append({"type": "commit", "txn": txn,
                             "prev": self._txns[txn]})
        self._append({"type": "end", "txn": txn, "prev": prev})
        del self._txns[txn]
        self._release_locks(txn)

    def abort(self, txn):
        if txn not in self._txns:
            raise ValueError(f"transaction {txn} is not active")
        self._undo({txn: self._txns[txn]}, self.wal.scan())
        del self._txns[txn]
        self._release_locks(txn)

    def checkpoint(self):
        """Flush dirty pages and log dirty page set + active txn table."""
        record = {
            "type": "checkpoint",
            "dirty": dict(self._dirty),
            "txns": dict(self._txns),
        }
        self._append(record)
        for page_no in self._dirty:
            self.pages.write_page(page_no, self._buffer[page_no])
        self._dirty.clear()

    def crash(self):
        """Simulate a crash: all in-process state is lost, disk survives."""
        self._buffer.clear()
        self._dirty.clear()
        self._txns.clear()
        self._locks.clear()
        self._next_lsn = self.wal.max_lsn() + 1

    # -------------------------------------------------------------- recover
    def recover(self):
        records = self.wal.scan()
        by_lsn = {rec["lsn"]: rec for rec in records}

        # --- analysis: last checkpoint gives redo start + loser candidates
        checkpoint = None
        for rec in records:
            if rec["type"] == "checkpoint":
                checkpoint = rec
        losers = {}
        start = 1
        if checkpoint is not None:
            losers = {int(txn): lsn for txn, lsn in checkpoint["txns"].items()}
            dirty = {int(page): lsn for page, lsn in checkpoint["dirty"].items()}
            start = min(dirty.values(), default=checkpoint["lsn"])

        # --- redo: replay forward, apply only if lsn > pageLSN
        for rec in records:
            if rec["lsn"] < start:
                continue
            rtype = rec["type"]
            if rtype in ("update", "clr"):
                page_no = rec["page"]
                page = self.pages.read_page(page_no)
                if rec["lsn"] > get_page_lsn(page):
                    _, slot = locate(rec["key"])
                    write_slot(page, slot, rec["after"])
                    set_page_lsn(page, rec["lsn"])
                    self.pages.write_page(page_no, page)
            if rtype == "begin":
                losers[rec["txn"]] = rec["lsn"]
            elif rtype in ("update", "clr", "commit"):
                losers[rec["txn"]] = rec["lsn"]
            elif rtype == "end":
                losers.pop(rec["txn"], None)

        # --- undo: roll back losers, writing a CLR per step
        self._undo(losers, records)

        self._buffer.clear()
        self._dirty.clear()
        self._txns.clear()
        self._locks.clear()
        self._next_lsn = self.wal.max_lsn() + 1

    def _undo(self, losers, records):
        by_lsn = {rec["lsn"]: rec for rec in records}
        to_undo = dict(losers)
        while to_undo:
            txn = max(to_undo, key=lambda t: to_undo[t])
            rec = by_lsn[to_undo[txn]]
            if rec["type"] == "update":
                page_no = rec["page"]
                _, slot = locate(rec["key"])
                page = self._load_page(page_no)
                clr_lsn = self._append({
                    "type": "clr", "txn": txn, "page": page_no,
                    "key": rec["key"], "before": read_slot(page, slot),
                    "after": rec["before"], "prev": to_undo[txn],
                    "undo_next": rec["prev"],
                })
                write_slot(page, slot, rec["before"])
                set_page_lsn(page, clr_lsn)
                self.pages.write_page(page_no, page)
                self._buffer.pop(page_no, None)
                self._dirty.pop(page_no, None)
                nxt = rec["prev"]
            elif rec["type"] == "clr":
                nxt = rec["undo_next"]
            else:  # begin / commit / end: nothing to undo here
                nxt = rec.get("prev")
            if nxt is None or nxt not in by_lsn or \
                    by_lsn[nxt]["type"] == "begin":
                self._append({"type": "end", "txn": txn,
                              "prev": to_undo[txn]})
                del to_undo[txn]
            else:
                to_undo[txn] = nxt

    # ----------------------------------------------------------------- dump
    def dump(self):
        """Return the full physical database state as {key: value}."""
        from .storage import MAX_KEY
        state = {}
        for key in range(MAX_KEY):
            page_no, slot = locate(key)
            state[key] = read_slot(self._load_page(page_no), slot)
        return state

    def close(self):
        self.wal.close()
        self.pages.close()
