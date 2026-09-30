import contextlib
import io
import json
import os
import tempfile
import unittest

from sr import Receiver, Sender, Simulation, VirtualClock, validate_params
from sr.cli import main as cli_main


class TestScenarioAFrameLost(unittest.TestCase):
    """场景 a：仅帧 1 丢失，帧 2、3 被缓存，帧 1 重传后一次性交付 1、2、3。"""

    def test_delivery_and_reference_event_table(self):
        sim = Simulation(window_size=4, seq_space=8, timeout=10,
                         num_frames=3, loss=[1])
        delivered, retransmissions = sim.run()
        self.assertEqual(delivered, [1, 2, 3])
        self.assertEqual(retransmissions, 1)
        # 参考枚举表：完整事件序列逐一比对
        expected_events = [
            ("send", 1), ("drop", 1),
            ("send", 2), ("recv", 2), ("ack", 2),
            ("send", 3), ("recv", 3), ("ack", 3),
            ("timeout", 1), ("resend", 1), ("recv", 1),
            ("deliver", 1), ("deliver", 2), ("deliver", 3),
            ("ack", 1), ("slide", 4),
        ]
        self.assertEqual(sim.events, expected_events)

    def test_out_of_order_frames_buffered_until_base_arrives(self):
        sim = Simulation(window_size=4, seq_space=8, timeout=10,
                         num_frames=3, loss=[1])
        # 首传阶段：帧 2、3 到达时被缓存而非交付
        sim.sender.send_frame(1)
        sim._transmit(1, resend=False)  # 丢弃
        sim.sender.send_frame(2)
        sim._transmit(2, resend=False)
        sim.sender.send_frame(3)
        sim._transmit(3, resend=False)
        self.assertEqual(sim.delivered, [])
        self.assertEqual(sim.receiver.buffered, {2, 3})
        # 帧 1 超时重传后一次性交付 1、2、3
        sim.clock.advance_to_next()
        self.assertEqual(sim.delivered, [1, 2, 3])


class TestScenarioBDuplicateFrame(unittest.TestCase):
    """场景 b：同帧两次到达，重发 ACK 但不重复交付。"""

    def test_duplicate_frame_dedup(self):
        rx = Receiver(window_size=4, seq_space=8)
        ack1, d1 = rx.receive_frame(2)
        ack2, d2 = rx.receive_frame(2)  # 重复到达
        self.assertEqual(ack1, 2)
        self.assertEqual(ack2, 2)       # 重复帧仍重发 ACK
        self.assertEqual(d1, [])
        self.assertEqual(d2, [])        # 不重复交付
        self.assertEqual(rx.acks_sent, 2)
        # 帧 1 到达后按序交付，2 只交付一次
        ack3, d3 = rx.receive_frame(1)
        self.assertEqual(ack3, 1)
        self.assertEqual(d3, [1, 2])
        # 窗口已滑动到 3，旧帧 2 落在窗口外：直接丢弃、不再 ACK
        ack4, d4 = rx.receive_frame(2)
        self.assertIsNone(ack4)
        self.assertEqual(d4, [])
        self.assertEqual(rx.acks_sent, 3)

    def test_duplicate_retransmission_in_simulation(self):
        # 帧 1 连续丢失两次首传语义之外的重复：手动重放同一帧
        sim = Simulation(window_size=4, seq_space=8, timeout=10,
                         num_frames=2, loss=[])
        delivered, _ = sim.run()
        self.assertEqual(delivered, [1, 2])
        # 模拟发送方未收到 ACK 而再次重传已交付帧（窗口外）→ 丢弃
        ack, d = sim.receiver.receive_frame(1)
        self.assertIsNone(ack)
        self.assertEqual(d, [])
        self.assertEqual(sim.delivered, [1, 2])


