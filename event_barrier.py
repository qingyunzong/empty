#!/usr/bin/env python3
"""有序事件屏障合流(ordered event barrier confluence)。

多分区事件流按水位线(watermark)对齐合流:
  * 每个分区产生数据事件与单调递增的水位线;
  * 只有当【全部活跃分区】的水位线都严格越过事件时间(min_active_wm > event.time),
    事件才可安全释放; 相等不可释放;
  * 输出按 (事件时间, 分区ID, 序号) 排序;
  * 分区空闲必须显式发送 idle 屏障标记, 空闲分区不参与最小水位线计算;
  * 状态可持久化到 state 文件, 重启恢复后不重发已提交输出;
  * 迟到事件(到达时最小活跃水位线已越过其事件时间)单独记录, 不进入主输出。

仅使用 Python 3.11 标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, IO


@dataclass(frozen=True, order=True)
class EventKey:
    """事件的全序键: (事件时间, 分区ID, 序号)。"""

    time: int
    partition: int
    seq: int


@dataclass
class Released:
    key: EventKey
    payload: Any

    def to_dict(self) -> dict:
        return {
            "time": self.key.time,
            "partition": self.key.partition,
            "seq": self.key.seq,
            "payload": self.payload,
        }


class BarrierAligner:
    """多分区水位线对齐合流器。状态可序列化, 支持重启恢复。"""

    def __init__(self) -> None:
        self.watermarks: dict[int, int] = {}      # 已知分区 -> 当前水位线
        self.idle: set[int] = set()               # 显式标记为空闲的分区
        self.buffer: dict[EventKey, Any] = {}     # 待释放事件缓冲
        self.emitted: set[EventKey] = set()       # 已提交输出的事件键(精确去重)
        self.emitted_frontier: EventKey | None = None  # 已提交输出的最大键
        self.duplicates = 0                        # 重启后重复投喂被丢弃的事件数
        self.nonmonotonic = 0                      # 被忽略的非单调水位线数

    # ---- 状态序列化 ----

    def to_state(self) -> dict:
        return {
            "watermarks": {str(p): w for p, w in self.watermarks.items()},
            "idle": sorted(self.idle),
            "buffer": [
                {"time": k.time, "partition": k.partition, "seq": k.seq, "payload": v}
                for k, v in sorted(self.buffer.items())
            ],
            "emitted": [[k.time, k.partition, k.seq] for k in sorted(self.emitted)],
            "emitted_frontier": (
                [
                    self.emitted_frontier.time,
                    self.emitted_frontier.partition,
                    self.emitted_frontier.seq,
                ]
                if self.emitted_frontier is not None
                else None
            ),
        }

    @classmethod
    def from_state(cls, state: dict) -> "BarrierAligner":
        aligner = cls()
        aligner.watermarks = {int(p): int(w) for p, w in state.get("watermarks", {}).items()}
        aligner.idle = {int(p) for p in state.get("idle", [])}
        for item in state.get("buffer", []):
            key = EventKey(int(item["time"]), int(item["partition"]), int(item["seq"]))
            aligner.buffer[key] = item["payload"]
        for t, p, s in state.get("emitted", []):
            aligner.emitted.add(EventKey(int(t), int(p), int(s)))
        frontier = state.get("emitted_frontier")
        if frontier is not None:
            aligner.emitted_frontier = EventKey(int(frontier[0]), int(frontier[1]), int(frontier[2]))
        return aligner

    # ---- 内部逻辑 ----

    def min_active_watermark(self) -> int | None:
        """全部活跃(已知且非空闲)分区水位线的最小值; 无活跃分区时为 None。"""
        active = [w for p, w in self.watermarks.items() if p not in self.idle]
        return min(active) if active else None

    def _drain(self) -> list[Released]:
        """释放所有事件时间被最小活跃水位线严格越过的缓冲事件(按全序键排序)。"""
        frontier = self.min_active_watermark()
        if frontier is None:
            return []
        ready = sorted(k for k in self.buffer if k.time < frontier)
        out = [Released(k, self.buffer.pop(k)) for k in ready]
        if out:
            self.emitted.update(r.key for r in out)
            self.emitted_frontier = out[-1].key
        return out

    # ---- 算子入口: 返回 (released, late_record_or_none) ----

    def add_event(self, partition: int, time: int, seq: int, payload: Any) -> tuple[list[Released], dict | None]:
        key = EventKey(time, partition, seq)
        self.watermarks.setdefault(partition, 0)
        # 1) 已提交过的输出 -> 重启重复投喂, 精确去重丢弃
        if key in self.emitted:
            self.duplicates += 1
            return [], None
        # 2) 缓冲区已有同键事件 -> 重复, 丢弃
        if key in self.buffer:
            self.duplicates += 1
            return [], None
        # 3) 最小活跃水位线已越过事件时间 -> 迟到, 单独记录
        frontier = self.min_active_watermark()
        if frontier is not None and time < frontier:
            return [], {
                "time": time,
                "partition": partition,
                "seq": seq,
                "payload": payload,
                "reason": "late",
                "min_active_watermark": frontier,
            }
        self.buffer[key] = payload
        return self._drain(), None

    def advance_watermark(self, partition: int, time: int) -> list[Released]:
        current = self.watermarks.get(partition)
        if current is not None and time < current:
            self.nonmonotonic += 1  # 水位线必须单调, 回退者忽略
            return []
        self.watermarks[partition] = time
        return self._drain()

    def mark_idle(self, partition: int) -> list[Released]:
        self.watermarks.setdefault(partition, 0)
        self.idle.add(partition)
        return self._drain()

    def mark_active(self, partition: int) -> list[Released]:
        self.watermarks.setdefault(partition, 0)
        self.idle.discard(partition)
        return self._drain()


# ---- CLI ----

def _load_aligner(state_path: str | None) -> BarrierAligner:
    if state_path and os.path.exists(state_path):
        with open(state_path, "r", encoding="utf-8") as fh:
            return BarrierAligner.from_state(json.load(fh))
    return BarrierAligner()


def _save_aligner(aligner: BarrierAligner, state_path: str | None) -> None:
    if not state_path:
        return
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(aligner.to_state(), fh, ensure_ascii=False, indent=2)
    os.replace(tmp, state_path)  # 原子提交, 避免崩溃留下半截状态


def run_stream(aligner: BarrierAligner, lines: IO[str], out: IO[str], late: IO[str] | None,
               state_path: str | None) -> dict:
    stats = {"released": 0, "late": 0}
    for lineno, raw in enumerate(lines, 1):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        op = json.loads(raw)
        kind = op["op"]
        if kind == "event":
            released, late_rec = aligner.add_event(
                int(op["partition"]), int(op["time"]), int(op["seq"]), op.get("payload")
            )
        elif kind == "watermark":
            released, late_rec = aligner.advance_watermark(int(op["partition"]), int(op["time"])), None
        elif kind == "idle":
            released, late_rec = aligner.mark_idle(int(op["partition"])), None
        elif kind == "active":
            released, late_rec = aligner.mark_active(int(op["partition"])), None
        elif kind == "commit":
            _save_aligner(aligner, state_path)
            continue
        else:
            raise ValueError(f"第 {lineno} 行: 未知 op {kind!r}")
        for item in released:
            out.write(json.dumps(item.to_dict(), ensure_ascii=False) + "\n")
            stats["released"] += 1
        if late_rec is not None:
            stats["late"] += 1
            if late is not None:
                late.write(json.dumps(late_rec, ensure_ascii=False) + "\n")
        _save_aligner(aligner, state_path)  # 每条算子后落盘, 保证崩溃/重启不重发
    out.flush()
    if late is not None:
        late.flush()
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="event_barrier",
        description="有序事件屏障合流: 多分区水位线对齐, 按 (时间,分区,序号) 有序释放。",
    )
    parser.add_argument("input", help="输入算子 JSONL 文件, '-' 表示标准输入")
    parser.add_argument("--state", help="状态文件路径(用于重启恢复); 不指定则为纯内存运行")
    parser.add_argument("--out", help="已释放输出 JSONL(追加写); 缺省为标准输出")
    parser.add_argument("--late", help="迟到事件记录 JSONL(追加写); 缺省不记录")
    args = parser.parse_args(argv)

    aligner = _load_aligner(args.state)
    lines = sys.stdin if args.input == "-" else open(args.input, "r", encoding="utf-8")
    out = sys.stdout if not args.out or args.out == "-" else open(args.out, "a", encoding="utf-8")
    late = open(args.late, "a", encoding="utf-8") if args.late else None
    try:
        stats = run_stream(aligner, lines, out, late, args.state)
    finally:
        for fh in (lines, out, late):
            if fh is not None and fh not in (sys.stdin, sys.stdout):
                fh.close()
    print(
        f"released={stats['released']} late={stats['late']} "
        f"duplicates={aligner.duplicates} nonmonotonic_wm={aligner.nonmonotonic} "
        f"buffered={len(aligner.buffer)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
