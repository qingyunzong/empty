"""Protocol sessions built on top of the virtual clock.

Two independent session types:
- StopWaitARQ: stop-and-wait ARQ with retransmission on timeout.
- HeartbeatSession: sends PING every `interval` ticks; if no PONG arrives
  within `dead_after` ticks of a PING, the session turns DEAD.

Sessions only share the clock; their state is fully isolated, so one
session entering FAILED/DEAD never affects another.
"""

from __future__ import annotations

from .core import VirtualClock


class StopWaitARQ:
    """Stop-and-wait ARQ sender.

    States: IDLE -> WAIT_ACK -> DONE (all packets acked) or FAILED
    (max_retries exceeded). `loss` is a set of 1-based global transmission
    attempt numbers whose packets are dropped (no ACK will come back).
    """

    IDLE = "IDLE"
    WAIT_ACK = "WAIT_ACK"
    DONE = "DONE"
    FAILED = "FAILED"

    def __init__(
        self,
        clock: VirtualClock,
        name: str = "arq",
        ack_delay: int = 4,
        timeout: int = 10,
        max_retries: int = 3,
        loss=(),
    ):
        if ack_delay >= timeout:
            raise ValueError("ack_delay must be smaller than timeout")
        self.clock = clock
        self.name = name
        self.ack_delay = ack_delay
        self.timeout = timeout
        self.max_retries = max_retries
        self.loss = set(loss)
        self.state = self.IDLE
        self.attempt = 0
        self._queue: list = []
        self._current = None
        self._retries = 0

    def send(self, data) -> None:
        self._queue.append(data)
        if self.state == self.IDLE:
            self._transmit()

    def _transmit(self) -> None:
        self._current = self._queue[0]
        self.attempt += 1
        attempt = self.attempt
        self.state = self.WAIT_ACK
        self.clock.log(
            {"kind": "SEND", "session": self.name, "data": self._current,
             "attempt": attempt}
        )
        if attempt not in self.loss:
            self.clock.schedule(
                self.clock.now + self.ack_delay,
                0,
                lambda: self._on_ack(attempt),
                name=f"{self.name}:ack#{attempt}",
            )
        self.clock.schedule(
            self.clock.now + self.timeout,
            1,
            lambda: self._on_timeout(attempt),
            name=f"{self.name}:timeout#{attempt}",
        )

    def _on_ack(self, attempt: int) -> None:
        if self.state != self.WAIT_ACK or attempt != self.attempt:
            return
        self.clock.log(
            {"kind": "ACK", "session": self.name, "data": self._current,
             "attempt": attempt}
        )
        self._queue.pop(0)
        self._retries = 0
        if self._queue:
            self._transmit()
        else:
            self.state = self.DONE
            self.clock.log({"kind": "DONE", "session": self.name})

    def _on_timeout(self, attempt: int) -> None:
        if self.state != self.WAIT_ACK or attempt != self.attempt:
            return
        self._retries += 1
        if self._retries > self.max_retries:
            self.state = self.FAILED
            self.clock.log(
                {"kind": "FAILED", "session": self.name, "data": self._current}
            )
            return
        self.clock.log(
            {"kind": "RETRANSMIT", "session": self.name, "data": self._current,
             "attempt": attempt}
        )
        self._transmit()


class HeartbeatSession:
    """Heartbeat keep-alive session.

    Sends PING every `interval` ticks. If no PONG has been received within
    `dead_after` ticks of a PING, the session turns DEAD and stops pinging.
    """

    ALIVE = "ALIVE"
    DEAD = "DEAD"

    def __init__(
        self,
        clock: VirtualClock,
        name: str = "hb",
        interval: int = 30,
        dead_after: int = 60,
        peer_responds: bool = True,
        pong_delay: int = 5,
    ):
        self.clock = clock
        self.name = name
        self.interval = interval
        self.dead_after = dead_after
        self.peer_responds = peer_responds
        self.pong_delay = pong_delay
        self.state = self.ALIVE
        self.last_pong_tick: int | None = None
        self.pings_sent = 0

    def start(self) -> None:
        self.clock.schedule(
            self.clock.now, 0, self._send_ping, name=f"{self.name}:ping"
        )

    def _send_ping(self) -> None:
        if self.state != self.ALIVE:
            return
        self.pings_sent += 1
        ping_tick = self.clock.now
        self.clock.log(
            {"kind": "PING", "session": self.name, "n": self.pings_sent}
        )
        if self.peer_responds:
            self.clock.schedule(
                ping_tick + self.pong_delay,
                0,
                self._on_pong,
                name=f"{self.name}:pong",
            )
        self.clock.schedule(
            ping_tick + self.dead_after,
            2,
            lambda: self._check_dead(ping_tick),
            name=f"{self.name}:deadline",
        )
        self.clock.schedule(
            ping_tick + self.interval,
            0,
            self._send_ping,
            name=f"{self.name}:ping",
        )

    def _on_pong(self) -> None:
        if self.state != self.ALIVE:
            return
        self.last_pong_tick = self.clock.now
        self.clock.log({"kind": "PONG", "session": self.name})

    def _check_dead(self, ping_tick: int) -> None:
        if self.state != self.ALIVE:
            return
        last = self.last_pong_tick
        if last is None or last < ping_tick:
            self.state = self.DEAD
            self.clock.log(
                {"kind": "DEAD", "session": self.name, "since_ping": ping_tick}
            )
