"""Gateway: manages transfers, epochs, timeouts, checkpoints, commit log."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .fragments import Fragment, sha256_hex
from .transfer import SubmitResult, SubmitStatus, TransferState


def _safe_name(transfer_id: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in transfer_id)


@dataclass
class GatewayConfig:
    workdir: str
    memory_threshold: int = 1 << 20
    timeout: float = 30.0
    out_dir: Optional[str] = None


class Gateway:
    def __init__(self, config: GatewayConfig) -> None:
        self.config = config
        self.workdir = config.workdir
        self.out_dir = config.out_dir or os.path.join(self.workdir, "out")
        self.checkpoint_dir = os.path.join(self.workdir, "checkpoints")
        self.commit_log_path = os.path.join(self.workdir, "commit.log")
        for d in (self.workdir, self.out_dir, self.checkpoint_dir):
            os.makedirs(d, exist_ok=True)
        self._transfers: Dict[Tuple[str, int], TransferState] = {}
        self._lock = threading.RLock()
        self.now: float = 0.0

    # -- commit log ------------------------------------------------------

    def _log(self, entry: dict) -> None:
        with self._lock:
            with open(self.commit_log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())

    def _read_log(self) -> List[dict]:
        if not os.path.exists(self.commit_log_path):
            return []
        out = []
        with open(self.commit_log_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    # -- checkpoints -----------------------------------------------------

    def _checkpoint_path(self, transfer_id: str, epoch: int) -> str:
        return os.path.join(
            self.checkpoint_dir, f"{_safe_name(transfer_id)}-{epoch}.json"
        )

    def _write_checkpoint(self, state: TransferState) -> None:
        path = self._checkpoint_path(state.transfer_id, state.epoch)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state.to_checkpoint(), fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        state.dirty = False

    def _drop_checkpoint(self, transfer_id: str, epoch: int) -> None:
        try:
            os.unlink(self._checkpoint_path(transfer_id, epoch))
        except FileNotFoundError:
            pass

    # -- transfer access ---------------------------------------------------

    def _get_or_create(self, frag: Fragment) -> TransferState:
        key = (frag.transfer_id, frag.epoch)
        state = self._transfers.get(key)
        if state is None:
            state = TransferState(
                frag.transfer_id,
                frag.epoch,
                self.workdir,
                self.config.memory_threshold,
            )
            self._transfers[key] = state
        return state

    def get(self, transfer_id: str, epoch: int = 0) -> Optional[TransferState]:
        return self._transfers.get((transfer_id, epoch))

    # -- operations ------------------------------------------------------

    def submit(self, frag: Fragment, now: Optional[float] = None) -> SubmitResult:
        with self._lock:
            if now is None:
                now = self.now
            state = self._get_or_create(frag)
            result = state.submit(frag, now)
            if state.dirty:
                self._write_checkpoint(state)
            return result

    def retract(
        self, transfer_id: str, epoch: int, frag_id: str, now: Optional[float] = None
    ) -> bool:
        with self._lock:
            if now is None:
                now = self.now
            state = self._transfers.get((transfer_id, epoch))
            if state is None:
                return False
            ok = state.retract(frag_id, now)
            if ok and state.dirty:
                self._write_checkpoint(state)
            return ok

    def finalize(
        self, transfer_id: str, epoch: int = 0, now: Optional[float] = None
    ) -> dict:
        """Verify total hash and atomically publish a complete transfer."""
        with self._lock:
            if now is None:
                now = self.now
            state = self._transfers.get((transfer_id, epoch))
            if state is None:
                return {"status": "unknown_transfer"}
            if state.finalized:
                return {"status": "already_finalized"}
            if not state.complete:
                return {"status": "incomplete", "gaps": state.gaps()}
            # Mutual exclusion with timeout reclamation: mark committing
            # while still holding the gateway lock.
            state.committing = True
            state.last_activity = now
        try:
            data = state.assembled()
            digest = sha256_hex(data)
            if state.total_hash is not None and state.total_hash != digest:
                self._log(
                    {
                        "event": "abort_commit",
                        "transfer_id": transfer_id,
                        "epoch": epoch,
                        "reason": "total_hash_mismatch",
                        "expected": state.total_hash,
                        "actual": digest,
                    }
                )
                return {
                    "status": "hash_mismatch",
                    "expected": state.total_hash,
                    "actual": digest,
                }
            target = os.path.join(self.out_dir, _safe_name(transfer_id) + ".bin")
            tmp = os.path.join(
                self.out_dir,
                f".{_safe_name(transfer_id)}-{epoch}-{os.getpid()}.tmp",
            )
            self._log(
                {
                    "event": "begin_commit",
                    "transfer_id": transfer_id,
                    "epoch": epoch,
                    "target": target,
                    "tmp": tmp,
                    "total_hash": digest,
                }
            )
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, target)
            self._log(
                {
                    "event": "end_commit",
                    "transfer_id": transfer_id,
                    "epoch": epoch,
                    "target": target,
                }
            )
            with self._lock:
                state.finalized = True
            self._drop_checkpoint(transfer_id, epoch)
            return {"status": "published", "path": target, "sha256": digest}
        finally:
            with self._lock:
                state.committing = False

    def advance_time(self, now: float) -> List[Tuple[str, int]]:
        """Reclaim idle incomplete transfers; never touches committing or
        finalized ones (mutual exclusion with in-progress commits)."""
        reclaimed: List[Tuple[str, int]] = []
        with self._lock:
            self.now = now
            for key, state in list(self._transfers.items()):
                if state.finalized or state.committing:
                    continue
                if now - state.last_activity >= self.config.timeout:
                    state.storage.cleanup()
                    self._drop_checkpoint(*key)
                    del self._transfers[key]
                    reclaimed.append(key)
        return reclaimed

    def status(self, transfer_id: str, epoch: int = 0) -> dict:
        state = self._transfers.get((transfer_id, epoch))
        if state is None:
            return {"transfer_id": transfer_id, "epoch": epoch, "present": False}
        doc = state.status()
        doc["present"] = True
        return doc

    def retransmit_plan(
        self, transfer_id: str, epoch: int, mtu: int
    ) -> List[Tuple[int, int]]:
        state = self._transfers.get((transfer_id, epoch))
        if state is None:
            return []
        return state.retransmit_plan(mtu)

    # -- recovery ----------------------------------------------------------

    def recover(self) -> dict:
        """Restore state from checkpoints and reconcile the commit log.

        Idempotent: running it twice yields the same state and never
        re-publishes.  A begin_commit without end_commit means the crash
        happened before the atomic replace (or right after); either way
        no holey file is published - the leftover tmp file is removed.
        """
        restored: List[str] = []
        with self._lock:
            for name in sorted(os.listdir(self.checkpoint_dir)):
                if not name.endswith(".json"):
                    continue
                path = os.path.join(self.checkpoint_dir, name)
                with open(path, "r", encoding="utf-8") as fh:
                    doc = json.load(fh)
                key = (doc["transfer_id"], doc["epoch"])
                if key in self._transfers:
                    continue
                state = TransferState.from_checkpoint(
                    doc, self.workdir, self.config.memory_threshold
                )
                self._transfers[key] = state
                restored.append(f"{key[0]}:{key[1]}")

        orphaned_tmp: List[str] = []
        ended = {
            (e["transfer_id"], e["epoch"], e["target"])
            for e in self._read_log()
            if e.get("event") == "end_commit"
        }
        for entry in self._read_log():
            if entry.get("event") != "begin_commit":
                continue
            key = (entry["transfer_id"], entry["epoch"], entry["target"])
            if key in ended:
                continue
            tmp = entry.get("tmp")
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)
                orphaned_tmp.append(tmp)
        return {"restored": restored, "orphaned_tmp_removed": orphaned_tmp}
