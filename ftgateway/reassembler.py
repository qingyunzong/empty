"""Per-(transfer_id, epoch) reassembler.

Guarantees:
  * identical-content overlap is accepted and merges coverage;
  * conflicting-content overlap rejects the whole incoming fragment and
    raises ConflictError carrying the minimal conflicting interval and
    the fragment ids of both parties;
  * total_length / total_hash may each transition unknown -> known once;
  * bad fragments (bad hash, out of range, stale epoch) never pollute
    already verified state;
  * once buffered bytes exceed the memory threshold, data spills to a
    sparse temporary file;
  * commit verifies the whole-file hash before any publish happens.
"""
from __future__ import annotations

import hashlib
import os
import threading

from .fragments import Fragment
from .intervals import Coverage


class ConflictError(Exception):
    """Overlapping bytes disagree.  Carries minimal conflict interval."""

    def __init__(self, transfer_id, epoch, start, end, existing_id, new_id):
        super().__init__(
            f"conflict on {transfer_id}@{epoch}: bytes [{start},{end}) "
            f"disagree between fragment {existing_id!r} and {new_id!r}"
        )
        self.transfer_id = transfer_id
        self.epoch = epoch
        self.start = start
        self.end = end
        self.existing_fragment_id = existing_id
        self.new_fragment_id = new_id


class LengthChangeError(Exception):
    """total_length is already fixed for this epoch; a new epoch is required."""

    def __init__(self, transfer_id, epoch, fixed, attempted):
        super().__init__(
            f"total_length for {transfer_id}@{epoch} fixed at {fixed}, "
            f"got {attempted}; start a new epoch to change length"
        )
        self.fixed = fixed
        self.attempted = attempted


class BadFragmentError(Exception):
    """Fragment is corrupt/out-of-range/stale; rejected without side effects."""


