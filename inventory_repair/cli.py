"""迟到负库存修复规划 —— 命令行入口。

用法示例
--------
# 1) 直接给 JSON（events 必填；late_events 可选，模拟迟到后再插入）
python -m inventory_repair.cli --json '{
  "events": [
    {"id": "e1", "seq": 1, "delta": 2},
    {"id": "e3", "seq": 3, "delta": -4}
  ],
  "late_events": [
    {"id": "e2", "seq": 2, "delta": -3}
  ]
}'

# 2) 从文件读取（内容结构同上）
python -m inventory_repair.cli --file input.json

# 3) 从标准输入读取
cat input.json | python -m inventory_repair.cli

输入 JSON 结构
--------------
{
  "events":      [ {"id": str, "seq": int, "delta": int}, ... ],
  "late_events": [ {"id": str, "seq": int, "delta": int}, ... ]   // 可选
}

退出码
------
0  成功
2  输入 JSON / 事件字段非法
3  重复事件 ID 内容发生变化（DuplicateEventConflict）
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .planner import (
    DuplicateEventConflict,
    InvalidEventError,
    InventoryPlanner,
)


def _load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.json is not None:
        source = args.json
    elif args.file:
        with open(args.file, "r", encoding="utf-8") as handle:
            source = handle.read()
    else:
        source = sys.stdin.read()

    if not source.strip():
        raise InvalidEventError("输入为空：请通过 --json/--file/标准输入提供 JSON")

    try:
        payload = json.loads(source)
    except json.JSONDecodeError as exc:
        raise InvalidEventError(f"输入不是合法 JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise InvalidEventError("顶层必须是对象，包含 events 数组")
    return payload


def run(payload: dict[str, Any]) -> dict[str, Any]:
    events = payload.get("events")
    late_events = payload.get("late_events", [])
    if not isinstance(events, list):
        raise InvalidEventError("events 必须是数组")
    if not isinstance(late_events, list):
        raise InvalidEventError("late_events 必须是数组")

    planner = InventoryPlanner()
    for raw in events:
        planner.add_event(raw)
    for raw in late_events:
        planner.add_event(raw)
    return planner.analyze()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m inventory_repair.cli",
        description="根据业务序号重建库存并给出最少补货方案。",
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--json", help="直接传入输入 JSON 字符串")
    source.add_argument("--file", help="从文件读取输入 JSON")
    parser.add_argument(
        "--pretty", action="store_true", help="以缩进格式输出 JSON（默认紧凑）"
    )
    args = parser.parse_args(argv)

    try:
        payload = _load_payload(args)
        result = run(payload)
    except DuplicateEventConflict as exc:
        print(json.dumps({"error": "duplicate_event_conflict", "message": str(exc)},
                         ensure_ascii=False), file=sys.stderr)
        return 3
    except InvalidEventError as exc:
        print(json.dumps({"error": "invalid_input", "message": str(exc)},
                         ensure_ascii=False), file=sys.stderr)
        return 2

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
