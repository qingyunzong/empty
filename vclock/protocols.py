"""Protocol sessions built on top of the discrete-event core.

Two independent session types:
  - HeartbeatSession: sends PING every `interval` ticks (default 30);
    if no PONG arrives within `timeout` ticks (default 60) of a PING,
    the session transitions ALIVE -> DEAD.
  - StopAndWaitARQ: stop-and-wait ARQ. Sends one packet, waits for ACK,
    retransmits on timeout up to `max_retries`, then transitions to FAILED.
    Completes (DONE) when all packets are ACKed.

Sessions share only the clock; all state is per-session, so one session
going DEAD/FAILED never affects another.
"""

from __future__ import annotations

from typing import Callable, Dict, Optional

from .core import Handle, VirtualClock

TraceFn = Callable[..., None]

PRIO_PROTOCOL = 0  # default priority for protocol-internal events


class HeartbeatSession:
    """PING every `interval` ticks; DEAD after `timeout` ticks without PONG."""

    ALIVE = "ALIVE"
    DEAD = "DEAD"

    def __init__(
        self,
        clock: VirtualClock,
        session_id: str,
        trace: TraceFn,
        interval: int = 30,
        timeout: int = 60,
        pong_delay: Optional[int] = None,
    ) -> None:
        if interval <= 0 or timeout <= 0:
            raise ValueError("interval and timeout must be positive")
        self.clock = clock
        self.session_id = session_id
        self.trace = trace
        self.interval = interval
        self.timeout = timeout
        # pong_delay: None simulates a dead peer (PONG never arrives).
        self.pong_delay = pong_delay
        self.state = self.ALIVE
        self.dead_tick: Optional[int] = None
        self._epoch = 0
        self._deadlines: Dict[int, Handle] = {}

    def start(self) -> None:
        self._send_ping()

    def _send_ping(self) -> None:
        if self.state != self.ALIVE:
            return
        epoch = self._epoch
        self._epoch += 1
        self.trace(kind="ping", session=self.session_id, tick=self.clock.now,
                   epoch=epoch)
        self._deadlines[epoch] = self.clock.schedule(
            self.clock.now + self.timeout, PRIO_PROTOCOL,
            lambda e=epoch: self._check_deadline(e),
        )
        if self.pong_delay is not None:
            self.clock.schedule(
                self.clock.now + self.pong_delay, PRIO_PROTOCOL,
                lambda e=epoch: self._recv_pong(e),
            )
        self.clock.schedule(self.clock.now + self.interval, PRIO_PROTOCOL,
                            self._send_ping)

    def _recv_pong(self, epoch: int) -> None:
        if self.state != self.ALIVE:
            return
        self.trace(kind="pong", session=self.session_id, tick=self.clock.now,
                   epoch=epoch)
        handle = self._deadlines.pop(epoch, None)
        if handle is not None:
            self.clock.cancel(handle)

    def _check_deadline(self, epoch: int) -> None:
        if self.state != self.ALIVE:
            return
        self._deadlines.pop(epoch, None)
        self.state = self.DEAD
        self.dead_tick = self.clock.now
        self.trace(kind="state", session=self.session_id, tick=self.clock.now,
                   state=self.DEAD, epoch=epoch)


class StopAndWaitARQ:
    """Stop-and-wait ARQ: one outstanding packet, retransmit on timeout."""

    ACTIVE = "ACTIVE"
    DONE = "DONE"
    FAILED = "FAILED"

    def __init__(
        self,
        clock: VirtualClock,
        session_id: str,
        trace: TraceFn,
        num_packets: int = 1,
        timeout: int = 10,
        max_retries: int = 3,
        ack_delay: Optional[int] = 2,
        ack_loss: int = 0,
    ) -> None:
        if num_packets <= 0 or timeout <= 0 or max_retries < 0:
            raise ValueError("bad ARQ parameters")
        self.clock = clock
        self.session_id = session_id
        self.trace = trace
        self.num_packets = num_packets
        self.timeout = timeout
        self.max_retries = max_retries
        # ack_delay: None simulates a peer that never ACKs.
        self.ack_delay = ack_delay
        # ack_loss: number of initial transmissions whose ACK is lost.
        self.ack_loss = ack_loss
        self.state = self.ACTIVE
        self.done_tick: Optional[int] = None
        self.failed_tick: Optional[int] = None
        self._next = 0          # next packet index to send
        self._attempt = 0       # retransmission count for current packet
        self._transmissions = 0  # total transmissions (drives ack_loss)
        self._timer: Optional[Handle] = None

    def start(self) -> None:
        self._transmit()

    def _transmit(self) -> None:
        if self.state != self.ACTIVE:
            return
        pkt = self._next
        self._transmissions += 1
        self.trace(kind="send", session=self.session_id, tick=self.clock.now,
                   packet=pkt, attempt=self._attempt)
        if self.ack_delay is not None and self._transmissions > self.ack_loss:
            self.clock.schedule(
                self.clock.now + self.ack_delay, PRIO_PROTOCOL,
                lambda p=pkt: self._recv_ack(p),
            )
        self._timer = self.clock.schedule(
            self.clock.now + self.timeout, PRIO_PROTOCOL,
            lambda p=pkt: self._on_timeout(p),
        )

    def _recv_ack(self, pkt: int) -> None:
        if self.state != self.ACTIVE or pkt != self._next:
            return  # stale/duplicate ACK
        if self._timer is not None:
            self.clock.cancel(self._timer)
            self._timer = None
        self.trace(kind="ack", session=self.session_id, tick=self.clock.now,
                   packet=pkt)
        self._next += 1
        self._attempt = 0
        if self._next >= self.num_packets:
            self.state = self.DONE
            self.done_tick = self.clock.now
            self.trace(kind="state", session=self.session_id,
                       tick=self.clock.now, state=self.DONE)
        else:
            self._transmit()

    def _on_timeout(self, pkt: int) -> None:
        if self.state != self.ACTIVE or pkt != self._next:
            return
        self._timer = None
        self._attempt += 1
        if self._attempt > self.max_retries:
            self.state = self.FAILED
            self.failed_tick = self.clock.now
            self.trace(kind="state", session=self.session_id,
                       tick=self.clock.now, state=self.FAILED, packet=pkt)
            return
        self.trace(kind="timeout", session=self.session_id,
                   tick=self.clock.now, packet=pkt, attempt=self._attempt)
        self._transmit()
