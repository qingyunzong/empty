"""Paged key-value store with write-ahead logging and ARIES recovery.

* Steal / no-force buffer pool: dirty pages may be flushed before their
  transaction commits; commit only forces the log.
* Physiological logging: update records carry the before/after image of a
  single key on a page, so interleaved transactions sharing a page undo
  correctly.
* Every page stores a pageLSN; redo is idempotent via pageLSN comparison.
* Undo writes compensation log records (CLRs) with ``undo_next`` so a
  crash during recovery never undoes the same record twice.
* Fuzzy checkpoints snapshot the active transaction table (ATT) and dirty
  page table (DPT) without blocking writers; the log prefix is recycled
  only after the checkpoint and all required log are durable.
"""

import json
import struct
import zlib

from .logrec import encode_record, scan_log

PAGE_HEADER = struct.Struct("<QI")  # page_lsn, payload_length


class LockError(Exception):
    """A write tried to modify a key locked by another active transaction."""


class Page:
    __slots__ = ("page_id", "page_lsn", "entries", "dirty")

    def __init__(self, page_id, page_lsn=0, entries=None):
        self.page_id = page_id
        self.page_lsn = page_lsn
        self.entries = entries if entries is not None else {}
        self.dirty = False


class Database:
    def __init__(self, adapter, num_pages=16, page_size=1024):
        self.adapter = adapter
        self.num_pages = num_pages
        self.page_size = page_size
        self.pages = {}            # page_id -> Page (buffer pool)
        self.dpt = {}              # page_id -> recLSN (runtime dirty page table)
        self.txns = {}             # txn_id -> {last, first, status}
        self.log_index = {}        # lsn -> record dict
        self.log_frames = []       # (lsn, frame bytes) currently in the log file
        self.next_lsn = 1
        self._txn_counter = 0
        self.trace = []
        self.locks = {}            # key -> txn_id (strict 2PL, exclusive)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _trace(self, phase, action, reason):
        self.trace.append({"phase": phase, "action": action, "reason": reason})

    def page_for(self, key):
        return zlib.crc32(key.encode()) % self.num_pages

    def _append(self, rec, boundary="log_write"):
        rec["lsn"] = self.next_lsn
        self.next_lsn += 1
        frame = encode_record(rec)
        self.adapter.append_log(frame, boundary=boundary)
        self.log_index[rec["lsn"]] = rec
        self.log_frames.append((rec["lsn"], frame))
        return rec

    # -- pages -----------------------------------------------------------
    def _serialize_page(self, page):
        payload = json.dumps(page.entries, sort_keys=True).encode()
        return PAGE_HEADER.pack(page.page_lsn, len(payload)) + payload

    def _fetch(self, page_id):
        page = self.pages.get(page_id)
        if page is not None:
            return page
        raw = self.adapter.read_page(page_id)
        if raw is None:
            page = Page(page_id)
        else:
            page_lsn, length = PAGE_HEADER.unpack_from(raw)
            entries = json.loads(raw[PAGE_HEADER.size : PAGE_HEADER.size + length])
            page = Page(page_id, page_lsn=page_lsn, entries=entries)
        self.pages[page_id] = page
        return page

    def _mark_dirty(self, page):
        page.dirty = True
        self.dpt.setdefault(page.page_id, page.page_lsn)

    def flush_page(self, page_id):
        """Write a dirty page, honouring the WAL rule (log synced first)."""
        page = self.pages.get(page_id)
        if page is None or not page.dirty:
            return
        self.adapter.sync_log()
        self.adapter.write_page(page_id, self._serialize_page(page))
        page.dirty = False
        self.dpt.pop(page_id, None)

    def flush_all(self):
        for page_id in sorted(self.pages):
            self.flush_page(page_id)

    # ------------------------------------------------------------------
    # transaction API
    # ------------------------------------------------------------------
    def begin(self, txn=None):
        if txn is None:
            self._txn_counter += 1
            txn = f"T{self._txn_counter}"
        if txn in self.txns:
            raise ValueError(f"transaction {txn!r} already active")
        self.txns[txn] = {"last": 0, "first": 0, "status": "running"}
        return txn

    def _txn(self, txn):
        if txn not in self.txns:
            raise ValueError(f"unknown transaction {txn!r}")
        return self.txns[txn]

    def get(self, txn, key):
        self._txn(txn)
        return self._fetch(self.page_for(key)).entries.get(key)

    def _update(self, txn, key, value):
        state = self._txn(txn)
        owner = self.locks.get(key)
        if owner is not None and owner != txn:
            raise LockError(f"key {key!r} is locked by transaction {owner!r}")
        page = self._fetch(self.page_for(key))
        new_entries = dict(page.entries)
        if value is None:
            new_entries.pop(key, None)
        else:
            new_entries[key] = value
        if PAGE_HEADER.size + len(json.dumps(new_entries)) > self.page_size:
            raise ValueError(f"page {page.page_id} is full")
        rec = self._append(
            {
                "txn": txn,
                "prev": state["last"],
                "type": "update",
                "page": page.page_id,
                "key": key,
                "before": page.entries.get(key),
                "after": value,
            }
        )
        if not state["first"]:
            state["first"] = rec["lsn"]
        state["last"] = rec["lsn"]
        page.entries = new_entries
        page.page_lsn = rec["lsn"]
        self._mark_dirty(page)
        self.locks[key] = txn

    def put(self, txn, key, value):
        self._update(txn, key, value)

    def delete(self, txn, key):
        self._update(txn, key, None)

    def commit(self, txn):
        state = self._txn(txn)
        self._append({"txn": txn, "prev": state["last"], "type": "commit"})
        # no-force: pages stay in the pool, but the log must be durable
        # before commit returns.
        self.adapter.sync_log()
        self._release_locks(txn)
        del self.txns[txn]

    def abort(self, txn):
        state = self._txn(txn)
        self._rollback(txn, state)
        self._append({"txn": txn, "prev": state["last"], "type": "abort"})
        self.adapter.sync_log()
        self._release_locks(txn)
        del self.txns[txn]

    def _release_locks(self, txn):
        self.locks = {k: t for k, t in self.locks.items() if t != txn}

    def _rollback(self, txn, state):
        lsn = state["last"]
        while lsn:
            rec = self.log_index[lsn]
            if rec["type"] == "update":
                clr = self._undo_update(txn, rec, prev=lsn)
                state["last"] = clr["lsn"]
                lsn = rec["prev"]
            elif rec["type"] == "clr":
                lsn = rec["undo_next"]
            else:
                lsn = rec["prev"]

    def _undo_update(self, txn, rec, prev=0):
        """Write a CLR for ``rec`` and apply its before-image to the page."""
        page = self._fetch(rec["page"])
        clr = self._append(
            {
                "txn": txn,
                "prev": prev,
                "type": "clr",
                "page": rec["page"],
                "key": rec["key"],
                "after": rec["before"],
                "undo_next": rec["prev"],
            },
            boundary="clr_write",
        )
        # Make the CLR durable immediately so a crash mid-undo can rely on
        # undoNextLSN instead of re-undoing.
        self.adapter.sync_log()
        self._apply_image(page, rec["key"], rec["before"])
        page.page_lsn = clr["lsn"]
        self._mark_dirty(page)
        return clr

    @staticmethod
    def _apply_image(page, key, value):
        if value is None:
            page.entries.pop(key, None)
        else:
            page.entries[key] = value

    # ------------------------------------------------------------------
    # fuzzy checkpoint + log recycling
    # ------------------------------------------------------------------
    def checkpoint(self):
        begin = self._append({"txn": 0, "prev": 0, "type": "begin_ckpt"})
        # Fuzzy: writers keep running; the snapshot is consistent enough
        # because recovery merges it with the log scan from begin_ckpt.
        att_snap = {t: dict(info) for t, info in self.txns.items()}
        dpt_snap = dict(self.dpt)
        end = self._append(
            {
                "txn": 0,
                "prev": 0,
                "type": "end_ckpt",
                "begin_lsn": begin["lsn"],
                "att": att_snap,
                "dpt": {str(p): l for p, l in dpt_snap.items()},
            },
            boundary="ckpt_publish",
        )
        self.flush_all()
        self.adapter.sync_log()
        # Recycle the prefix only now that the checkpoint and every log
        # record it may need are durable.
        candidates = list(dpt_snap.values())
        candidates += [i["first"] for i in att_snap.values() if i.get("first")]
        cutoff = min(candidates + [begin["lsn"]])
        self._recycle(cutoff)
        return end["lsn"]

    def _recycle(self, cutoff):
        if not self.log_frames:
            return
        retained = [(l, f) for l, f in self.log_frames if l >= cutoff]
        if len(retained) == len(self.log_frames):
            return
        self.adapter.rewrite_log(b"".join(f for _, f in retained))
        self.log_frames = retained
        self.log_index = {l: self.log_index[l] for l, _ in retained}
        self._trace(
            "checkpoint",
            "recycle-log",
            f"log prefix below LSN {cutoff} recycled; checkpoint and required "
            "log are durable",
        )

    # ------------------------------------------------------------------
    # ARIES recovery: analysis, redo, undo
    # ------------------------------------------------------------------
    def recover(self):
        self.trace = []
        data = self.adapter.read_log()
        records, valid = scan_log(data)
        if valid < len(data):
            self.adapter.rewrite_log(data[:valid])
            self._trace(
                "analysis",
                "truncate-tail",
                f"discarded {len(data) - valid} bytes of incomplete tail record",
            )
        self.log_frames = [(r["lsn"], encode_record(r)) for r in records]
        self.log_index = {r["lsn"]: r for r in records}
        self.next_lsn = max(self.log_index, default=0) + 1
        self.pages = {}
        self.dpt = {}
        self.txns = {}
        self.locks = {}

        # ---- analysis --------------------------------------------------
        ckpt = None
        for rec in records:
            if rec["type"] == "end_ckpt":
                ckpt = rec
        att, dpt = {}, {}
        start = 0
        if ckpt is not None:
            att = {t: dict(i) for t, i in ckpt["att"].items()}
            dpt = {int(p): l for p, l in ckpt["dpt"].items()}
            start = ckpt["begin_lsn"]
            self._trace(
                "analysis",
                "checkpoint",
                f"restored fuzzy checkpoint at LSN {ckpt['lsn']}: "
                f"{len(att)} active txns, {len(dpt)} dirty pages",
            )
        for rec in records:
            if rec["lsn"] < start:
                continue
            rtype = rec["type"]
            if rtype in ("update", "clr"):
                info = att.setdefault(
                    rec["txn"], {"last": 0, "first": 0, "status": "running"}
                )
                if not info["first"]:
                    info["first"] = rec["lsn"]
                info["last"] = rec["lsn"]
                dpt.setdefault(rec["page"], rec["lsn"])
            elif rtype == "commit":
                info = att.setdefault(
                    rec["txn"], {"last": 0, "first": 0, "status": "running"}
                )
                info["last"] = rec["lsn"]
                info["status"] = "committed"
            elif rtype == "abort":
                att.pop(rec["txn"], None)

        # ---- redo ------------------------------------------------------
        redo_from = min(dpt.values()) if dpt else None
        for rec in records:
            if rec["type"] not in ("update", "clr"):
                continue
            if redo_from is None or rec["lsn"] < redo_from:
                continue
            page_id = rec["page"]
            rec_lsn = dpt.get(page_id)
            if rec_lsn is None or rec["lsn"] < rec_lsn:
                self._trace(
                    "redo",
                    "skip",
                    f"LSN {rec['lsn']} page {page_id}: page clean at that LSN "
                    "(already on disk before checkpoint)",
                )
                continue
            page = self._fetch(page_id)
            if page.page_lsn >= rec["lsn"]:
                self._trace(
                    "redo",
                    "skip",
                    f"LSN {rec['lsn']} page {page_id}: pageLSN "
                    f"{page.page_lsn} already covers it (idempotent redo)",
                )
                continue
            old_lsn = page.page_lsn
            self._apply_image(page, rec["key"], rec["after"])
            page.page_lsn = rec["lsn"]
            self._mark_dirty(page)
            self._trace(
                "redo",
                "apply",
                f"LSN {rec['lsn']} page {page_id} key {rec['key']!r}: "
                f"pageLSN {old_lsn} < LSN, reapplied {rec['type']}",
            )

        # ---- undo ------------------------------------------------------
        losers = {t: i for t, i in att.items() if i["status"] != "committed"}
        for txn, info in sorted(losers.items()):
            self._trace(
                "undo",
                "loser",
                f"txn {txn} was uncommitted at crash; undoing from "
                f"LSN {info['last']}",
            )
        while losers:
            txn = max(losers, key=lambda t: losers[t]["last"])
            info = losers[txn]
            lsn = info["last"]
            if not lsn:
                self._append({"txn": txn, "prev": 0, "type": "abort"})
                self._trace(
                    "undo",
                    "abort-record",
                    f"txn {txn} fully undone; abort record closes it",
                )
                del losers[txn]
                continue
            rec = self.log_index[lsn]
            if rec["type"] == "clr":
                info["last"] = rec["undo_next"]
                self._trace(
                    "undo",
                    "skip-clr",
                    f"txn {txn} LSN {lsn} already compensated; following "
                    f"undoNextLSN {rec['undo_next']} (no repeated undo)",
                )
            elif rec["type"] == "update":
                clr = self._undo_update(txn, rec, prev=lsn)
                info["last"] = clr["lsn"]
                self._trace(
                    "undo",
                    "compensate",
                    f"txn {txn} undid LSN {lsn} (key {rec['key']!r}) via "
                    f"CLR LSN {clr['lsn']}",
                )
            else:
                info["last"] = rec["prev"]

        self.adapter.sync_log()
        self.flush_all()
        self._trace(
            "recover",
            "done",
            f"analysis+redo+undo complete; next LSN {self.next_lsn}",
        )
        return self.trace

    # ------------------------------------------------------------------
    def dump(self):
        """Merged view of every key in the store (for verification)."""
        state = {}
        for page_id in range(self.num_pages):
            state.update(self._fetch(page_id).entries)
        return state
