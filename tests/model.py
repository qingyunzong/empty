"""Independent per-byte source model used to cross-check the reassembler.

Tracks, for every byte position, the accepted value and the fragment ids
that evidenced it.  Deliberately shares no code with ftgateway.
"""
from __future__ import annotations


class ByteModel:
    def __init__(self) -> None:
        self.bytes: dict[int, int] = {}          # pos -> value
        self.evidence: dict[int, list[str]] = {}  # pos -> fragment ids
        self.total_length: int | None = None

    def add(self, fid: str, offset: int, data: bytes):
        """Returns None on success, else (start, end, existing_fid) conflict."""
        first = last = None
        existing_fid = None
        for i, b in enumerate(data):
            pos = offset + i
            if pos in self.bytes:
                if self.bytes[pos] != b:
                    if first is None:
                        first = pos
                        existing_fid = self.evidence[pos][0]
                    last = pos
            if first is not None and pos > (last or first):
                # still scan: minimal span covers all differing positions
                pass
        if first is not None:
            return (first, last + 1, existing_fid)
        for i, b in enumerate(data):
            pos = offset + i
            self.bytes[pos] = b
            self.evidence.setdefault(pos, [])
            if fid not in self.evidence[pos]:
                self.evidence[pos].append(fid)
        return None

    def withdraw(self, fid: str) -> None:
        for pos in sorted(self.evidence):
            if fid in self.evidence[pos]:
                self.evidence[pos].remove(fid)
                if not self.evidence[pos]:
                    del self.evidence[pos]
                    del self.bytes[pos]

    def gaps(self) -> list[tuple[int, int]]:
        if self.total_length is None:
            return []
        out, cursor = [], 0
        for pos in sorted(self.bytes):
            if pos > cursor:
                out.append((cursor, pos))
            cursor = pos + 1
        if cursor < self.total_length:
            out.append((cursor, self.total_length))
        return out

    def complete(self) -> bool:
        return (self.total_length is not None
                and len(self.bytes) == self.total_length
                and all(p in self.bytes for p in range(self.total_length)))

    def assemble(self) -> bytes:
        return bytes(self.bytes[p] for p in range(self.total_length or 0))
