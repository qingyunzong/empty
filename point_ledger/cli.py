"""命令行入口：

  python -m point_ledger run events.json            # JSON 数组
  python -m point_ledger run events.jsonl           # JSON Lines
  cat events.jsonl | python -m point_ledger run -   # 标准输入
  python -m point_ledger demo                       # 内置验收样例
  python -m point_ledger report events.jsonl --now 7

退出码：0 成功；1 存在非法事件（超退、未知引用、余额不足等）。
重复退款属于幂等命中，记 warning，退出码仍为 0。
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .ledger import Ledger, LedgerError

ACCEPTANCE_EVENTS = [
    {"op": "earn", "batch_id": "b1", "amount": 10, "expiry": 5, "time": 0},
    {"op": "consume", "consumption_id": "c1", "amount": 6, "time": 4},
    {"op": "refund", "consumption_id": "c1", "amount": 6, "time": 6,
     "refund_id": "r1"},
]


def _load_events(path: str) -> list[dict[str, Any]]:
    if path == "-":
        raw = sys.stdin.read()
    else:
        with open(path, "r", encoding="utf-8") as handle:
            raw = handle.read()
    raw = raw.strip()
    if not raw:
        return []
    if raw[0] == "[":
        data = json.loads(raw)
        if not isinstance(data, list):
            raise LedgerError("JSON 输入必须是事件数组")
        return data
    events = []
    for line_no, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        event = json.loads(line)
        if not isinstance(event, dict):
            raise LedgerError(f"第 {line_no} 行不是 JSON 对象")
        events.append(event)
    return events


def _run(events: list[dict[str, Any]], now: int | None) -> tuple[dict, list[str]]:
    ledger = Ledger()
    errors: list[str] = []
    for index, event in enumerate(events):
        try:
            ledger.apply_event(event)
        except LedgerError as exc:
            errors.append(f"事件 #{index} ({event}): {exc}")
    return ledger.report(now), errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="point_ledger",
        description="跨批次抵扣有效期账本（合成数据演示）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="处理事件文件并输出报表")
    run_p.add_argument("path", help="事件文件路径，- 表示标准输入")
    run_p.add_argument("--now", type=int, default=None,
                       help="报表时点，默认取所有事件中的最大时间")

    demo_p = sub.add_parser("demo", help="运行内置验收样例（10分/到期5/4消费6/6退6）")
    demo_p.add_argument("--now", type=int, default=None,
                        help="报表时点，默认取所有事件中的最大时间")

    args = parser.parse_args(argv)

    if args.command == "demo":
        events = ACCEPTANCE_EVENTS
        print("内置验收样例事件（合成数据）：", file=sys.stderr)
        for event in events:
            print(f"  {json.dumps(event, ensure_ascii=False)}", file=sys.stderr)
    else:
        try:
            events = _load_events(args.path)
        except (OSError, json.JSONDecodeError, LedgerError) as exc:
            print(f"输入错误: {exc}", file=sys.stderr)
            return 1

    report, errors = _run(events, args.now)

    if args.command == "demo":
        print(json.dumps(report, ensure_ascii=False, indent=2))
        totals = report["totals"]
        print(
            f"\n验收断言: available={totals['available']}（期望 0），"
            f"refunded_expired={totals['refunded_expired']}（期望 6），"
            f"conservation_ok={report['conservation']['ok']}",
            file=sys.stderr,
        )
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))

    if errors:
        print("\n非法事件：", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
