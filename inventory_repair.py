#!/usr/bin/env python3
"""迟到负库存修复规划 (Late negative-inventory repair planner).

根据仓库事件的业务序号 (seq) 重建库存：入库为正、出库为负。
支持迟到事件插入，返回最早出现负库存的位置，并给出满足以下
词典序目标的补货方案：
  1. 最小化补货总量；
  2. 在总量最小的前提下最小化补货次数；
  3. 在前两者确定后，选择最晚可行的补货位置序列。

最优性（独立前缀下界）证明见 README.md 与 minimal_plan() 返回的
proof 字段。

命令行用法:
    python3 inventory_repair.py [--input FILE] [--pretty]
输入 (JSON, 默认 stdin):
    {
      "events":      [{"id": "e1", "seq": 1, "delta": -3}, ...],
      "late_events": [{"id": "e9", "seq": 2, "delta": 5}, ...]   // 可省略
    }
输出 (JSON, stdout):
    {
      "status": "ok",
      "event_order": [{"position": 0, "id": "e1", "seq": 1, "delta": -3}, ...],
      "earliest_negative_position": 0,          // 无负库存时为 null
      "plan": {
        "total": 5,                              // 最小补货总量
        "count": 1,                              // 最小补货次数
        "operations": [{"position": 0, "before_event_id": "e1",
                        "before_event_seq": 1, "amount": 5}],
        "lower_bound": 5,                        // 独立前缀下界
        "lower_bound_witness_position": 2,       // 取得下界的见证前缀
        "proof": "..."                           // 最优性证据
      }
    }
错误 (重复事件 ID 内容变化等): 输出 {"status": "error", ...} 并以非零码退出。
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass


class DuplicateEventError(ValueError):
    """同一事件 ID 出现内容不一致的记录。"""


class InputFormatError(ValueError):
    """输入记录缺少字段或类型非法。"""


@dataclass(frozen=True)
class Event:
    event_id: str
    seq: int
    delta: int  # 入库为正，出库为负


@dataclass(frozen=True)
class Operation:
    position: int  # 插入到排序后事件列表中该下标的事件之前
    amount: int


@dataclass(frozen=True)
class Plan:
    total: int
    operations: tuple[Operation, ...]
    lower_bound: int
    witness_position: int | None  # 取得前缀下界的前缀下标
    proof: str

    @property
    def count(self) -> int:
        return len(self.operations)


def parse_event(record: object) -> Event:
    if not isinstance(record, dict):
        raise InputFormatError(f"事件记录必须是对象: {record!r}")
    try:
        event_id = record["id"]
        seq = record["seq"]
        delta = record["delta"]
    except KeyError as exc:
        raise InputFormatError(f"事件记录缺少字段 {exc}: {record!r}") from exc
    if not isinstance(event_id, str) or not event_id:
        raise InputFormatError(f"事件 id 必须是非空字符串: {record!r}")
    if not isinstance(seq, int) or isinstance(seq, bool):
        raise InputFormatError(f"事件 seq 必须是整数: {record!r}")
    if not isinstance(delta, int) or isinstance(delta, bool):
        raise InputFormatError(f"事件 delta 必须是整数: {record!r}")
    return Event(event_id=event_id, seq=seq, delta=delta)


def merge_events(base_records: list, late_records: list) -> list[Event]:
    """合并常规事件与迟到事件，按 (seq, id) 排序。

    同一 ID 内容完全一致时幂等去重；内容变化则抛 DuplicateEventError。
    业务序号相同的事件按事件 ID 字典序排列，保证结果确定性。
    """
    seen: dict[str, Event] = {}
    events: list[Event] = []
    for record in list(base_records) + list(late_records):
        event = parse_event(record)
        existing = seen.get(event.event_id)
        if existing is not None:
            if existing != event:
                raise DuplicateEventError(
                    f"事件 ID {event.event_id!r} 内容变化: "
                    f"已有 (seq={existing.seq}, delta={existing.delta}), "
                    f"新记录 (seq={event.seq}, delta={event.delta})"
                )
            continue  # 幂等：内容一致的重复记录直接忽略
        seen[event.event_id] = event
        events.append(event)
    events.sort(key=lambda e: (e.seq, e.event_id))
    return events


def earliest_negative_position(deltas: list[int],
                               operations: list[tuple[int, int]] | None = None
                               ) -> int | None:
    """返回按序重放后最早使库存 < 0 的事件下标；无负库存返回 None。

    operations 为可选的 (position, amount) 补货列表，amount 在处理
    下标为 position 的事件之前计入库存。
    """
    by_position: dict[int, int] = {}
    for position, amount in operations or []:
        if not 0 <= position < len(deltas):
            raise ValueError(f"补货位置越界: {position}")
        by_position[position] = by_position.get(position, 0) + amount
    inventory = 0
    for index, delta in enumerate(deltas):
        inventory += by_position.get(index, 0)
        inventory += delta
        if inventory < 0:
            return index
    return None


def minimal_plan(deltas: list[int]) -> Plan:
    """计算词典序 (总量, 次数, 最晚位置序列) 意义下的最优补货方案。

    独立前缀下界：设 P_j 为前 j+1 个事件的代数和。任何可行方案中，
    插入在第 j 个事件之前（含）的补货总量必须 >= -P_j，否则重放到
    事件 j 后库存为负。该约束对每个前缀独立成立，故
        总补货量 >= max_j(-P_j) = -min_j P_j =: LB。
    可达性：在第 0 个事件前一次性补 LB，则每个前缀和变为 P_j + LB >= 0。
    因此最小总量恰为 LB（min_j P_j >= 0 时 LB = 0，无需补货）。

    次数：LB > 0 时零次补货不可行（存在 P_j < 0），而一次即可达，
    故最少次数为 1。

    最晚位置：单次补货 LB 插入第 i 个事件前可行，当且仅当所有
    j < i 的前缀满足 P_j >= 0（这些前缀不被补货覆盖），而 j >= i 的
    前缀恒有 P_j >= min P = -LB。故可行位置为 0..f，其中 f 是首个
    使 P_f < 0 的下标；最晚可行位置即 f。
    """
    inventory = 0
    min_prefix = 0
    witness: int | None = None
    first_negative: int | None = None
    for index, delta in enumerate(deltas):
        inventory += delta
        if inventory < min_prefix:
            min_prefix = inventory
            witness = index
        if first_negative is None and inventory < 0:
            first_negative = index

    lower_bound = -min_prefix
    if lower_bound == 0:
        proof = (
            "所有前缀和 P_j >= 0，独立前缀下界 LB = max_j(-P_j) = 0，"
            "零补货即可行，方案 (总量 0, 次数 0) 显然最优。"
        )
        return Plan(total=0, operations=(), lower_bound=0,
                    witness_position=None, proof=proof)

    position = first_negative  # LB>0 时首个负前缀必存在
    proof = (
        f"独立前缀下界: 任一可行方案对每个前缀 j 都必须在事件 j 之前插入 "
        f"总量 >= -P_j 的补货；取所有前缀得 总量 >= max_j(-P_j) = "
        f"{lower_bound}（见证前缀为下标 {witness}，P = {min_prefix}）。"
        f"可达性: 在下标 {position} 的事件前一次性补 {lower_bound}，"
        f"每个前缀和变为 P_j + {lower_bound} >= 0，故最小总量 = {lower_bound}。"
        f"次数: 总量 > 0 时 0 次补货不可行（存在负前缀），1 次可达，"
        f"故最少次数 = 1。"
        f"最晚位置: 单次补货在下标 i 前可行当且仅当 i 之前所有前缀 >= 0；"
        f"首个负前缀下标为 {position}，故最晚可行位置 = {position}，"
        f"位置序列 ({position},) 在词典序下最晚。"
    )
    return Plan(total=lower_bound,
                operations=(Operation(position=position, amount=lower_bound),),
                lower_bound=lower_bound,
                witness_position=witness,
                proof=proof)


def build_report(base_records: list, late_records: list) -> dict:
    events = merge_events(base_records, late_records)
    deltas = [event.delta for event in events]
    plan = minimal_plan(deltas)
    return {
        "status": "ok",
        "event_order": [
            {"position": index, "id": event.event_id,
             "seq": event.seq, "delta": event.delta}
            for index, event in enumerate(events)
        ],
        "earliest_negative_position": earliest_negative_position(deltas),
        "plan": {
            "total": plan.total,
            "count": plan.count,
            "operations": [
                {"position": op.position,
                 "before_event_id": events[op.position].event_id,
                 "before_event_seq": events[op.position].seq,
                 "amount": op.amount}
                for op in plan.operations
            ],
            "lower_bound": plan.lower_bound,
            "lower_bound_witness_position": plan.witness_position,
            "proof": plan.proof,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="迟到负库存修复规划：重建库存并给出最优补货方案。")
    parser.add_argument("--input", "-i", metavar="FILE",
                        help="输入 JSON 文件路径，缺省读取 stdin。")
    parser.add_argument("--pretty", action="store_true",
                        help="以缩进格式输出 JSON。")
    args = parser.parse_args(argv)

    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.load(sys.stdin)
    except (OSError, json.JSONDecodeError) as exc:
        json.dump({"status": "error", "error": "invalid_json",
                   "message": str(exc)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 2

    if not isinstance(payload, dict) or not isinstance(
            payload.get("events", []), list) or not isinstance(
            payload.get("late_events", []), list):
        json.dump({"status": "error", "error": "invalid_input",
                   "message": "输入必须是含 events / late_events 数组的对象。"},
                  sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 2

    try:
        report = build_report(payload.get("events", []),
                              payload.get("late_events", []))
    except DuplicateEventError as exc:
        json.dump({"status": "error", "error": "duplicate_event_id",
                   "message": str(exc)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 3
    except InputFormatError as exc:
        json.dump({"status": "error", "error": "invalid_event",
                   "message": str(exc)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 2

    indent = 2 if args.pretty else None
    json.dump(report, sys.stdout, ensure_ascii=False, indent=indent)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
