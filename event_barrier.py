#!/usr/bin/env python3.11
"""有序事件屏障合流（ordered event barrier merge）。

多分区数据事件 + 单调水位线合流：
  * 输出按 (event_time, partition, seq) 排序；
  * 仅当【全部活跃分区】的水位线都【严格大于】事件时间时才安全释放；
  * 分区空闲必须通过显式 barrier 标记，否则视为活跃并阻塞释放；
  * 状态持久化到 state-dir，重启恢复后不重发已提交输出；
  * 迟到事件（event_time <= 本分区当前水位线）单独记录到 late.jsonl。

仅使用 Python 3.11 标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

STATE_FILE = "state.json"
COMMITTED_FILE = "committed.jsonl"
LATE_FILE = "late.jsonl"

NEG_INF = float("-inf")


class EventBarrier:
    """跨分区有序事件屏障合流器，状态持久化在 state_dir 中。"""

    def __init__(self, state_dir: str | os.PathLike[str]) -> None:
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        # partition -> 当前水位线（单调不减）
        self.watermarks: dict[int, float] = {}
        # partition -> 是否活跃（缺省活跃；空闲需显式 barrier 标记）
        self.active: dict[int, bool] = {}
        # 已缓冲、尚未释放的数据事件
        self.buffer: list[dict[str, Any]] = []
        # 已提交输出的 (partition, seq)，用于重启去重
        self.committed_keys: set[tuple[int, int]] = set()
        self._load()

    # ---------- 持久化 ----------

    def _load(self) -> None:
        state_path = self.state_dir / STATE_FILE
        if state_path.exists():
            data = json.loads(state_path.read_text(encoding="utf-8"))
            self.watermarks = {int(k): v for k, v in data["watermarks"].items()}
            self.active = {int(k): v for k, v in data["active"].items()}
            self.buffer = list(data["buffer"])
        committed_path = self.state_dir / COMMITTED_FILE
        if committed_path.exists():
            for line in committed_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    rec = json.loads(line)
                    self.committed_keys.add((rec["partition"], rec["seq"]))

    def _save_state(self) -> None:
        tmp_path = self.state_dir / (STATE_FILE + ".tmp")
        tmp_path.write_text(
            json.dumps(
                {
                    "watermarks": self.watermarks,
                    "active": self.active,
                    "buffer": self.buffer,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        os.replace(tmp_path, self.state_dir / STATE_FILE)

    def _append_jsonl(self, name: str, record: dict[str, Any]) -> None:
        with open(self.state_dir / name, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    # ---------- 核心语义 ----------

    def horizon(self) -> float | None:
        """释放地平线 = 全部活跃分区水位线的最小值；无活跃分区时返回 None。"""
        act = [p for p, is_active in self.active.items() if is_active]
        if not act:
            return None
        return min(self.watermarks.get(p, NEG_INF) for p in act)

    def process(self, rec: dict[str, Any]) -> list[dict[str, Any]]:
        """处理一条输入记录，返回本次新释放（提交）的有序事件列表。"""
        rtype = rec.get("type")
        if rtype == "data":
            self._on_data(rec)
        elif rtype == "watermark":
            self._on_watermark(rec)
        elif rtype == "barrier":
            self._on_barrier(rec)
        else:
            raise ValueError(f"未知记录类型: {rtype!r}")
        released = self._release()
        self._save_state()
        return released

    def _on_data(self, rec: dict[str, Any]) -> None:
        partition = int(rec["partition"])
        key = (partition, int(rec["seq"]))
        # 重启/重复输入去重：已提交的事件直接忽略（判定迟到之前先查提交日志）
        if key in self.committed_keys:
            return
        if any((e["partition"], e["seq"]) == key for e in self.buffer):
            return
        event_time = rec["time"]
        wm = self.watermarks.get(partition)
        if wm is not None and event_time <= wm:
            # 迟到事件：水位线已越过其事件时间，无法保证有序，单独记录
            self._append_jsonl(
                LATE_FILE,
                {
                    "reason": "late",
                    "partition": partition,
                    "seq": rec["seq"],
                    "time": event_time,
                    "watermark": wm,
                    "payload": rec.get("payload"),
                },
            )
            return
        self.active.setdefault(partition, True)
        self.buffer.append(
            {
                "partition": partition,
                "seq": int(rec["seq"]),
                "time": event_time,
                "payload": rec.get("payload"),
            }
        )

    def _on_watermark(self, rec: dict[str, Any]) -> None:
        partition = int(rec["partition"])
        # 水位线到达意味着该分区在产生数据，视为活跃
        self.active[partition] = True
        current = self.watermarks.get(partition, NEG_INF)
        # 单调性：水位线只允许前进，回退输入被忽略
        if rec["time"] > current:
            self.watermarks[partition] = rec["time"]

    def _on_barrier(self, rec: dict[str, Any]) -> None:
        partition = int(rec["partition"])
        state = rec.get("state", "idle")
        if state not in ("idle", "active"):
            raise ValueError(f"未知 barrier 状态: {state!r}")
        self.active[partition] = state == "active"

    def _release(self) -> list[dict[str, Any]]:
        horizon = self.horizon()
        if horizon is None:
            return []
        ready = [e for e in self.buffer if e["time"] < horizon]
        if not ready:
            return []
        ready.sort(key=lambda e: (e["time"], e["partition"], e["seq"]))
        released: list[dict[str, Any]] = []
        for event in ready:
            key = (event["partition"], event["seq"])
            if key in self.committed_keys:
                continue
            self.committed_keys.add(key)
            self._append_jsonl(COMMITTED_FILE, event)
            released.append(event)
        released_keys = {(e["partition"], e["seq"]) for e in ready}
        self.buffer = [
            e for e in self.buffer if (e["partition"], e["seq"]) not in released_keys
        ]
        return released


def run(stream: Iterable[str], state_dir: str | os.PathLike[str], out) -> int:
    barrier = EventBarrier(state_dir)
    count = 0
    for lineno, line in enumerate(stream, 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"第 {lineno} 行不是合法 JSON: {exc}") from exc
        for event in barrier.process(rec):
            out.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="有序事件屏障合流：按 (time, partition, seq) 有序释放被全部活跃分区水位线越过的事件。"
    )
    parser.add_argument("input", nargs="?", help="JSONL 输入文件（缺省读标准输入）")
    parser.add_argument(
        "--state-dir",
        default=".ebstate",
        help="状态目录（state.json / committed.jsonl / late.jsonl），缺省 ./.ebstate",
    )
    args = parser.parse_args(argv)

    if args.input:
        with open(args.input, encoding="utf-8") as fh:
            count = run(fh, args.state_dir, sys.stdout)
    else:
        count = run(sys.stdin, args.state_dir, sys.stdout)
    print(f"released {count} event(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
