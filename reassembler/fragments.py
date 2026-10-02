"""Fragment model and hashing helpers."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Optional


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class Fragment:
    """One wire fragment of a transfer.

    ``total_length`` may be ``None`` when the sender does not know it yet;
    once established for a transfer it can never change within the epoch.
    ``total_hash`` (sha256 hex of the whole file) may arrive on any
    fragment; a conflicting declaration rejects the incoming fragment.
    """

    transfer_id: str
    epoch: int
    frag_id: str
    offset: int
    data: bytes
    total_length: Optional[int] = None
    total_hash: Optional[str] = None

    def __post_init__(self) -> None:
        if self.offset < 0:
            raise ValueError("negative offset")
        if self.total_length is not None and self.total_length < 0:
            raise ValueError("negative total_length")
        if self.epoch < 0:
            raise ValueError("negative epoch")

    @property
    def end(self) -> int:
        return self.offset + len(self.data)

    @property
    def digest(self) -> str:
        """Content hash of this fragment's payload."""
        return sha256_hex(self.data)

    def covers(self, pos: int) -> bool:
        return self.offset <= pos < self.end
