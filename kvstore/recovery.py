"""ARIES-style recovery: analysis, idempotent redo, loser undo."""

from __future__ import annotations

import json

from .engine import TxState, apply_after_image
from .wal import CLR, COMMIT, END, UPDATE


def recover(engine) -> None:
    emit = engine._emit
    emit("analysis", "start",
         "recovery starts: reading master record and scanning the log")

    master = {}
    if engine.adapter.exists(engine.master_path):
        raw = engine.adapter.read(engine.master_path)
        if raw:
            master = json.loads(raw)
    base = master.get("log_base", 0)
    ckpt_lsn = master.get("checkpoint_lsn")

    records, tail = engine.log.open(base)
    if tail is not None:
        emit("analysis", "truncate_tail",
             f"log tail ends with an incomplete/torn record ({tail}); "
             f"truncated it, all complete records kept")

    # ------------------------------------------------------------- analysis
    att: dict[int, dict] = {}
    dpt: dict[int, int] = {}
    start_lsn = -1
    if ckpt_lsn is not None and ckpt_lsn in engine.log.records:
        ck = engine.log.records[ckpt_lsn]
        for tid, st in ck.payload.get("att", {}).items():
            att[int(tid)] = dict(st)
        for pid, rlsn in ck.payload.get("dpt", {}).items():
            dpt[int(pid)] = rlsn
        start_lsn = ckpt_lsn
        emit("analysis", "checkpoint",
             f"restored ATT ({len(att)} txn) and DPT ({len(dpt)} pages) from "
             f"checkpoint at LSN {ckpt_lsn}", lsn=ckpt_lsn)

    max_txid = 0
    for rec in records:
        if rec.lsn <= start_lsn:
            continue
        if rec.rtype in (UPDATE, CLR):
            st = att.setdefault(rec.txid, {"last_lsn": rec.lsn,
                                           "first_lsn": rec.lsn,
                                           "status": "running"})
            st["last_lsn"] = rec.lsn
            dpt.setdefault(rec.page_id, rec.lsn)
        elif rec.rtype == COMMIT:
            st = att.setdefault(rec.txid, {"last_lsn": rec.lsn,
                                           "first_lsn": rec.lsn,
                                           "status": "committed"})
            st["last_lsn"] = rec.lsn
            st["status"] = "committed"
        elif rec.rtype == END:
            att.pop(rec.txid, None)
        if rec.rtype in (UPDATE, CLR, COMMIT, END):
            max_txid = max(max_txid, rec.txid)
    for tid in att:
        max_txid = max(max_txid, tid)
    emit("analysis", "done",
         f"analysis: {len(att)} txn(s) open at crash, DPT has {len(dpt)} "
         f"dirty page(s)")

    # ----------------------------------------------------------------- redo
    redo_from = min(dpt.values()) if dpt else None
    for rec in records:
        if rec.rtype not in (UPDATE, CLR):
            continue
        if redo_from is not None and rec.lsn < redo_from:
            continue
        if rec.page_id not in dpt or rec.lsn < dpt[rec.page_id]:
            emit("redo", "skip",
                 f"LSN {rec.lsn} ({rec.type_name}) precedes recLSN of page "
                 f"{rec.page_id}; page was already flushed", lsn=rec.lsn)
            continue
        page = engine.pool.fetch(rec.page_id)
        if page.page_lsn < rec.lsn:
            old_lsn = page.page_lsn
            apply_after_image(page, rec.payload)
            page.page_lsn = rec.lsn
            engine._mark_dirty_page(page, rec.lsn)
            emit("redo", "redo",
                 f"page {rec.page_id} pageLSN {old_lsn} "
                 f"< LSN {rec.lsn}: reapplied after-image of "
                 f"{rec.payload.get('key')!r}", lsn=rec.lsn,
                 page=rec.page_id)
        else:
            emit("redo", "skip",
                 f"page {rec.page_id} pageLSN {page.page_lsn} >= LSN "
                 f"{rec.lsn}: already applied, redo is idempotent",
                 lsn=rec.lsn, page=rec.page_id)

    # ----------------------------------------------------------------- undo
    losers = {tid: st for tid, st in att.items() if st["status"] != "committed"}
    for tid, st in losers.items():
        emit("undo", "loser",
             f"txn {tid} never committed (lastLSN {st['last_lsn']}); "
             f"rolling back along its prevLSN chain", tx=tid)
        tx = TxState(tid, last_lsn=st["last_lsn"])
        engine._undo_txn(tx)
        end = engine.log.append(END, tid, tx.last_lsn, -1, {})
        emit("undo", "end",
             f"txn {tid} fully undone; END at LSN {end.lsn}", tx=tid,
             lsn=end.lsn)
    for tid, st in att.items():
        if st["status"] == "committed":
            engine.log.append(END, tid, st["last_lsn"], -1, {})
            emit("undo", "end_committed",
                 f"txn {tid} had committed but no END survived; wrote END",
                 tx=tid)

    engine.log.flush(sync=True)
    engine.pool.flush_all()
    engine.dpt.clear()
    engine.tx_table = {}
    engine.key_locks = {}
    engine.next_txid = max_txid + 1
    emit("done", "recovered",
         f"recovery complete: {len(losers)} loser txn(s) rolled back, "
         f"redo was idempotent via pageLSN")
