"""event_barrier 的 unittest 测试（全部使用合成数据）。"""
import json
import tempfile
import unittest
from pathlib import Path

from event_barrier import COMMITTED_FILE, LATE_FILE, EventBarrier


def wm(partition, time):
    return {"type": "watermark", "partition": partition, "time": time}


def data(partition, time, seq, payload=None):
    return {"type": "data", "partition": partition, "time": time, "seq": seq, "payload": payload}


def barrier(partition, state="idle"):
    return {"type": "barrier", "partition": partition, "state": state}


class EventBarrierTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.eb = EventBarrier(self.dir)

    def released_times(self, released):
        return [e["time"] for e in released]

    # ---- 验收边界 ----

    def test_acceptance_boundary(self):
        # 两个活跃分区水位线 10 和 5，时间 7 的事件不能释放
        self.eb.process(wm(0, 10))
        self.eb.process(wm(1, 5))
        self.assertEqual(self.eb.process(data(1, 7, 1)), [])
        # 相等（7）仍不可释放：水位线必须严格大于事件时间
        self.assertEqual(self.eb.process(wm(1, 7)), [])
        # 后者推进到 8 后可释放
        released = self.eb.process(wm(1, 8))
        self.assertEqual(self.released_times(released), [7])

    def test_equal_watermark_does_not_release(self):
        self.eb.process(data(0, 7, 1))
        self.eb.process(data(1, 6, 1))
        self.eb.process(wm(0, 7))
        self.assertEqual(self.eb.process(wm(1, 7)), [  # 地平线=7，仅 6<7 可释放
            {"partition": 1, "seq": 1, "time": 6, "payload": None},
        ])
        self.assertEqual(len(self.eb.buffer), 1)  # 时间 7 的事件仍被阻塞

    # ---- 排序 ----

    def test_output_ordering_by_time_partition_seq(self):
        self.eb.process(data(1, 2, 2))
        self.eb.process(data(0, 2, 5))
        self.eb.process(data(1, 2, 1))
        self.eb.process(data(0, 1, 9))
        self.eb.process(data(1, 1, 3))
        self.eb.process(wm(0, 3))
        released = self.eb.process(wm(1, 3))  # 地平线 = 3，释放全部 time<3
        order = [(e["time"], e["partition"], e["seq"]) for e in released]
        self.assertEqual(
            order,
            [(1, 0, 9), (1, 1, 3), (2, 0, 5), (2, 1, 1), (2, 1, 2)],
        )

    # ---- 空闲分区屏障 ----

    def test_idle_partition_does_not_block(self):
        self.eb.process(wm(1, 0))                            # 分区 1 活跃，水位线 0
        self.eb.process(data(0, 5, 1))
        self.assertEqual(self.eb.process(wm(0, 10)), [])     # 地平线 0，被分区 1 阻塞
        released = self.eb.process(barrier(1, "idle"))       # 显式屏障标记空闲
        self.assertEqual(self.released_times(released), [5])

    def test_idle_partition_reactivation_blocks_again(self):
        self.eb.process(wm(1, 0))                            # 分区 1 活跃，水位线 0
        self.eb.process(data(0, 5, 1))
        self.assertEqual(self.eb.process(wm(0, 10)), [])     # 地平线 0，阻塞
        self.assertEqual(self.released_times(self.eb.process(barrier(1, "idle"))), [5])
        self.eb.process(barrier(1, "active"))                # 重新活跃，水位线仍为 0
        self.assertEqual(self.eb.process(data(0, 11, 2)), [])  # 地平线 0，再次阻塞
        self.assertEqual(len(self.eb.buffer), 1)

    # ---- 水位线单调性 ----

    def test_watermark_is_monotonic(self):
        self.eb.process(wm(0, 10))
        self.eb.process(wm(0, 4))  # 回退被忽略
        self.assertEqual(self.eb.watermarks[0], 10)

    # ---- 迟到事件 ----

    def test_late_event_recorded_separately(self):
        self.eb.process(wm(0, 10))
        self.eb.process(wm(1, 10))
        self.assertEqual(self.eb.process(data(0, 10, 1)), [])  # 等于水位线也算迟到
        self.assertEqual(self.eb.buffer, [])
        late_lines = (Path(self.dir) / LATE_FILE).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(late_lines), 1)
        late = json.loads(late_lines[0])
        self.assertEqual(late["reason"], "late")
        self.assertEqual((late["partition"], late["seq"], late["time"]), (0, 1, 10))

    # ---- 重启恢复 ----

    def test_restart_does_not_reemit_committed(self):
        inputs = [data(0, 7, 1), data(1, 6, 2), wm(0, 10), wm(1, 8)]
        first_out = []
        for rec in inputs:
            first_out.extend(self.eb.process(rec))
        self.assertEqual(self.released_times(first_out), [6, 7])

        # 模拟重启：同一 state-dir 新建实例，重放全部输入
        eb2 = EventBarrier(self.dir)
        replay_out = []
        for rec in inputs:
            replay_out.extend(eb2.process(rec))
        self.assertEqual(replay_out, [])  # 不重发已提交输出

        # 恢复后仍能处理新事件（地平线 min(10, 8)=8，先阻塞后释放）
        self.assertEqual(eb2.process(data(1, 9, 3)), [])
        self.assertEqual(self.released_times(eb2.process(wm(1, 11))), [9])

    def test_restart_preserves_buffer_and_watermarks(self):
        self.eb.process(wm(1, 5))
        self.eb.process(data(0, 7, 1))
        self.eb.process(wm(0, 10))
        eb2 = EventBarrier(self.dir)  # 重启
        self.assertEqual(eb2.watermarks, {0: 10, 1: 5})
        self.assertEqual(len(eb2.buffer), 1)
        released = eb2.process(wm(1, 8))
        self.assertEqual(self.released_times(released), [7])

    def test_committed_log_written(self):
        self.eb.process(data(0, 3, 1))
        self.eb.process(wm(0, 10))
        committed = (Path(self.dir) / COMMITTED_FILE).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(committed), 1)
        self.assertEqual(json.loads(committed[0])["time"], 3)

    # ---- 输入去重 ----

    def test_duplicate_data_ignored(self):
        self.eb.process(data(0, 3, 1))
        self.eb.process(data(0, 3, 1))  # 同 (partition, seq) 重复
        self.eb.process(wm(0, 2))       # 地平线=2，时间 3 不释放
        self.assertEqual(len(self.eb.buffer), 1)


if __name__ == "__main__":
    unittest.main()
