"""CLI: python -m slot.cli [spec.json]

从文件或 stdin 读取 JSON 规格:
    {"busy": [[[bs, be], ...], ...], "d": 30, "s": 0, "e": 480,
     "prefer": [[ps, pe], ...]}   # prefer 可选

stdout 输出 JSON 结果; 非法输入输出 {"code": "BAD_SLOT", ...} 到 stderr 并以 2 退出。
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import BadSlotError, find_slots


def _fail(message: str) -> int:
    print(json.dumps({"code": BadSlotError.code, "message": message},
                     ensure_ascii=False), file=sys.stderr)
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m slot.cli",
        description="查找多人公共空闲槽 (stdin 或文件传入 JSON 规格)。",
    )
    parser.add_argument("spec", nargs="?", help="JSON 规格文件路径, 缺省读 stdin")
    parser.add_argument("--pretty", action="store_true", help="美化输出 JSON")
    args = parser.parse_args(argv)

    try:
        raw = open(args.spec, encoding="utf-8").read() if args.spec else sys.stdin.read()
        spec = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(f"invalid JSON input: {exc}")

    try:
        result = find_slots(
            busy=spec["busy"],
            d=spec["d"],
            s=spec["s"],
            e=spec["e"],
            prefer=spec.get("prefer"),
        )
    except BadSlotError as exc:
        return _fail(exc.message)
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(f"bad spec: {exc!r}")

    print(json.dumps(result, ensure_ascii=False,
                     indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main())
