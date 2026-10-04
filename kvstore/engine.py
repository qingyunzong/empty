"""Transactional engine: begin/get/put/delete/commit/abort/checkpoint.

Steal/no-force buffer management: dirty pages may be written before commit,
committed pages need not be written at commit. Commit syncs the log before
returning. Undo (both abort and recovery) writes CLRs carrying undoNextLSN
so re-recovery never undoes the same update twice.
"""

from __future__ import annotations

import json
import os
import zlib

from .adapter import FaultController, RealAdapter
from .errors import ConflictError
from .pages import BufferPool
from .wal import (CHECKPOINT, CLR, COMMIT, END, NIL_LSN, UPDATE, LogManager)


def page_id_for(key: str, num_pages: int) -> int:
    return zlib.crc32(key.encode("utf-8")) % num_pages


class TxState:
    __slots__ = ("txid", "last_lsn", "first_lsn", "status", "keys")

    def __init__(self, txid: int, last_lsn: int = NIL_LSN,
                 first_lsn: int | None = None, status: str = "running"):
        self.txid = txid
        self.last_lsn = last_lsn
        self.first_lsn = first_lsn
        self.status = status
        self.keys: set[str] = set()


def apply_after_image(page, payload: dict) -> None:
    if payload["after_exists"]:
        page.kv[payload["key"]] = payload["after"]
    else:
        page.kv.pop(payload["key"], None)


def undo_payload(payload: dict) -> dict:
    """Payload for a CLR: its after-image is the original before-image."""
    return {"key": payload["key"],
            "before": payload["after"],
            "before_exists": payload["after_exists"],
            "after": payload["before"],
            "after_exists": payload["before_exists"]}


