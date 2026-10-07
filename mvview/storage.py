"""Write-ahead log + checkpoints for crash recovery.

Layout inside the storage directory:
  wal.jsonl        one JSON object per line:
                     {"type": "batch",  "batch_id": N, "batch": {...}}
                     {"type": "commit", "batch_id": N}
  checkpoint.json  full snapshot of base tables, batch id and output cursor

A batch is durable only when its commit record is flushed. Recovery loads
the newest checkpoint, then replays committed batches with batch_id greater
than the checkpoint's id, so committed batches are never applied twice and
an uncommitted log tail (crash mid-batch) is ignored.
"""

from __future__ import annotations

import json
import os
from fractions import Fraction


def _encode_value(value):
    if value is None:
        return None
    return str(value)  # exact "num/den" for Fraction


def _decode_value(value):
    if value is None:
        return None
    return Fraction(value)


class Storage:
    def __init__(self, directory):
        self.dir = directory
        self.wal_path = os.path.join(directory, "wal.jsonl")
        self.ckpt_path = os.path.join(directory, "checkpoint.json")
        os.makedirs(directory, exist_ok=True)
        self._wal = open(self.wal_path, "a", encoding="utf-8")

    def _write(self, record):
        self._wal.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._wal.flush()
        os.fsync(self._wal.fileno())

    def log_batch(self, batch_id, batch):
        self._write({"type": "batch", "batch_id": batch_id, "batch": batch})

    def log_commit(self, batch_id):
        self._write({"type": "commit", "batch_id": batch_id})

    def simulate_uncommitted_tail(self, batch_id, batch):
        """Test helper: a batch record whose commit record is lost (crash)."""
        self._write({"type": "batch", "batch_id": batch_id, "batch": batch})

    def checkpoint(self, engine):
        data = {
            "batch_id": engine.batch_id,
            "left": [[tid, cid, _encode_value(v)] for tid, (cid, v) in engine.left.items()],
            "right": [[cid, grp, m] for (cid, grp), m in engine.right.items()],
            "outputs": engine.outputs,
        }
        tmp = self.ckpt_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.ckpt_path)

    def close(self):
        self._wal.close()

    # ------------------------------------------------------------------ #
    @staticmethod
    def recover(engine, directory):
        """Rebuild engine state from checkpoint + committed WAL records."""
        wal_path = os.path.join(directory, "wal.jsonl")
        ckpt_path = os.path.join(directory, "checkpoint.json")

        ckpt_batch_id = 0
        if os.path.exists(ckpt_path):
            with open(ckpt_path, encoding="utf-8") as fh:
                data = json.load(fh)
            ckpt_batch_id = data["batch_id"]
            engine.left = {
                tid: (cid, _decode_value(v)) for tid, cid, v in data["left"]
            }
            engine.right = {(cid, grp): m for cid, grp, m in data["right"]}
            engine.outputs = list(data["outputs"])
            engine.batch_id = ckpt_batch_id
            engine.rebuild_views()

        if not os.path.exists(wal_path):
            return 0

        pending = {}
        committed = []
        with open(wal_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if rec["type"] == "batch":
                    pending[rec["batch_id"]] = rec["batch"]
                elif rec["type"] == "commit":
                    bid = rec["batch_id"]
                    if bid in pending and bid > ckpt_batch_id:
                        committed.append((bid, pending.pop(bid)))
                    else:
                        pending.pop(bid, None)

        replayed = 0
        for bid, batch in sorted(committed):
            if bid != engine.batch_id + 1:
                raise RuntimeError(f"WAL gap: expected batch {engine.batch_id + 1}, got {bid}")
            engine.apply_batch(batch, _replay=True)
            replayed += 1
        return replayed