class TestScenarioCTimerTieOrder(unittest.TestCase):
    """场景 c：两个定时器同 tick 到期，按序号小先触发。"""

    def test_clock_fires_same_tick_timers_by_ascending_seq(self):
        clock = VirtualClock()
        fired = []
        clock.on_fire = fired.append
        clock.schedule(3, 10)
        clock.schedule(1, 10)
        clock.schedule(2, 5)
        clock.advance(10)
        self.assertEqual(fired, [2, 1, 3])  # t=5 先触发 2；t=10 同刻按 1、3 顺序
        self.assertEqual(clock.now, 10)

    def test_simulation_two_lost_frames_timeout_order(self):
        sim = Simulation(window_size=4, seq_space=8, timeout=10,
                         num_frames=4, loss=[1, 2])
        delivered, retransmissions = sim.run()
        self.assertEqual(delivered, [1, 2, 3, 4])
        self.assertEqual(retransmissions, 2)
        timeouts = [e for e in sim.events if e[0] == "timeout"]
        self.assertEqual(timeouts, [("timeout", 1), ("timeout", 2)])


class TestScenarioDInvalidParams(unittest.TestCase):
    """场景 d：N=5、序号空间 8 构造抛 ValueError。"""

    def test_window_5_seq_space_8_raises(self):
        with self.assertRaises(ValueError):
            Sender(5, 8, timeout=10)
        with self.assertRaises(ValueError):
            Receiver(5, 8)
        with self.assertRaises(ValueError):
            Simulation(window_size=5, seq_space=8, num_frames=3)
        with self.assertRaises(ValueError):
            validate_params(5, 8)

    def test_boundary_values(self):
        validate_params(4, 8)   # N == M/2，合法
        validate_params(1, 2)   # 最小合法组合
        with self.assertRaises(ValueError):
            validate_params(4, 7)   # 4 > 7/2
        with self.assertRaises(ValueError):
            validate_params(0, 8)
        with self.assertRaises(ValueError):
            validate_params(4, 1)


class TestSenderWindowSemantics(unittest.TestCase):
    """语义 3：发送方仅收到窗口下沿 ACK 才滑动。"""

    def test_slides_only_on_base_ack(self):
        sender = Sender(4, 8, timeout=10)
        for idx in (1, 2, 3):
            sender.send_frame(idx)
        # 收到非下沿 ACK（2、3）：标记但不滑动
        self.assertIsNone(sender.receive_ack(2))
        self.assertIsNone(sender.receive_ack(3))
        self.assertEqual(sender.base, 1)
        # 收到下沿 ACK（1）：一次性滑过已连续确认的 1、2、3
        self.assertEqual(sender.receive_ack(1), 4)
        self.assertEqual(sender.base, 4)

    def test_acked_frame_timer_cancelled(self):
        sender = Sender(4, 8, timeout=10)
        sender.send_frame(1)
        sender.receive_ack(1)
        self.assertEqual(sender.clock.pending(), {})  # 定时器已取消
        # 时钟推进不再触发任何重传
        fired = sender.clock.advance(100)
        self.assertEqual(fired, [])
        self.assertEqual(sender.retransmissions, 0)


class TestReceiverWindowSemantics(unittest.TestCase):
    """语义 1：接收窗口外帧直接丢弃。"""

    def test_out_of_window_frame_dropped(self):
        rx = Receiver(window_size=4, seq_space=8)  # 窗口 [1,2,3,4]
        ack, delivered = rx.receive_frame(6)
        self.assertIsNone(ack)
        self.assertEqual(delivered, [])
        self.assertEqual(rx.acks_sent, 0)
        self.assertEqual(rx.buffered, set())


class TestCLI(unittest.TestCase):
    """CLI：python -m sr run trace.json 输出交付序列与重传计数。"""

    def test_run_trace(self):
        cfg = {"window_size": 4, "seq_space": 8, "timeout": 10,
               "num_frames": 3, "loss": [1]}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "trace.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cfg, f)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = cli_main(["run", path])
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["delivered"], [1, 2, 3])
        self.assertEqual(out["retransmissions"], 1)


class TestNoLossBaseline(unittest.TestCase):
    def test_no_loss_in_order_delivery(self):
        sim = Simulation(window_size=4, seq_space=8, timeout=10,
                         num_frames=5, loss=[])
        delivered, retransmissions = sim.run()
        self.assertEqual(delivered, [1, 2, 3, 4, 5])
        self.assertEqual(retransmissions, 0)


if __name__ == "__main__":
    unittest.main()
