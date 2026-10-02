"""Per-(transfer_id, epoch) reassembly state."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .fragments import Fragment, sha256_hex
from .intervals import IntervalSet
from .storage import MemoryStorage, SparseFileStorage, Storage


class SubmitStatus(enum.Enum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"
    CONFLICT = "conflict"
    REJECTED = "rejected"


@dataclass
class SubmitResult:
    status: SubmitStatus
    reason: str = ""
    conflict_start: Optional[int] = None
    conflict_end: Optional[int] = None
    conflict_frag_incoming: Optional[str] = None
    conflict_frag_existing: Optional[str] = None
    complete: bool = False

    def to_dict(self) -> dict:
        return {
            "status": self.status.value,
            "reason": self.reason,
            "conflict_start": self.conflict_start,
            "conflict_end": self.conflict_end,
            "conflict_frag_incoming": self.conflict_frag_incoming,
            "conflict_frag_existing": self.conflict_frag_existing,
            "complete": self.complete,
        }


class TransferState:
    """Verified-coverage reassembler for one (transfer_id, epoch)."""

    def __init__(
        self,
        transfer_id: str,
        epoch: int,
        workdir: str,
        memory_threshold: int = 1 << 20,
    ) -> None:
        self.transfer_id = transfer_id
        self.epoch = epoch
        self.workdir = workdir
        self.memory_threshold = memory_threshold
        self.total_length: Optional[int] = None
        self.total_hash: Optional[str] = None
        self.coverage = IntervalSet()
        self.fragments: Dict[str, Fragment] = {}
        self.storage: Storage = MemoryStorage()
        self.last_activity: float = 0.0
        self.committing: bool = False
        self.finalized: bool = False
        self.dirty: bool = False

    # -- helpers ---------------------------------------------------------

    @property
    def complete(self) -> bool:
        return (
            self.total_length is not None
            and self.coverage.is_complete(0, self.total_length)
        )

    def _spill_if_needed(self) -> None:
        if (
            isinstance(self.storage, MemoryStorage)
            and self.total_length is not None
            and self.total_length > self.memory_threshold
        ):
            new: Storage = SparseFileStorage(self.workdir, self.total_length)
            for frag in self.fragments.values():
                new.write(frag.offset, frag.data)
            self.storage.cleanup()
            self.storage = new

    def _check_conflict(self, frag: Fragment) -> Optional[SubmitResult]:
        first: Optional[int] = None
        last: Optional[int] = None
        existing_id: Optional[str] = None
        for span in self.coverage.overlapping(frag.offset, frag.end):
            lo = max(frag.offset, span.start)
            hi = min(frag.end, span.end)
            stored = self.storage.read(lo, hi - lo)
            incoming = frag.data[lo - frag.offset:hi - frag.offset]
            for i, (a, b) in enumerate(zip(stored, incoming)):
                if a != b:
                    pos = lo + i
                    if first is None:
                        first = pos
                        existing_id = span.evidence[0] if span.evidence else None
                    last = pos
        if first is None:
            return None
        return SubmitResult(
            status=SubmitStatus.CONFLICT,
            reason="overlapping bytes differ; whole fragment rejected",
            conflict_start=first,
            conflict_end=last + 1 if last is not None else first + 1,
            conflict_frag_incoming=frag.frag_id,
            conflict_frag_existing=existing_id,
            complete=self.complete,
        )

    # -- mutations -------------------------------------------------------

    def submit(self, frag: Fragment, now: float = 0.0) -> SubmitResult:
        self.last_activity = now
        if frag.epoch != self.epoch:
            return SubmitResult(SubmitStatus.REJECTED, "epoch_mismatch")
        if self.finalized:
            return SubmitResult(SubmitStatus.REJECTED, "already_finalized")
        if frag.total_length is not None:
            if self.total_length is None:
                self.total_length = frag.total_length
                self.dirty = True
                self._spill_if_needed()
            elif frag.total_length != self.total_length:
                return SubmitResult(
                    SubmitStatus.REJECTED,
                    "length_conflict: total length already fixed for this "
                    "epoch; open a new epoch to change it",
                )
        if self.total_length is not None and frag.end > self.total_length:
            return SubmitResult(SubmitStatus.REJECTED, "fragment_out_of_bounds")
        if frag.total_hash is not None:
            if self.total_hash is not None and frag.total_hash != self.total_hash:
                return SubmitResult(SubmitStatus.REJECTED, "total_hash_conflict")
            if self.total_hash is None:
                self.total_hash = frag.total_hash
                self.dirty = True

        prior = self.fragments.get(frag.frag_id)
        if prior is not None:
            if prior.offset == frag.offset and prior.data == frag.data:
                return SubmitResult(
                    SubmitStatus.DUPLICATE, "identical fragment", complete=self.complete
                )
            return SubmitResult(
                SubmitStatus.REJECTED, "frag_id_reuse_with_different_content"
            )

        conflict = self._check_conflict(frag)
        if conflict is not None:
            return conflict

        if frag.data:
            self.storage.write(frag.offset, frag.data)
            self.coverage.add(frag.offset, frag.end, frag.frag_id)
        self.fragments[frag.frag_id] = frag
        self.dirty = True
        return SubmitResult(SubmitStatus.ACCEPTED, complete=self.complete)

    def retract(self, frag_id: str, now: float = 0.0) -> bool:
        """Withdraw a fragment; coverage and gaps are recomputed."""
        self.last_activity = now
        if self.finalized or frag_id not in self.fragments:
            return False
        del self.fragments[frag_id]
        self._rebuild()
        self.dirty = True
        return True

    def _rebuild(self) -> None:
        fresh: Storage
        if isinstance(self.storage, SparseFileStorage):
            fresh = SparseFileStorage(self.workdir, self.total_length)
        else:
            fresh = MemoryStorage()
        coverage = IntervalSet()
        for frag in self.fragments.values():
            if frag.data:
                fresh.write(frag.offset, frag.data)
                coverage.add(frag.offset, frag.end, frag.frag_id)
        self.storage.cleanup()
        self.storage = fresh
        self.coverage = coverage

    # -- queries ---------------------------------------------------------

    def gaps(self) -> List[Tuple[int, int]]:
        if self.total_length is None:
            spans = self.coverage.spans
            if not spans:
                return []
            return self.coverage.gaps(spans[0].start, spans[-1].end)
        return self.coverage.gaps(0, self.total_length)

    def retransmit_plan(self, mtu: int) -> List[Tuple[int, int]]:
        """(offset, length) requests covering all gaps, each <= mtu."""
        if mtu <= 0:
            raise ValueError("mtu must be positive")
        plan: List[Tuple[int, int]] = []
        for start, end in self.gaps():
            pos = start
            while pos < end:
                step = min(mtu, end - pos)
                plan.append((pos, step))
                pos += step
        return plan

    def assembled(self) -> bytes:
        if self.total_length is None:
            raise ValueError("total length unknown")
        return self.storage.read(0, self.total_length)

    def digest(self) -> str:
        return sha256_hex(self.assembled())

    def status(self) -> dict:
        return {
            "transfer_id": self.transfer_id,
            "epoch": self.epoch,
            "total_length": self.total_length,
            "total_hash": self.total_hash,
            "complete": self.complete,
            "finalized": self.finalized,
            "covered": [
                {"start": s.start, "end": s.end, "evidence": list(s.evidence)}
                for s in self.coverage
            ],
            "gaps": [{"start": a, "end": b} for a, b in self.gaps()],
            "storage": type(self.storage).__name__,
            "fragments": sorted(self.fragments),
        }

    # -- checkpointing ---------------------------------------------------

    def to_checkpoint(self) -> dict:
        import base64

        return {
            "transfer_id": self.transfer_id,
            "epoch": self.epoch,
            "total_length": self.total_length,
            "total_hash": self.total_hash,
            "last_activity": self.last_activity,
            "fragments": [
                {
                    "frag_id": f.frag_id,
                    "offset": f.offset,
                    "data_b64": base64.b64encode(f.data).decode("ascii"),
                    "total_length": f.total_length,
                    "total_hash": f.total_hash,
                }
                for f in self.fragments.values()
            ],
        }

    @classmethod
    def from_checkpoint(
        cls, doc: dict, workdir: str, memory_threshold: int
    ) -> "TransferState":
        import base64

        state = cls(doc["transfer_id"], doc["epoch"], workdir, memory_threshold)
        state.last_activity = doc.get("last_activity", 0.0)
        for fdoc in doc["fragments"]:
            frag = Fragment(
                transfer_id=doc["transfer_id"],
                epoch=doc["epoch"],
                frag_id=fdoc["frag_id"],
                offset=fdoc["offset"],
                data=base64.b64decode(fdoc["data_b64"]),
                total_length=fdoc.get("total_length"),
                total_hash=fdoc.get("total_hash"),
            )
            result = state.submit(frag, state.last_activity)
            if result.status not in (SubmitStatus.ACCEPTED, SubmitStatus.DUPLICATE):
                raise ValueError(
                    f"corrupt checkpoint for {doc['transfer_id']}: {result.reason}"
                )
        state.dirty = False
        return state
