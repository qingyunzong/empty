"""Transfer gateway: epoch management, timeout reclamation, checkpointing,
commit log and atomic publish.

Recovery invariant: a file is published only after its whole-file hash has
been verified; the commit log records the intent, and replaying it after a
crash re-verifies before publishing, so a holed or tampered file can never
reach the publish directory.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading

from .fragments import Fragment
from .reassembler import (
    BadFragmentError,
    ConflictError,
    LengthChangeError,
    Reassembler,
)


def _atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".",
                               prefix=".tmp-", suffix=".swap")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Gateway:
    def __init__(
        self,
        workdir: str,
        publish_dir: str,
        *,
        memory_threshold: int = 1 << 20,
        timeout: float = 60.0,
    ) -> None:
        self.workdir = workdir
        self.publish_dir = publish_dir
        self.memory_threshold = memory_threshold
        self.timeout = timeout
        self.spool_dir = os.path.join(workdir, "spool")
        self.checkpoint_dir = os.path.join(workdir, "checkpoints")
        self.commit_log_path = os.path.join(workdir, "commit.log")
        self.reassemblers: dict[tuple[str, int], Reassembler] = {}
        self.epochs: dict[str, int] = {}
        self.published: dict[str, str] = {}   # transfer_id -> sha256
        self.events: list[dict] = []
        self._commit_lock = threading.Lock()  # serializes commit vs reclaim
        os.makedirs(self.spool_dir, exist_ok=True)
        os.makedirs(self.checkpoint_dir, exist_ok=True)

    # ------------------------------------------------------------ epoch
    def current_epoch(self, transfer_id: str) -> int:
        return self.epochs.get(transfer_id, 0)

    def start_new_epoch(self, transfer_id: str) -> int:
        """Only way to change total_length: abandon old epoch, open a new one."""
        old = self.current_epoch(transfer_id)
        old_r = self.reassemblers.pop((transfer_id, old), None)
        if old_r is not None:
            old_r.discard()
            self._remove_checkpoint(transfer_id, old)
        self.epochs[transfer_id] = old + 1
        self.events.append({"event": "new_epoch", "transfer_id": transfer_id,
                            "epoch": old + 1})
        return old + 1

    def _get(self, transfer_id: str, epoch: int) -> Reassembler:
        key = (transfer_id, epoch)
        r = self.reassemblers.get(key)
        if r is None:
            r = Reassembler(transfer_id, epoch,
                            memory_threshold=self.memory_threshold,
                            spool_dir=self.spool_dir)
            self.reassemblers[key] = r
        return r

    # ------------------------------------------------------------- intake
    def add_fragment(self, frag: Fragment, now: float = 0.0) -> dict:
        if frag.epoch < self.current_epoch(frag.transfer_id):
            raise BadFragmentError("stale epoch fragment dropped")
        r = self._get(frag.transfer_id, frag.epoch)
        status = r.add(frag, now=now)
        self._checkpoint(r)
        if status == "complete":
            self.commit(frag.transfer_id, frag.epoch)
        return {"transfer_id": frag.transfer_id, "epoch": frag.epoch,
                "status": status,
                "complete": r.is_complete(),
                "committed": r.committed}

    def withdraw(self, transfer_id: str, epoch: int, fragment_id: str,
                 now: float = 0.0) -> dict:
        r = self.reassemblers.get((transfer_id, epoch))
        if r is None:
            return {"withdrawn": False}
        ok = r.withdraw(fragment_id, now=now)
        self._checkpoint(r)
        return {"withdrawn": ok, "gaps": r.gaps()}

    # ------------------------------------------------------------- commit
    def commit(self, transfer_id: str, epoch: int) -> bool:
        """Verify whole-file hash, append commit log, atomically publish.

        Holds the gateway commit lock so a timeout reclaimer can never
        tear down a transfer while its complete file is being committed.
        """
        r = self.reassemblers.get((transfer_id, epoch))
        if r is None or not r.is_complete():
            return False
        with self._commit_lock:
            if not r.begin_commit():
                return r.committed
            try:
                if not r.verify():
                    r.failed = True
                    self.events.append({"event": "commit_rejected",
                                        "transfer_id": transfer_id,
                                        "epoch": epoch})
                    return False
                self._append_commit_log(transfer_id, epoch,
                                        r.total_length or 0,
                                        r.total_hash or "")
                data = r.assemble()
                _atomic_write(os.path.join(self.publish_dir, transfer_id), data)
                r.committed = True
                self.published[transfer_id] = r.total_hash or ""
                self.events.append({"event": "committed",
                                    "transfer_id": transfer_id, "epoch": epoch})
                return True
            finally:
                r.end_commit()

    def _append_commit_log(self, tid: str, epoch: int, length: int,
                           digest: str) -> None:
        os.makedirs(self.workdir, exist_ok=True)
        record = json.dumps({"op": "commit", "transfer_id": tid,
                             "epoch": epoch, "total_length": length,
                             "total_hash": digest}) + "\n"
        with open(self.commit_log_path, "a", encoding="utf-8") as fh:
            fh.write(record)
            fh.flush()
            os.fsync(fh.fileno())

    # ------------------------------------------------------------ timeout
    def tick(self, now: float) -> list[dict]:
        """Reclaim expired transfers; never one that is mid-commit."""
        reclaimed = []
        for key, r in list(self.reassemblers.items()):
            if r.committed or r.failed:
                continue
            if now - r.last_activity < self.timeout:
                continue
            if r.committing:
                # complete file is being published right now: commit wins
                continue
            if not self._commit_lock.acquire(blocking=False):
                continue
            try:
                if r.committing:
                    continue
                r.failed = True
                r.discard()
                del self.reassemblers[key]
                self._remove_checkpoint(*key)
                reclaimed.append({"event": "reclaimed",
                                  "transfer_id": key[0], "epoch": key[1]})
            finally:
                self._commit_lock.release()
        self.events.extend(reclaimed)
        return reclaimed

    # --------------------------------------------------------- checkpoint
    def _checkpoint_path(self, tid: str, epoch: int) -> str:
        safe = tid.replace("/", "_")
        return os.path.join(self.checkpoint_dir, f"{safe}.{epoch}.json")

    def _checkpoint(self, r: Reassembler) -> None:
        state = {
            "transfer_id": r.transfer_id,
            "epoch": r.epoch,
            "total_length": r.total_length,
            "total_hash": r.total_hash,
            "spilled": r.spilled,
            "temp_file": (os.path.basename(r.temp_path)
                          if r.temp_path else None),
            "fragments": [
                {"fragment_id": fid, "offset": off, "end": end, "hash": h}
                for fid, (off, end, h) in r.fragments.items()
            ],
        }
        _atomic_write(self._checkpoint_path(r.transfer_id, r.epoch),
                      json.dumps(state).encode())

    def _remove_checkpoint(self, tid: str, epoch: int) -> None:
        try:
            os.unlink(self._checkpoint_path(tid, epoch))
        except OSError:
            pass

    # ---------------------------------------------------------- recovery
    @classmethod
    def recover(cls, workdir: str, publish_dir: str, **kw) -> "Gateway":
        """Rebuild from checkpoints + commit log.

        A transfer is (re)published only if its stored evidence still
        verifies; tampered temp files are quarantined, never published.
        Recovery is idempotent: running it twice changes nothing.
        """
        gw = cls(workdir, publish_dir, **kw)
        committed: dict[str, dict] = {}
        if os.path.exists(gw.commit_log_path):
            with open(gw.commit_log_path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        rec = json.loads(line)
                        committed[rec["transfer_id"]] = rec
        for name in sorted(os.listdir(gw.checkpoint_dir)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(gw.checkpoint_dir, name),
                      encoding="utf-8") as fh:
                state = json.load(fh)
            tid, epoch = state["transfer_id"], state["epoch"]
            r = gw._get(tid, epoch)
            r.total_length = state["total_length"]
            r.total_hash = state["total_hash"]
            if state.get("spilled") and state.get("temp_file"):
                path = os.path.join(gw.spool_dir, state["temp_file"])
                if not os.path.exists(path):
                    r.failed = True
                    gw.events.append({"event": "quarantined",
                                      "transfer_id": tid, "epoch": epoch,
                                      "reason": "missing temp file"})
                    continue
                fd = os.open(path, os.O_RDWR)
                r._file = os.fdopen(fd, "r+b")
                r._file_path = path
            for frag in state["fragments"]:
                r.fragments[frag["fragment_id"]] = (
                    frag["offset"], frag["end"], frag["hash"])
                r.coverage.add(frag["offset"], frag["end"],
                               frag["fragment_id"])
            if not r.verify_fragment_evidence():
                r.failed = True
                gw.events.append({"event": "quarantined",
                                  "transfer_id": tid, "epoch": epoch,
                                  "reason": "temp file tampered"})
                continue
            gw.epochs[tid] = max(gw.epochs.get(tid, 0), epoch)
        # replay commit log: publish only what still verifies
        for tid, rec in committed.items():
            target = os.path.join(publish_dir, tid)
            r = gw.reassemblers.get((tid, rec["epoch"]))
            if os.path.exists(target):
                gw.published[tid] = rec["total_hash"]
                continue
            if r is not None and not r.failed and r.verify():
                _atomic_write(target, r.assemble())
                r.committed = True
                gw.published[tid] = rec["total_hash"]
            else:
                gw.events.append({"event": "commit_dropped",
                                  "transfer_id": tid,
                                  "reason": "evidence no longer verifies"})
        return gw

    # ------------------------------------------------------------- query
    def gaps(self, transfer_id: str, epoch: int) -> list[tuple[int, int]]:
        r = self.reassemblers.get((transfer_id, epoch))
        return r.gaps() if r else []

    def retransmit_plan(self, transfer_id: str, epoch: int,
                        mtu: int) -> list[tuple[int, int]]:
        r = self.reassemblers.get((transfer_id, epoch))
        return r.retransmit_plan(mtu) if r else []

    def status(self) -> dict:
        return {
            "transfers": {
                f"{tid}@{ep}": {
                    "total_length": r.total_length,
                    "covered": r.coverage.covered_bytes(),
                    "gaps": r.gaps(),
                    "spilled": r.spilled,
                    "committed": r.committed,
                    "failed": r.failed,
                    "fragments": sorted(r.fragments),
                }
                for (tid, ep), r in sorted(self.reassemblers.items())
            },
            "published": dict(self.published),
        }
