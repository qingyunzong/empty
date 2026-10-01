"""Multi-source engine: routes frames to per-(stream_id, epoch) receivers,
journals commit points, and rebuilds consistent state after a crash.

Commit points written to the journal:
  recv      - every frame as received (informational; unacked state is volatile)
  assembled - ack commit: the message is now in the persistent ack set
  delivered - business-delivery commit: advances the output cursor
  conflict  - atomic rejection evidence, retained across recovery

Recovery invariant: delivered seqs are a subset of the ack set and the
output cursor equals the number of delivered records; anything else is
journal corruption and raises CorruptionError.
"""
from __future__ import annotations

from .journal import CorruptionError, Journal
from .messages import CLOSE, Frame
from .stream import StreamReceiver


class Engine:
    def __init__(self, modulus: int = 1 << 16, window: int = 1 << 8,
                 journal_path: str | None = None, sync: bool = True):
        self.modulus = modulus
        self.window = window
        self.journal = Journal(journal_path, sync=sync) if journal_path else None
        self.streams: dict[tuple[str, int], StreamReceiver] = {}

    # --------------------------------------------------------------- internal
    def _log(self, record: dict) -> None:
        if self.journal is not None:
            self.journal.append(record)

    def _stream(self, stream_id: str, epoch: int) -> StreamReceiver:
        key = (stream_id, epoch)
        receiver = self.streams.get(key)
        if receiver is None:
            receiver = StreamReceiver(stream_id, epoch, self.modulus, self.window)
            self.streams[key] = receiver
            self._log({"t": "open", "stream_id": stream_id, "epoch": epoch,
                       "base": receiver.next_expected})
        return receiver

    # ----------------------------------------------------------------- receive
    def receive(self, frame) -> dict:
        if isinstance(frame, dict):
            frame = Frame.from_dict(frame)
        self._log({"t": "recv", "frame": frame.to_dict()})
        receiver = self._stream(frame.stream_id, frame.epoch)
        result = receiver.receive(frame)
        for tag, record in result.events:
            self._log({"t": tag, **record})
        return {
            "status": result.status.value,
            "stream_id": frame.stream_id,
            "epoch": frame.epoch,
            "seq": frame.seq,
            "ack_ranges": receiver.ack_ranges(),
            "gaps": receiver.gap_requests(),
            "window_full": receiver.window_full(),
            "evidence": result.evidence,
        }

    # ----------------------------------------------------------------- deliver
    def poll(self, max_n: int | None = None) -> list[dict]:
        """Drain ready messages across all streams in deterministic order."""
        out: list[dict] = []
        budget = max_n
        for key in sorted(self.streams):
            if budget is not None and budget <= 0:
                break
            deliveries, events = self.streams[key].poll(budget)
            for tag, record in events:
                self._log({"t": tag, **record})
            out.extend(deliveries)
            if budget is not None:
                budget -= len(deliveries)
        return out

    # ------------------------------------------------------------- crash/recover
    def crash(self) -> None:
        """Simulate process death: all volatile state is lost, journal survives."""
        self.streams = {}

    def recover(self) -> None:
        """Rebuild stream state from the journal and verify consistency."""
        if self.journal is None:
            return
        self.streams = {}
        for record in self.journal.replay():
            tag = record["t"]
            if tag == "open":
                receiver = StreamReceiver(record["stream_id"], record["epoch"],
                                          self.modulus, self.window,
                                          base=record["base"])
                self.streams[(record["stream_id"], record["epoch"])] = receiver
            elif tag == "assembled":
                receiver = self.streams[(record["stream_id"], record["epoch"])]
                receiver.acked.add(record["seq"])
                receiver.ready[record["seq"]] = (record["kind"], record["content"])
                if record["kind"] == CLOSE:
                    receiver.close_seq = record["seq"]
            elif tag == "delivered":
                receiver = self.streams[(record["stream_id"], record["epoch"])]
                if record["seq"] != receiver.next_expected:
                    raise CorruptionError(
                        f"delivered seq {record['seq']} != cursor "
                        f"{receiver.next_expected}")
                if record["seq"] not in receiver.acked:
                    raise CorruptionError(
                        f"delivered seq {record['seq']} not in ack set")
                receiver.ready.pop(record["seq"], None)
                receiver.delivered_seqs.append(record["seq"])
                receiver.next_expected = (receiver.next_expected + 1) % self.modulus
                if record["kind"] == CLOSE:
                    receiver.done = True
            elif tag == "conflict":
                receiver = self.streams[(record["stream_id"], record["epoch"])]
                receiver.conflicts.append({k: v for k, v in record.items()
                                           if k != "t"})
            # "recv" records are informational: frames that never reached an
            # assembled commit are simply not in the ack set and the peer's
            # retransmission will drive them again.
        for receiver in self.streams.values():
            if not set(receiver.delivered_seqs) <= receiver.acked:
                raise CorruptionError("output cursor ahead of ack set")
        for receiver in self.streams.values():
            receiver._prune_acked()

    # ------------------------------------------------------------------ status
    def status(self) -> dict:
        return {
            f"{sid}:{epoch}": {
                "next_expected": st.next_expected,
                "acked": sorted(st.acked),
                "ready": sorted(st.ready),
                "delivered": list(st.delivered_seqs),
                "ack_ranges": st.ack_ranges(),
                "gaps": st.gap_requests(),
                "window_full": st.window_full(),
                "close_seq": st.close_seq,
                "done": st.done,
                "conflicts": len(st.conflicts),
            }
            for (sid, epoch), st in sorted(self.streams.items())
        }

    def conflicts(self) -> list[dict]:
        return [ev for st in self.streams.values() for ev in st.conflicts]

    def close(self) -> None:
        if self.journal is not None:
            self.journal.close()
