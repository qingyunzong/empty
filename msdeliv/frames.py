"""Frame model and helpers.

A frame carries one fragment of one message.  Every fragment of a
message repeats the message-level content hash so that a conflicting
retransmit (same sequence number, different content) is detectable
from any single fragment.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Frame:
    stream: str
    epoch: int
    seq: int
    frag: int
    frags: int
    payload: str
    hash: str
    close: bool = False

    def to_dict(self):
        return {
            "stream": self.stream,
            "epoch": self.epoch,
            "seq": self.seq,
            "frag": self.frag,
            "frags": self.frags,
            "payload": self.payload,
            "hash": self.hash,
            "close": self.close,
        }

    @staticmethod
    def from_dict(d):
        return Frame(
            stream=d["stream"],
            epoch=int(d["epoch"]),
            seq=int(d["seq"]),
            frag=int(d["frag"]),
            frags=int(d["frags"]),
            payload=d["payload"],
            hash=d["hash"],
            close=bool(d.get("close", False)),
        )


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def message_frames(stream, epoch, seq, content, frags=1, close=False):
    """Split ``content`` into ``frags`` frames sharing one content hash."""
    if frags < 1:
        raise ValueError("frags must be >= 1")
    h = content_hash(content)
    size = (len(content) + frags - 1) // frags
    parts = [content[i * size:(i + 1) * size] for i in range(frags)] or [""]
    return [
        Frame(stream, epoch, seq, i, frags, parts[i], h, close)
        for i in range(frags)
    ]
