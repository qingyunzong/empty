"""Independent unbounded reference buffer model.

Used only to cross-check the real engine.  It has no receive window, no
capacity limit and no backpressure: every frame is mapped to an absolute
message index (nearest cycle to the delivery cursor) and buffered
forever; delivery is the contiguous prefix from index 0 and stops at a
close message.  Conflicting content never overwrites what was first
accepted.  This is a deliberately separate, simpler implementation of
the same externally visible contract.

Validity condition (shared with any cyclic-sequence protocol): a frame
must not be delayed by a full cycle or more, otherwise its sequence
number aliases and no receiver could classify it.
"""

from __future__ import annotations

from .frames import Frame


class _StreamModel:
    def __init__(self, mod):
        self.mod = mod
        self.next_abs = 0            # absolute index of next expected message
        self.msgs = {}               # abs index -> assembly
        self.delivered_hashes = {}   # abs index -> hash
        self.out = []                # delivered records
        self.closed = False
        self.conflict = False

    def offer(self, frame):
        if self.closed:
            return
        next_seq = self.next_abs % self.mod
        d = (frame.seq - next_seq) % self.mod
        if d <= self.mod // 2:
            abs_idx = self.next_abs + d
        else:
            abs_idx = self.next_abs + d - self.mod
        if abs_idx < self.next_abs:
            kept = self.delivered_hashes.get(abs_idx)
            if kept is not None and kept != frame.hash:
                self.conflict = True
            return
        msg = self.msgs.get(abs_idx)
        if msg is None:
            if frame.frags < 1 or not (0 <= frame.frag < frame.frags):
                return
            msg = {"hash": frame.hash, "frags": frame.frags,
                   "close": frame.close, "parts": {}}
            self.msgs[abs_idx] = msg
        if (
            frame.hash != msg["hash"]
            or frame.frags != msg["frags"]
            or frame.close != msg["close"]
            or not (0 <= frame.frag < msg["frags"])
            or (frame.frag in msg["parts"]
                and msg["parts"][frame.frag] != frame.payload)
        ):
            self.conflict = True
            return
        msg["parts"][frame.frag] = frame.payload
        self._drain()

    def _drain(self):
        while True:
            msg = self.msgs.get(self.next_abs)
            if msg is None or len(msg["parts"]) < msg["frags"]:
                return
            del self.msgs[self.next_abs]
            content = "".join(msg["parts"][i] for i in range(msg["frags"]))
            self.out.append({
                "seq": self.next_abs % self.mod,
                "content": content,
                "hash": msg["hash"],
                "close": msg["close"],
            })
            self.delivered_hashes[self.next_abs] = msg["hash"]
            self.next_abs += 1
            if msg["close"]:
                self.closed = True
                return


class ReferenceModel:
    def __init__(self, mod):
        self.mod = mod
        self.streams = {}

    def offer(self, frame):
        if isinstance(frame, dict):
            frame = Frame.from_dict(frame)
        key = (frame.stream, frame.epoch)
        model = self.streams.get(key)
        if model is None:
            model = _StreamModel(self.mod)
            self.streams[key] = model
        model.offer(frame)

    def delivered(self):
        return {key: list(model.out) for key, model in self.streams.items()}
