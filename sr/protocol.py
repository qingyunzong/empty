"""选择性重传（Selective Repeat）协议核心实现。

约束论证（N <= 序号空间 / 2）：
    设序号空间 M=8。若窗口 N=5，发送方发出 0..4 并被接收方全部按序接收后，
    接收窗口滑动到 [5,6,7,0,1]。若这些 ACK 全部丢失，发送方超时重传旧帧 0，
    而序号 0 落在接收方新窗口内，会被误当作"新帧"接收并重复交付——
    接收方无法区分"重传的旧帧"与"下一周期的新帧"。
    当 N <= M/2 时（如 N=4），接收窗口滑动后为 [4,5,6,7]，
    重传的旧帧 0..3 全部落在窗口之外，不存在二义性。
    因此本实现强制校验 2*N <= M，违反时抛出 ValueError。
"""

from __future__ import annotations


def validate_params(window_size: int, seq_space: int) -> None:
    """校验窗口与序号空间约束：N <= 序号空间 / 2，违反抛 ValueError。"""
    if not isinstance(window_size, int) or not isinstance(seq_space, int):
        raise ValueError("window_size 与 seq_space 必须为整数")
    if isinstance(window_size, bool) or isinstance(seq_space, bool):
        raise ValueError("window_size 与 seq_space 必须为整数")
    if window_size < 1:
        raise ValueError("window_size 必须 >= 1")
    if seq_space < 2:
        raise ValueError("seq_space 必须 >= 2")
    if 2 * window_size > seq_space:
        raise ValueError(
            f"非法参数：窗口 N={window_size} 超过序号空间 {seq_space} 的一半；"
            f"选择重传要求 N <= 序号空间/2（此处 N 最大为 {seq_space // 2}）"
        )


def in_window(seq: int, base: int, size: int, space: int) -> bool:
    """判断 seq 是否落在 [base, base+size)（模 space）窗口内。"""
    return (seq - base) % space < size


class VirtualClock:
    """虚拟时钟：advance 按（到期时刻, 序号）顺序触发定时器。

    同一时刻到期的多个定时器按序号升序依次触发。
    """

    def __init__(self) -> None:
        self.now = 0
        self._timers: dict[int, int] = {}  # 键（帧下标）-> 到期时刻
        self.on_fire = None  # 回调 callable(key)

    def schedule(self, key: int, delay: int) -> None:
        self._timers[key] = self.now + delay

    def cancel(self, key: int) -> None:
        self._timers.pop(key, None)

    def pending(self) -> dict[int, int]:
        return dict(self._timers)

    def next_expiry(self):
        return min(self._timers.values(), default=None)

    def advance(self, delta: int) -> list[int]:
        """推进 delta 个时间单位，按到期顺序触发定时器，返回触发序列。"""
        if delta < 0:
            raise ValueError("delta 必须 >= 0")
        target = self.now + delta
        fired: list[int] = []
        while self._timers:
            expiry = min(self._timers.values())
            if expiry > target:
                break
            self.now = expiry
            # 同刻到期的多个定时器按序号升序触发
            for key in sorted(k for k, e in self._timers.items() if e == expiry):
                del self._timers[key]
                fired.append(key)
                if self.on_fire is not None:
                    self.on_fire(key)
        self.now = target
        return fired

    def advance_to_next(self) -> bool:
        """推进到最早到期的定时器并触发；无定时器时返回 False。"""
        expiry = self.next_expiry()
        if expiry is None:
            return False
        self.advance(expiry - self.now)
        return True


class Sender:
    """SR 发送方：每帧独立定时器，超时仅重传该帧；收到窗口下沿 ACK 才滑动。"""

    def __init__(self, window_size: int, seq_space: int, timeout: int,
                 clock: VirtualClock | None = None, first_seq: int = 1) -> None:
        validate_params(window_size, seq_space)
        if timeout < 1:
            raise ValueError("timeout 必须 >= 1")
        self.window_size = window_size
        self.seq_space = seq_space
        self.timeout = timeout
        self.clock = clock if clock is not None else VirtualClock()
        self.base = first_seq       # 发送窗口下沿（绝对帧号）
        self.next_idx = first_seq   # 下一个待发送的绝对帧号
        self.acked: set[int] = set()
        self.retransmissions = 0

    def seq_of(self, idx: int) -> int:
        return idx % self.seq_space

    def frames_to_send(self, last_idx: int) -> list[int]:
        """窗口内尚未发送的绝对帧号。"""
        upper = min(self.base + self.window_size, last_idx + 1)
        return list(range(self.next_idx, upper))

    def send_frame(self, idx: int) -> int:
        """发送新帧并启动其独立定时器，返回线上序号。"""
        self.next_idx = max(self.next_idx, idx + 1)
        self.clock.schedule(idx, self.timeout)
        return self.seq_of(idx)

    def receive_ack(self, seq: int):
        """处理 ACK。仅当确认的是窗口下沿时滑动窗口；返回滑动后的新下沿或 None。"""
        idx = None
        for candidate in range(self.base, self.next_idx):
            if candidate not in self.acked and self.seq_of(candidate) == seq:
                idx = candidate
                break
        if idx is None:
            return None  # 重复或过期 ACK，忽略
        self.acked.add(idx)
        self.clock.cancel(idx)  # 确认后取消该帧定时器
        if idx != self.base:
            return None  # 非下沿 ACK：仅标记，不滑动
        while self.base in self.acked:
            self.acked.discard(self.base)
            self.base += 1
        return self.base

    def retransmit(self, idx: int) -> int:
        """超时重传：仅重传该帧并重启其定时器。"""
        self.retransmissions += 1
        self.clock.schedule(idx, self.timeout)
        return self.seq_of(idx)


class Receiver:
    """SR 接收方：缓存乱序帧并逐个 ACK，按序交付。

    语义：
    - 窗口外帧直接丢弃（不回 ACK）；
    - 窗口内重复帧重发 ACK，但不重复交付。
    """

    def __init__(self, window_size: int, seq_space: int, first_seq: int = 1) -> None:
        validate_params(window_size, seq_space)
        self.window_size = window_size
        self.seq_space = seq_space
        self.rbase = first_seq % seq_space  # 期望收到的下一个序号
        self.buffered: set[int] = set()     # 已缓存未交付的序号
        self.acks_sent = 0

    def receive_frame(self, seq: int):
        """返回 (ack_seq 或 None, 本次按序交付的序号列表)。"""
        if not in_window(seq, self.rbase, self.window_size, self.seq_space):
            return None, []  # 窗口外：直接丢弃
        self.acks_sent += 1
        if seq in self.buffered:
            return seq, []  # 重复帧：重发 ACK，不重复交付
        self.buffered.add(seq)
        delivered: list[int] = []
        while self.rbase in self.buffered:
            self.buffered.discard(self.rbase)
            delivered.append(self.rbase)
            self.rbase = (self.rbase + 1) % self.seq_space
        return seq, delivered
