"""Event-driven simulator wiring sender, receiver, channel and a virtual clock."""

from typing import Any, List, Optional

from .protocol import Ack, Frame, Receiver, Sender


class Simulator:
    def __init__(self, window_size: int = 4, seq_space: int = 8, timeout: int = 10):
        self.sender = Sender(window_size, seq_space, timeout)
        self.receiver = Receiver(window_size, seq_space)
        self.now = 0
        self.channel: List[Frame] = []      # frames in flight, sender -> receiver
        self.ack_channel: List[Ack] = []    # ACKs in flight, receiver -> sender

    # ---- application / clock events -------------------------------------

    def send(self, data: Any) -> Frame:
        frame = self.sender.send(data, self.now)
        self.channel.append(frame)
        return frame

    def advance(self, delta: int) -> List[int]:
        """Advance the virtual clock by `delta`.

        Timers fire in order of expiry; timers expiring at the same tick fire
        in ascending sequence-number order.  Each firing retransmits only its
        own frame and restarts only its own timer (so a long advance may
        retransmit the same frame several times).  Returns the absolute
        sequence numbers in firing order.
        """
        if delta < 0:
            raise ValueError(f"cannot advance clock by negative delta {delta}")
        target = self.now + delta
        fired: List[int] = []
        while True:
            pending = [
                (expiry, seq)
                for seq, expiry in self.sender.timers.items()
                if expiry <= target
            ]
            if not pending:
                break
            expiry, seq = min(pending)  # earliest expiry, tie -> smaller seq
            self.now = expiry
            frame = self.sender.fire_timeout(seq, self.now)
            self.channel.append(frame)
            fired.append(seq)
        self.now = target
        return fired

    # ---- channel events ---------------------------------------------------

    def _take(self, queue: list, seq: int, kind: str):
        for i, item in enumerate(queue):
            if item.seq == seq:
                return queue.pop(i)
        raise KeyError(f"no {kind} with seq={seq} in channel")

    def lose(self, seq: int) -> None:
        """Drop the in-flight frame with the given wire sequence number."""
        self._take(self.channel, seq, "frame")

    def lose_ack(self, seq: int) -> None:
        """Drop the in-flight ACK with the given wire sequence number."""
        self._take(self.ack_channel, seq, "ACK")

    def deliver(self, seq: int) -> Optional[Ack]:
        """Deliver one in-flight frame to the receiver; its ACK (if any) is
        put on the return channel."""
        frame = self._take(self.channel, seq, "frame")
        ack = self.receiver.receive(frame)
        if ack is not None:
            self.ack_channel.append(ack)
        return ack

    def deliver_ack(self, seq: int) -> bool:
        """Deliver one in-flight ACK to the sender."""
        ack = self._take(self.ack_channel, seq, "ACK")
        return self.sender.receive_ack(ack.seq, self.now)

    # ---- results ----------------------------------------------------------

    @property
    def delivered(self) -> list:
        return list(self.receiver.delivered)

    @property
    def retransmissions(self) -> int:
        return self.sender.retransmissions

    def result(self) -> dict:
        return {
            "delivered": self.delivered,
            "retransmissions": self.retransmissions,
        }