class Reassembler:
    def __init__(
        self,
        transfer_id: str,
        epoch: int,
        *,
        memory_threshold: int = 1 << 20,
        spool_dir: str | None = None,
    ) -> None:
        self.transfer_id = transfer_id
        self.epoch = epoch
        self.memory_threshold = memory_threshold
        self.spool_dir = spool_dir
        self.total_length: int | None = None
        self.total_hash: str | None = None
        self.coverage = Coverage()
        # fragment_id -> (offset, end, content_hash)  : provenance evidence
        self.fragments: dict[str, tuple[int, int, str]] = {}
        self._buf = bytearray()          # in-memory mode
        self._file = None                # sparse temp file mode
        self._file_path: str | None = None
        self._received_bytes = 0         # drives the spill threshold
        self._lock = threading.Lock()    # also the commit/reclaim mutex
        self.committing = False
        self.committed = False
        self.failed = False
        self.last_activity = 0.0

    # ------------------------------------------------------------------ io
    def _spill_path(self) -> str:
        assert self.spool_dir is not None
        safe = self.transfer_id.replace("/", "_")
        return os.path.join(self.spool_dir, f"{safe}.{self.epoch}.part")

    def _ensure_spilled(self) -> None:
        if self._file is not None:
            return
        os.makedirs(self.spool_dir, exist_ok=True)
        self._file_path = self._spill_path()
        fd = os.open(self._file_path, os.O_RDWR | os.O_CREAT, 0o600)
        self._file = os.fdopen(fd, "r+b")
        if self._buf:
            self._file.seek(0)
            self._file.write(bytes(self._buf))
            self._buf = bytearray()
        self._file.flush()

    @property
    def spilled(self) -> bool:
        return self._file is not None

    @property
    def temp_path(self) -> str | None:
        return self._file_path

    def _write(self, offset: int, data: bytes) -> None:
        if self._file is not None:
            self._file.seek(offset)
            self._file.write(data)
            self._file.flush()
        else:
            need = offset + len(data)
            if need > len(self._buf):
                self._buf.extend(b"\x00" * (need - len(self._buf)))
            self._buf[offset:offset + len(data)] = data

    def _read(self, offset: int, length: int) -> bytes:
        if length <= 0:
            return b""
        if self._file is not None:
            self._file.seek(offset)
            return self._file.read(length)
        if offset >= len(self._buf):
            return b""
        return bytes(self._buf[offset:offset + length])

    # ------------------------------------------------------------- mutate
    def add(self, frag: Fragment, now: float = 0.0) -> str:
        """Add a fragment.  Returns 'duplicate' | 'stored' | 'complete'."""
        with self._lock:
            self.last_activity = now
            if self.failed:
                raise BadFragmentError("transfer already failed")
            if frag.transfer_id != self.transfer_id or frag.epoch != self.epoch:
                raise BadFragmentError("wrong transfer/epoch")
            if not frag.hash_ok():
                raise BadFragmentError("content hash mismatch")
            if frag.fragment_id in self.fragments:
                off, end, h = self.fragments[frag.fragment_id]
                if off == frag.offset and end == frag.end and h == frag.actual_hash():
                    return "duplicate"
                raise BadFragmentError("fragment id reused with different body")
            self._fix_total_length(frag)
            self._fix_total_hash(frag)
            if self.total_length is not None and frag.end > self.total_length:
                raise BadFragmentError("fragment extends past total_length")
            if self.total_length == 0 and len(frag.data) != 0:
                raise BadFragmentError("data on zero-length transfer")
            self._check_overlap(frag)
            # verified: now it is safe to mutate state
            self._received_bytes += len(frag.data)
            if (
                not self.spilled
                and self.spool_dir is not None
                and self._received_bytes > self.memory_threshold
            ):
                self._ensure_spilled()
            self._write(frag.offset, frag.data)
            self.coverage.add(frag.offset, frag.end, frag.fragment_id)
            self.fragments[frag.fragment_id] = (
                frag.offset, frag.end, frag.actual_hash())
            if self.is_complete():
                return "complete"
            return "stored"

    def _fix_total_length(self, frag: Fragment) -> None:
        if frag.total_length is None:
            return
        if self.total_length is None:
            self.total_length = frag.total_length
        elif frag.total_length != self.total_length:
            raise LengthChangeError(
                self.transfer_id, self.epoch,
                self.total_length, frag.total_length)

    def _fix_total_hash(self, frag: Fragment) -> None:
        if frag.total_hash is None:
            return
        if self.total_hash is None:
            self.total_hash = frag.total_hash
        elif frag.total_hash != self.total_hash:
            raise BadFragmentError("total_hash changed within epoch")

    def _check_overlap(self, frag: Fragment) -> None:
        """Identical overlap is fine; any differing byte rejects everything."""
        for iv in self.coverage.overlapping(frag.offset, frag.end):
            lo = max(iv.start, frag.offset)
            hi = min(iv.end, frag.end)
            existing = self._read(lo, hi - lo)
            incoming = frag.data[lo - frag.offset: hi - frag.offset]
            if existing == incoming:
                continue
            first = next(i for i in range(len(existing))
                         if existing[i] != incoming[i])
            last = next(i for i in range(len(existing) - 1, -1, -1)
                        if existing[i] != incoming[i])
            pos = lo + first
            raise ConflictError(
                self.transfer_id, self.epoch,
                lo + first, lo + last + 1,
                self._evidence_at(pos), frag.fragment_id)

    def _evidence_at(self, pos: int) -> str:
        """Fragment id previously covering byte pos (provenance evidence)."""
        for fid, (off, end, _h) in self.fragments.items():
            if off <= pos < end:
                return fid
        return "<unknown>"

    def withdraw(self, fragment_id: str, now: float = 0.0) -> bool:
        """Retract a fragment; coverage is rebuilt from what remains."""
        with self._lock:
            self.last_activity = now
            if fragment_id not in self.fragments:
                return False
            del self.fragments[fragment_id]
            self.coverage.rebuild(
                [(off, end, fid) for fid, (off, end, _h)
                 in self.fragments.items()])
            return True

    # -------------------------------------------------------------- query
    def is_complete(self) -> bool:
        if self.total_length == 0:
            return True
        return (
            self.total_length is not None
            and self.coverage.is_complete(self.total_length)
        )

    def gaps(self) -> list[tuple[int, int]]:
        if self.total_length is None:
            return []
        return self.coverage.gaps(self.total_length)

    def retransmit_plan(self, mtu: int) -> list[tuple[int, int]]:
        """Gap fill requests chunked to the (possibly renegotiated) MTU."""
        if mtu <= 0:
            raise ValueError("mtu must be positive")
        to_send: list[tuple[int, int]] = []
        for start, end in self.gaps():
            pos = start
            while pos < end:
                step = min(mtu, end - pos)
                to_send.append((pos, step))
                pos += step
        return to_send

    def assemble(self) -> bytes:
        if not self.is_complete():
            raise BadFragmentError("transfer incomplete: holes remain")
        return self._read(0, self.total_length or 0)

    def file_digest(self) -> str:
        h = hashlib.sha256()
        pos = 0
        total = self.total_length or 0
        while pos < total:
            chunk = self._read(pos, min(1 << 16, total - pos))
            if not chunk:
                break
            h.update(chunk)
            pos += len(chunk)
        return h.hexdigest()

    # -------------------------------------------------------------- commit
    def begin_commit(self) -> bool:
        """Try to enter the commit critical section (excludes reclaimers)."""
        acquired = self._lock.acquire(blocking=False)
        if not acquired:
            return False
        if self.committed or self.failed:
            self._lock.release()
            return False
        self.committing = True
        self._lock.release()
        return True

    def end_commit(self) -> None:
        self.committing = False

    def verify(self) -> bool:
        """Whole-file hash check; also detects temp-file tampering."""
        if not self.is_complete():
            return False
        if self.total_hash is None:
            return False
        return self.file_digest() == self.total_hash

    def verify_fragment_evidence(self) -> bool:
        """Re-hash every stored fragment region (used after recovery)."""
        for off, end, h in self.fragments.values():
            if end > off and hashlib.sha256(
                    self._read(off, end - off)).hexdigest() != h:
                return False
        return True

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    def discard(self) -> None:
        self.close()
        if self._file_path and os.path.exists(self._file_path):
            os.unlink(self._file_path)

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
