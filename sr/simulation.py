"""SR 协议仿真器：单条丢包信道 + 虚拟时钟驱动。"""

from __future__ import annotations

from .protocol import Receiver, Sender, VirtualClock


class Simulation:
    """按 trace 配置驱动发送方/接收方，记录完整事件序列。

    事件类型：
        send    发送新帧          drop   首传被信道丢弃
        recv    接收方收到帧      ack    接收方回 ACK
        deliver 按序交付          slide  发送窗口滑动（新下沿）
        timeout 定时器到期        resend 超时重传该帧
    """

    def __init__(self, window_size: int = 4, seq_space: int = 8,
                 timeout: int = 10, num_frames: int = 3,
                 loss=(), first_seq: int = 1) -> None:
        self.clock = VirtualClock()
        self.sender = Sender(window_size, seq_space, timeout,
                             clock=self.clock, first_seq=first_seq)
        self.receiver = Receiver(window_size, seq_space, first_seq=first_seq)
        self.last_idx = first_seq + num_frames - 1
        self.loss = set(loss)  # 首传即被丢弃的绝对帧号
        self.events: list[tuple] = []
        self.delivered: list[int] = []
        self._dropped: set[int] = set()
        self.clock.on_fire = self._on_timeout

    @property
    def retransmissions(self) -> int:
        return self.sender.retransmissions

    def _transmit(self, idx: int, resend: bool) -> None:
        seq = self.sender.seq_of(idx)
        if not resend and idx in self.loss and idx not in self._dropped:
            self._dropped.add(idx)
            self.events.append(("drop", idx))
            return
        self.events.append(("recv", idx))
        ack, delivered = self.receiver.receive_frame(seq)
        for d in delivered:
            self.events.append(("deliver", d))
            self.delivered.append(d)
        if ack is not None:
            self.events.append(("ack", ack))
            new_base = self.sender.receive_ack(ack)
            if new_base is not None:
                self.events.append(("slide", new_base))

    def _on_timeout(self, idx: int) -> None:
        self.events.append(("timeout", idx))
        self.sender.retransmit(idx)
        self.events.append(("resend", idx))
        self._transmit(idx, resend=True)

    def run(self, max_steps: int = 10000):
        """运行至全部帧被确认，返回 (交付序列, 重传计数)。"""
        for _ in range(max_steps):
            sent = False
            for idx in self.sender.frames_to_send(self.last_idx):
                self.sender.send_frame(idx)
                self.events.append(("send", idx))
                self._transmit(idx, resend=False)
                sent = True
            if self.sender.base > self.last_idx:
                return self.delivered, self.retransmissions
            if sent:
                continue  # 窗口可能因滑动腾出空间，优先继续发送新帧
            if not self.clock.advance_to_next():
                raise RuntimeError("仿真停滞：存在未确认帧但无待触发定时器")
        raise RuntimeError("仿真未收敛")
