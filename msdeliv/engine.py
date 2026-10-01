"""Ordered delivery DeliveryEngine.

Streams are keyed by (stream_id, epoch).  The engine logs receive,
assemble and business-delivery commit points to a durable JSONL log and
can be rebuilt from it after a crash.
"""

from __future__ import annotations

from .frames import Frame
from .log import DurableLog
from .receiver import ACCEPTED, CONFLICT, ReassemblyBuffer
from .seqnum import check_window_params

STALE = "stale_epoch"


class DeliveryEngine:
    def __init__(self, mod=1 << 16, window=8, capacity=None, log=None,
                 write_config=True):
        check_window_params(mod, window)
        self.mod = mod
        self.window = window
        self.capacity = capacity if capacity is not None else window
        self.log = log if log is not None else DurableLog(None)
        self.buffers = {}        # (stream, epoch) -> ReassemblyBuffer
        self.active_epoch = {}   # stream -> highest epoch seen
        self.cursor = 0          # global output cursor (commit point)
        self.outputs = []        # committed delivery records
        self._logging = True
        if write_config:
            self.log.record("config", mod=mod, window=window,
                            capacity=self.capacity)

    def offer(self, frame):
        """Offer one frame (Frame or dict).  Returns a status dict."""
        if isinstance(frame, dict):
            frame = Frame.from_dict(frame)
        active = self.active_epoch.get(frame.stream)
        if active is not None and frame.epoch < active:
            # Late frame from a superseded epoch: distinguishable from a
            # future frame, rejected without touching current state.
            evt = {"status": STALE, "stream": frame.stream,
                   "epoch": frame.epoch, "active_epoch": active,
                   "seq": frame.seq}
            if self._logging:
                self.log.record("stale", frame=frame.to_dict(),
                                active_epoch=active)
            return evt
        if active is None or frame.epoch > active:
            self.active_epoch[frame.stream] = frame.epoch
        key = (frame.stream, frame.epoch)
        buf = self.buffers.get(key)
        if buf is None:
            buf = ReassemblyBuffer(frame.stream, frame.epoch,
                                   self.mod, self.window, self.capacity)
            self.buffers[key] = buf
        res = buf.accept(frame)
        if self._logging and res.status == ACCEPTED:
            self.log.record("recv", frame=frame.to_dict())
            if res.detail.get("assembled"):
                self.log.record("assembled", stream=frame.stream,
                                epoch=frame.epoch, seq=frame.seq,
                                hash=frame.hash)
        if self._logging and res.status == CONFLICT:
            self.log.record("conflict", frame=frame.to_dict(),
                            evidence=res.detail)
        return res.to_dict()

    def poll(self):
        """Commit all deliverable messages; returns delivery records."""
        committed = []
        for key in sorted(self.buffers):
            buf = self.buffers[key]
            for seq, content, hash_, close in buf.poll_ready():
                rec = {
                    "cursor": self.cursor,
                    "stream": buf.stream,
                    "epoch": buf.epoch,
                    "seq": seq,
                    "content": content,
                    "hash": hash_,
                    "close": close,
                }
                self.cursor += 1
                self.outputs.append(rec)
                committed.append(rec)
                if self._logging:
                    self.log.record("delivered", **rec)
        return committed

    def acks(self, stream, epoch):
        buf = self.buffers.get((stream, epoch))
        return buf.acks() if buf is not None else None

    def evidence(self):
        ev = []
        for key in sorted(self.buffers):
            ev.extend(self.buffers[key].evidence)
        return ev

    def state(self):
        return {
            "cursor": self.cursor,
            "mod": self.mod,
            "window": self.window,
            "capacity": self.capacity,
            "streams": [self.buffers[k].acks() for k in sorted(self.buffers)],
        }

    @classmethod
    def recover(cls, log_path):
        """Rebuild an engine from its durable log.

        Replays recv / conflict / delivered events deterministically; the
        recovered ack set and output cursor equal the logged ones.
        Messages acknowledged but not yet delivered at the crash are
        reassembled in memory and become deliverable on the next poll().
        """
        events = DurableLog.replay(log_path)
        config = next((e for e in events if e["kind"] == "config"), None)
        if config is None:
            raise ValueError("log has no config header")
        engine = cls(mod=config["mod"], window=config["window"],
                     capacity=config.get("capacity"),
                     log=DurableLog(log_path), write_config=False)
        engine._logging = False
        for ev in events:
            kind = ev["kind"]
            if kind == "config":
                continue
            if kind in ("recv", "conflict"):
                engine.offer(Frame.from_dict(ev["frame"]))
            elif kind == "delivered":
                engine._apply_delivered(ev)
            elif kind in ("assembled", "stale"):
                continue  # informational / no state change
            else:
                raise ValueError(f"unknown log event: {kind}")
        engine._logging = True
        return engine

    def _apply_delivered(self, ev):
        key = (ev["stream"], ev["epoch"])
        buf = self.buffers.get(key)
        if buf is None:
            raise ValueError("delivered event for unknown stream")
        if buf.next_seq != ev["seq"]:
            raise ValueError(
                f"recovery mismatch: next_seq={buf.next_seq} != {ev['seq']}"
            )
        asm = buf.slots.pop(ev["seq"], None)
        if asm is None or not asm.complete or asm.hash != ev["hash"]:
            raise ValueError("recovery mismatch: incomplete or hash mismatch")
        if ev["cursor"] != self.cursor:
            raise ValueError("recovery mismatch: output cursor diverged")
        buf._remember_delivered(ev["seq"], ev["hash"])
        buf.next_seq = (ev["seq"] + 1) % buf.mod
        buf.delivered_count += 1
        if asm.close:
            buf.closed = True
        rec = {
            "cursor": self.cursor,
            "stream": ev["stream"],
            "epoch": ev["epoch"],
            "seq": ev["seq"],
            "content": asm.content(),
            "hash": ev["hash"],
            "close": asm.close,
        }
        self.cursor += 1
        self.outputs.append(rec)