class Engine:
    def __init__(self, dirpath: str, *, adapter=None, faults=None,
                 num_pages: int = 64, page_size: int = 512,
                 pool_capacity: int = 8) -> None:
        self.dirpath = dirpath
        os.makedirs(dirpath, exist_ok=True)
        self.adapter = adapter or RealAdapter()
        self.faults = faults or FaultController()
        self.num_pages = num_pages
        self.page_size = page_size
        self.trace: list[dict] = []
        self.log = LogManager(self.adapter, os.path.join(dirpath, "wal.log"))
        self.pool = BufferPool(self.adapter, os.path.join(dirpath, "data.db"),
                               self.log, num_pages, page_size, pool_capacity,
                               self._emit)
        self.master_path = os.path.join(dirpath, "master.json")
        self.tx_table: dict[int, TxState] = {}
        self.dpt: dict[int, int] = {}       # page_id -> recLSN
        self.key_locks: dict[str, int] = {}  # key -> txid
        self.next_txid = 1

    @classmethod
    def open(cls, dirpath: str, **kw) -> "Engine":
        """Open a database directory and run recovery (always, ARIES-style)."""
        from .recovery import recover
        eng = cls(dirpath, **kw)
        recover(eng)
        return eng

    # ------------------------------------------------------------------ util
    def _emit(self, phase: str, action: str, reason: str, **extra) -> None:
        event = {"phase": phase, "action": action, "reason": reason}
        event.update(extra)
        self.trace.append(event)

    def _tx(self, txid: int) -> TxState:
        if txid not in self.tx_table:
            raise KeyError(f"unknown or finished transaction {txid}")
        return self.tx_table[txid]

    def _lock_key(self, tx: TxState, key: str) -> None:
        owner = self.key_locks.get(key)
        if owner is not None and owner != tx.txid:
            raise ConflictError(
                f"key {key!r} is locked by transaction {owner}")
        self.key_locks[key] = tx.txid
        tx.keys.add(key)

    def _note_update(self, tx: TxState, lsn: int) -> None:
        if tx.first_lsn is None:
            tx.first_lsn = lsn
        tx.last_lsn = lsn

    def _mark_dirty_page(self, page, lsn: int) -> None:
        page.dirty = True
        self.dpt.setdefault(page.page_id, lsn)

    # ------------------------------------------------------------- txn API
    def begin(self) -> int:
        txid = self.next_txid
        self.next_txid += 1
        self.tx_table[txid] = TxState(txid)
        self._emit("txn", "begin", f"transaction {txid} started", tx=txid)
        return txid

    def get(self, txid: int, key: str):
        self._tx(txid)
        page = self.pool.fetch(page_id_for(key, self.num_pages))
        return page.kv.get(key)

    def put(self, txid: int, key: str, value) -> None:
        tx = self._tx(txid)
        self._lock_key(tx, key)
        pid = page_id_for(key, self.num_pages)
        page = self.pool.fetch(pid)
        rec = self.log.append(
            UPDATE, txid, tx.last_lsn, pid,
            {"key": key, "before": page.kv.get(key),
             "before_exists": key in page.kv,
             "after": value, "after_exists": True})
        self._note_update(tx, rec.lsn)
        page.kv[key] = value
        page.page_lsn = rec.lsn
        self._mark_dirty_page(page, rec.lsn)
        self._emit("txn", "put",
                   f"txn {txid} set {key!r}={value!r} on page {pid}; UPDATE "
                   f"logged at LSN {rec.lsn} with before/after image",
                   tx=txid, lsn=rec.lsn, page=pid)

    def delete(self, txid: int, key: str) -> None:
        tx = self._tx(txid)
        self._lock_key(tx, key)
        pid = page_id_for(key, self.num_pages)
        page = self.pool.fetch(pid)
        rec = self.log.append(
            UPDATE, txid, tx.last_lsn, pid,
            {"key": key, "before": page.kv.get(key),
             "before_exists": key in page.kv,
             "after": None, "after_exists": False})
        self._note_update(tx, rec.lsn)
        page.kv.pop(key, None)
        page.page_lsn = rec.lsn
        self._mark_dirty_page(page, rec.lsn)
        self._emit("txn", "delete",
                   f"txn {txid} deleted {key!r} on page {pid}; UPDATE "
                   f"logged at LSN {rec.lsn} with before-image",
                   tx=txid, lsn=rec.lsn, page=pid)

    def commit(self, txid: int) -> None:
        tx = self._tx(txid)
        rec = self.log.append(COMMIT, txid, tx.last_lsn, -1, {})
        self.log.flush(sync=True)  # log is synced before commit returns
        self._emit("txn", "commit",
                   f"txn {txid} COMMIT at LSN {rec.lsn}; log synced to disk "
                   f"before commit returns", tx=txid, lsn=rec.lsn)
        end = self.log.append(END, txid, rec.lsn, -1, {})
        self.log.flush(sync=False)
        for key in tx.keys:
            self.key_locks.pop(key, None)
        del self.tx_table[txid]
        self._emit("txn", "end", f"txn {txid} END at LSN {end.lsn}",
                   tx=txid, lsn=end.lsn)

    def abort(self, txid: int) -> None:
        tx = self._tx(txid)
        self._emit("txn", "abort",
                   f"txn {txid} aborts: rolling back via compensation records",
                   tx=txid)
        self._undo_txn(tx)
        end = self.log.append(END, txid, tx.last_lsn, -1, {})
        self.log.flush(sync=True)
        for key in tx.keys:
            self.key_locks.pop(key, None)
        del self.tx_table[txid]
        self._emit("txn", "end",
                   f"txn {txid} fully aborted; END at LSN {end.lsn}",
                   tx=txid, lsn=end.lsn)

    # ---------------------------------------------------------------- undo
    def _undo_txn(self, tx: TxState) -> None:
        """Walk the txn's prevLSN chain, writing CLRs with undoNextLSN."""
        lsn = tx.last_lsn
        while lsn != NIL_LSN:
            rec = self.log.records[lsn]
            if rec.rtype == UPDATE:
                clr = self.log.append(CLR, tx.txid, tx.last_lsn, rec.page_id,
                                      undo_payload(rec.payload),
                                      undo_next=rec.prev_lsn)
                page = self.pool.fetch(rec.page_id)
                apply_after_image(page, clr.payload)
                page.page_lsn = clr.lsn
                self._mark_dirty_page(page, clr.lsn)
                tx.last_lsn = clr.lsn
                self.log.flush(sync=True)
                self.faults.hit("clr_flush")
                self._emit("undo", "clr",
                           f"txn {tx.txid}: compensated UPDATE at LSN "
                           f"{rec.lsn} with CLR at LSN {clr.lsn}; "
                           f"undoNextLSN={rec.prev_lsn}", tx=tx.txid,
                           lsn=clr.lsn, undoes=rec.lsn)
                lsn = rec.prev_lsn
            elif rec.rtype == CLR:
                self._emit("undo", "skip_via_clr",
                           f"txn {tx.txid}: LSN {lsn} is a CLR; jumping to "
                           f"undoNextLSN {rec.undo_next} so already-compensated "
                           f"updates are not undone again", tx=tx.txid, lsn=lsn)
                lsn = rec.undo_next
            else:
                lsn = NIL_LSN
        self.faults.hit("undo_complete")

    # ----------------------------------------------------------- checkpoint
    def checkpoint(self) -> None:
        """Fuzzy checkpoint: snapshot ATT/DPT, flush pages, publish, reclaim."""
        att = {str(txid): {"last_lsn": tx.last_lsn,
                           "first_lsn": tx.first_lsn
                           if tx.first_lsn is not None else tx.last_lsn,
                           "status": tx.status}
               for txid, tx in self.tx_table.items()}
        dpt = {str(pid): lsn for pid, lsn in self.dpt.items()}
        rec = self.log.append(CHECKPOINT, 0, NIL_LSN, -1,
                              {"att": att, "dpt": dpt})
        self.log.flush(sync=True)
        self._emit("checkpoint", "snapshot",
                   f"fuzzy checkpoint at LSN {rec.lsn}: {len(att)} active "
                   f"txn(s), {len(dpt)} dirty page(s); writes stay allowed "
                   f"during the checkpoint", lsn=rec.lsn)
        self.pool.flush_all()
        self.dpt.clear()
        self.faults.hit("checkpoint_publish")
        self._write_master(rec.lsn)
        self._emit("checkpoint", "publish",
                   f"checkpoint LSN {rec.lsn} published to master record and "
                   f"synced", lsn=rec.lsn)
        candidates = [rec.lsn]
        for tx in self.tx_table.values():
            if tx.first_lsn is not None:
                candidates.append(tx.first_lsn)
        candidates.extend(self.dpt.values())
        point = min(candidates)
        if self.log.truncate_prefix(point):
            self._write_master(rec.lsn)
            self._emit("checkpoint", "reclaim",
                       f"log prefix before LSN {point} reclaimed: checkpoint "
                       f"and all required log/pages are durable",
                       lsn=point)

    def _write_master(self, checkpoint_lsn: int) -> None:
        blob = json.dumps({"checkpoint_lsn": checkpoint_lsn,
                           "log_base": self.log.base}).encode("utf-8")
        self.adapter.write(self.master_path, blob)
        self.adapter.sync(self.master_path)

    # ---------------------------------------------------------------- misc
    def dump(self) -> dict:
        """All key/value pairs currently in the database."""
        out = {}
        for pid in range(self.num_pages):
            out.update(self.pool.fetch(pid).kv)
        return out
