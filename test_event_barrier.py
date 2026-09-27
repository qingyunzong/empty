"""event_barrier 的单元测试。全部使用合成数据。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

from event_barrier import BarrierAligner, EventKey, _load_aligner, _save_aligner

HERE = os.path.dirname(os.path.abspath(__file__))


def keys(released):
    return [(r.key.time, r.key.partition, r.key.seq) for r in released]


class AcceptanceBoundaryTest(unittest.TestCase):
    """验收边界: 两活跃分区水位线 10 和 5, 时间 7 事件不能释放;
    后者推进 8 后可释放; 相等 7 仍不可释放。"""

    def test_boundary(self):
        a = BarrierAligner()
        a.advance_watermark(0, 10)
        a.advance_watermark(1, 5)
        released, late = a.add_event(0, 7, 1, "e7")
        self.assertEqual(released, [])   # min=5, 未越过 7
        self.assertIsNone(late)
        self.assertEqual(a.advance_watermark(1, 7), [])  # 相等 7 仍不可释放
        released = a.advance_watermark(1, 8)             # min=8 > 7, 可释放
        self.assertEqual(keys(released), [(7, 0, 1)])

    def test_equal_watermark_never_releases(self):
        a = BarrierAligner()
        a.advance_watermark(0, 7)
        a.advance_watermark(1, 7)
        released, _ = a.add_event(1, 7, 1, None)
        self.assertEqual(released, [])
        self.assertEqual(len(a.buffer), 1)


class OrderingTest(unittest.TestCase):
    def test_sorted_by_time_partition_seq(self):
        a = BarrierAligner()
        a.advance_watermark(0, 3)
        a.advance_watermark(1, 3)
        # 乱序到达
        a.add_event(1, 5, 2, "b")
        a.add_event(0, 5, 9, "a")
        a.add_event(1, 5, 1, "c")
        a.add_event(0, 2, 1, "d")   # 2 < min_wm=3, 迟到, 不进缓冲
        a.advance_watermark(0, 6)
        released = a.advance_watermark(1, 6)
        self.assertEqual(keys(released), [(5, 0, 9), (5, 1, 1), (5, 1, 2)])

    def test_no_active_partition_blocks_release(self):
        a = BarrierAligner()
        released, _ = a.add_event(0, 1, 1, "x")  # 分区 0 水位线 0
        self.assertEqual(released, [])
        a.mark_idle(0)                            # 全部空闲 -> 无活跃分区
        self.assertEqual(a.min_active_watermark(), None)
        self.assertEqual(len(a.buffer), 1)


class IdleBarrierTest(unittest.TestCase):
    def test_idle_partition_excluded_from_frontier(self):
        a = BarrierAligner()
        a.advance_watermark(0, 10)
        a.advance_watermark(1, 5)
        a.add_event(0, 7, 1, "e7")
        released = a.mark_idle(1)  # 显式空闲屏障: 只剩分区 0, min=10 > 7
        self.assertEqual(keys(released), [(7, 0, 1)])

    def test_reactivate_blocks_again(self):
        a = BarrierAligner()
        a.advance_watermark(0, 10)
        a.mark_idle(1)
        a.add_event(0, 7, 1, "e7")  # 立即释放
        a.mark_active(1)            # 恢复活跃, 水位线回到 0
        released, _ = a.add_event(0, 8, 1, "e8")
        self.assertEqual(released, [])  # min=0, 被阻塞
        released = a.advance_watermark(1, 9)
        self.assertEqual(keys(released), [(8, 0, 1)])


class LateEventTest(unittest.TestCase):
    def test_late_event_recorded_separately(self):
        a = BarrierAligner()
        a.advance_watermark(0, 10)
        a.advance_watermark(1, 6)
        released, late = a.add_event(0, 5, 1, "old")  # 5 < min_wm=6 -> 迟到
        self.assertEqual(released, [])
        self.assertIsNotNone(late)
        self.assertEqual(late["reason"], "late")
        self.assertEqual(late["min_active_watermark"], 6)
        self.assertEqual(len(a.buffer), 0)  # 不进入主缓冲


class WatermarkMonotonicTest(unittest.TestCase):
    def test_regressed_watermark_ignored(self):
        a = BarrierAligner()
        a.advance_watermark(0, 10)
        self.assertEqual(a.advance_watermark(0, 4), [])
        self.assertEqual(a.watermarks[0], 10)
        self.assertEqual(a.nonmonotonic, 1)


class RecoveryTest(unittest.TestCase):
    def test_restart_does_not_reemit_committed_output(self):
        with tempfile.TemporaryDirectory() as d:
            state = os.path.join(d, "state.json")
            # 第一次运行: 释放 (7,0,1), 缓冲 (9,0,2)
            a = BarrierAligner()
            a.advance_watermark(0, 10)
            a.advance_watermark(1, 5)
            a.add_event(0, 7, 1, "e7")
            a.add_event(0, 9, 2, "e9")
            self.assertEqual(keys(a.advance_watermark(1, 8)), [(7, 0, 1)])
            _save_aligner(a, state)

            # 重启恢复: 重投相同输入, 不得重发已提交输出
            b = _load_aligner(state)
            released, late = b.add_event(0, 7, 1, "e7")
            self.assertEqual(released, [])
            self.assertIsNone(late)
            self.assertEqual(b.duplicates, 1)
            released, _ = b.add_event(0, 9, 2, "e9")  # 缓冲中已有, 去重
            self.assertEqual(released, [])
            self.assertEqual(b.duplicates, 2)
            # 缓冲事件在恢复后仍可被后续水位线释放
            released = b.advance_watermark(1, 10)
            self.assertEqual(keys(released), [(9, 0, 2)])

    def test_state_roundtrip(self):
        a = BarrierAligner()
        a.advance_watermark(0, 10)
        a.mark_idle(2)
        a.add_event(1, 3, 1, {"x": 1})
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.json")
            _save_aligner(a, path)
            b = _load_aligner(path)
        self.assertEqual(a.to_state(), b.to_state())


class CliTest(unittest.TestCase):
    def test_cli_end_to_end_and_restart(self):
        with tempfile.TemporaryDirectory() as d:
            inp = os.path.join(d, "in.jsonl")
            out = os.path.join(d, "out.jsonl")
            late = os.path.join(d, "late.jsonl")
            state = os.path.join(d, "state.json")
            ops = [
                {"op": "watermark", "partition": 0, "time": 10},
                {"op": "watermark", "partition": 1, "time": 5},
                {"op": "event", "partition": 0, "time": 7, "seq": 1, "payload": "e7"},
                {"op": "watermark", "partition": 1, "time": 7},   # 相等, 不释放
                {"op": "watermark", "partition": 1, "time": 8},   # 释放 e7
                {"op": "event", "partition": 1, "time": 6, "seq": 1, "payload": "late"},
                {"op": "commit"},
            ]
            with open(inp, "w", encoding="utf-8") as fh:
                fh.write("\n".join(json.dumps(o) for o in ops) + "\n")

            cmd = [sys.executable, os.path.join(HERE, "event_barrier.py"),
                   inp, "--state", state, "--out", out, "--late", late]
            r1 = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(r1.returncode, 0, r1.stderr)
            with open(out, encoding="utf-8") as fh:
                lines1 = fh.readlines()
            self.assertEqual(len(lines1), 1)
            rec = json.loads(lines1[0])
            self.assertEqual((rec["time"], rec["partition"], rec["seq"]), (7, 0, 1))
            with open(late, encoding="utf-8") as fh:
                late_recs = [json.loads(x) for x in fh]
            self.assertEqual(len(late_recs), 1)
            self.assertEqual(late_recs[0]["reason"], "late")

            # 重启后重投同一输入: 不得新增任何输出
            r2 = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(r2.returncode, 0, r2.stderr)
            with open(out, encoding="utf-8") as fh:
                self.assertEqual(fh.readlines(), lines1)
            self.assertIn("duplicates=1", r2.stderr)


if __name__ == "__main__":
    unittest.main()
