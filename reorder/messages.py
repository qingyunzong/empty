"""Wire messages: frames carrying fragments of content-addressed messages."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

DATA = "data"
CLOSE = "close"


def hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Frame:
    """One fragment of one message on one (stream_id, epoch) channel."""

    stream_id: str
    epoch: int
    seq: int            # cyclic message sequence number
    frag_index: int     # fragment position inside the message
    frag_count: int     # total fragments of the message
    content_hash: str   # hash of the *whole* message content
    payload: str        # this fragment's bytes (text)
    kind: str = DATA    # DATA or CLOSE

    def to_dict(self) -> dict:
        return {
            "stream_id": self.stream_id,
            "epoch": self.epoch,
            "seq": self.seq,
            "frag_index": self.frag_index,
            "frag_count": self.frag_count,
            "content_hash": self.content_hash,
            "payload": self.payload,
            "kind": self.kind,
        }

    @staticmethod
    def from_dict(d: dict) -> "Frame":
        return Frame(
            stream_id=d["stream_id"],
            epoch=int(d["epoch"]),
            seq=int(d["seq"]),
            frag_index=int(d["frag_index"]),
            frag_count=int(d["frag_count"]),
            content_hash=d["content_hash"],
            payload=d["payload"],
            kind=d.get("kind", DATA),
        )


def make_message_frames(stream_id: str, epoch: int, seq: int, content: str,
                        frag_count: int = 1) -> list[Frame]:
    """Split ``content`` into ``frag_count`` frames sharing one content hash."""
    if frag_count < 1:
        raise ValueError("frag_count must be >= 1")
    digest = hash_content(content)
    chunk, rest = divmod(len(content), frag_count)
    frames, pos = [], 0
    for i in range(frag_count):
        end = pos + chunk + (1 if i < rest else 0)
        frames.append(Frame(stream_id, epoch, seq, i, frag_count,
                            digest, content[pos:end], DATA))
        pos = end
    return frames


def make_close_frame(stream_id: str, epoch: int, seq: int) -> Frame:
    """A close marker occupies one sequence number, like a data message."""
    return Frame(stream_id, epoch, seq, 0, 1, hash_content(""), "", CLOSE)
