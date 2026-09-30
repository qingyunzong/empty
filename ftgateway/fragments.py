"""Fragment model and content hashing for the file-transfer gateway."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class Fragment:
    """One incoming shard.

    total_length / total_hash may be None (unknown).  Once a reassembler
    has fixed them for an epoch they can never change; a differing value
    requires a new epoch.
    """

    transfer_id: str
    epoch: int
    fragment_id: str
    offset: int
    data: bytes
    total_length: int | None = None
    total_hash: str | None = None
    content_hash: str | None = None  # optional declared sha256 of data

    def __post_init__(self) -> None:
        if self.offset < 0:
            raise ValueError("negative offset")
        if self.total_length is not None and self.total_length < 0:
            raise ValueError("negative total_length")

    @property
    def end(self) -> int:
        return self.offset + len(self.data)

    def actual_hash(self) -> str:
        return sha256_hex(self.data)

    def hash_ok(self) -> bool:
        return self.content_hash is None or self.content_hash == self.actual_hash()
