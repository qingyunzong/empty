"""Storage engine with WAL, checkpointing, and ARIES-style recovery.

In-memory state (buffer pool, dirty page table, transaction table) is lost
on :meth:`Engine.crash`; only the WAL and the data file survive.

Log record types:
  BEGIN      {txn, prev}
  UPDATE     {txn, prev, page, key, before, after}
  COMMIT     {txn, prev}
  END        {txn, prev}
  CLR        {txn, prev, page, key, before, after, undo_next}
  CHECKPOINT {dpt: {page: recLSN}, tt: {txn: {status, last_lsn}}}
"""

import os

from .storage import PAGE_COUNT, PageFile, page_of
from .wal import Wal


def _apply(data, key, value):
    """Apply a logged value; None means the key was absent."""
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value


class Engine:
    def __init__(self, dbdir, buffer_capacity=4):
        self.dbdir = dbdir
        os.makedirs(dbdir, exist_ok=True)
        self.wal = Wal(os.path.join(dbdir, "wal.log"))
        self.pages = PageFile(os.path.join(dbdir, "data.db"))
        self.buffer_capacity = buffer_capacity
        self._reset_memory()
        self.alive = True

    def _reset_memory(self):
        self.buffer = {}  # page_id -> {"page_lsn", "data", "dirty"}
        self._lru = []    # page ids, least recently used first
        self.dpt = {}     # page_id -> recLSN (oldest LSN that dirtied the page)
        self.tt = {}      # txn -> {"status", "last_lsn"}

    def _check_alive(self):
        if not self.alive:
            raise RuntimeError("engine has crashed; run recover first")

    # ---------------- normal processing ----------------

    def _pin(self, page_id):
        if page_id in self.buffer:
            self._lru.remove(page_id)
            self._lru.append(page_id)
            return self.buffer[page_id]
        if len(self.buffer) >= self.buffer_capacity:
            victim = self._lru.pop(0)
            page = self.buffer.pop(victim)
            if page["dirty"]:
                self.pages.write_page(victim, page["page_lsn"], page["data"])
                self.dpt.pop(victim, None)
        page_lsn, data = self.pages.read_page(page_id)
        page = {"page_lsn": page_lsn, "data": data, "dirty": False}
        self.buffer[page_id] = page
        self._lru.append(page_id)
        return page

    def put(self, txn, key, value):
        self._check_alive()
        if txn not in self.tt:
            lsn = self.wal.append({"type": "BEGIN", "txn": txn, "prev": 0})
            self.tt[txn] = {"status": "running", "last_lsn": lsn}
        page_id = page_of(key)
        page = self._pin(page_id)
        before = page["data"].get(key)
        lsn = self.wal.append({
            "type": "UPDATE", "txn": txn, "prev": self.tt[txn]["last_lsn"],
            "page": page_id, "key": key, "before": before, "after": value,
        })
        self.tt[txn]["last_lsn"] = lsn
        page["data"][key] = value
        page["page_lsn"] = lsn
        page["dirty"] = True
        self.dpt.setdefault(page_id, lsn)

    def commit(self, txn):
        self._check_alive()
        if txn not in self.tt:
            raise KeyError("unknown transaction: %r" % txn)
        lsn = self.wal.append({
            "type": "COMMIT", "txn": txn, "prev": self.tt[txn]["last_lsn"],
        })
        self.wal.append({"type": "END", "txn": txn, "prev": lsn})
        del self.tt[txn]

    def checkpoint(self):
        """Record the dirty page table and active transaction table in the
        WAL, then flush all dirty pages to disk."""
        self._check_alive()
        snapshot_tt = {txn: dict(info) for txn, info in self.tt.items()}
        self.wal.append({
            "type": "CHECKPOINT", "dpt": dict(self.dpt), "tt": snapshot_tt,
        })
        for page_id, page in self.buffer.items():
            if page["dirty"]:
                self.pages.write_page(page_id, page["page_lsn"], page["data"])
                page["dirty"] = False
        self.dpt.clear()

    def crash(self):
        """Simulate a crash: every piece of in-memory state is discarded;
        only the WAL and data files on disk survive."""
        self._reset_memory()
        self.alive = False

    # ---------------- recovery ----------------

    def recover(self):
        """ARIES-style recovery: analysis, redo (idempotent via pageLSN),
        then undo of loser transactions with compensation log records."""
        self._reset_memory()
        records = self.wal.read_all()
        by_lsn = {rec["lsn"]: rec for rec in records}

        # --- analysis: rebuild DPT/TT from the last checkpoint onward ---
        checkpoint = None
        tail = records
        for i, rec in enumerate(records):
            if rec["type"] == "CHECKPOINT":
                checkpoint = rec
                tail = records[i + 1:]
        if checkpoint is not None:
            dpt = {int(p): lsn for p, lsn in checkpoint["dpt"].items()}
            tt = {txn: dict(info) for txn, info in checkpoint["tt"].items()}
        else:
            dpt, tt = {}, {}
        for rec in tail:
            rtype = rec["type"]
            if rtype == "BEGIN":
                tt[rec["txn"]] = {"status": "running", "last_lsn": rec["lsn"]}
            elif rtype in ("UPDATE", "CLR"):
                tt[rec["txn"]]["last_lsn"] = rec["lsn"]
                dpt.setdefault(rec["page"], rec["lsn"])
            elif rtype == "COMMIT":
                tt[rec["txn"]]["status"] = "committed"
                tt[rec["txn"]]["last_lsn"] = rec["lsn"]
            elif rtype == "END":
                tt.pop(rec["txn"], None)

        # --- redo: replay history from the oldest recLSN ---
        redone = 0
        if dpt:
            start = min(dpt.values())
            for rec in records:
                if rec["lsn"] < start or rec["type"] not in ("UPDATE", "CLR"):
                    continue
                page_id = rec["page"]
                if page_id not in dpt or rec["lsn"] < dpt[page_id]:
                    continue
                page_lsn, data = self.pages.read_page(page_id)
                if page_lsn < rec["lsn"]:
                    _apply(data, rec["key"], rec["after"])
                    self.pages.write_page(page_id, rec["lsn"], data)
                    redone += 1

        # --- undo: roll back losers, writing a CLR per step ---
        losers = {
            txn: info["last_lsn"]
            for txn, info in tt.items() if info["status"] != "committed"
        }
        loser_txns = sorted(losers)
        clrs = 0
        while losers:
            txn = max(losers, key=lambda t: losers[t])
            rec = by_lsn[losers[txn]]
            if rec["type"] == "UPDATE":
                clr = {
                    "type": "CLR", "txn": txn, "prev": rec["lsn"],
                    "page": rec["page"], "key": rec["key"],
                    "before": rec["after"], "after": rec["before"],
                    "undo_next": rec["prev"],
                }
                clr_lsn = self.wal.append(clr)
                by_lsn[clr_lsn] = clr
                _, data = self.pages.read_page(rec["page"])
                _apply(data, rec["key"], rec["before"])
                self.pages.write_page(rec["page"], clr_lsn, data)
                clrs += 1
                nxt = rec["prev"]
            elif rec["type"] == "CLR":
                nxt = rec["undo_next"]
            else:  # BEGIN
                nxt = 0
            if nxt:
                losers[txn] = nxt
            else:
                self.wal.append({"type": "END", "txn": txn, "prev": rec["lsn"]})
                del losers[txn]

        self.alive = True
        return {"redone": redone, "clrs": clrs, "losers": loser_txns}

    # ---------------- inspection ----------------

    def dump(self):
        """Return the current physical database state as a dict."""
        state = {}
        for page_id in range(PAGE_COUNT):
            if page_id in self.buffer:
                state.update(self.buffer[page_id]["data"])
            else:
                _, data = self.pages.read_page(page_id)
                state.update(data)
        return state

    def close(self):
        self.wal.close()
