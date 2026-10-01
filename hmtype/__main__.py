"""CLI: python -m hmtype <file.mini>

Prints one line per top-level let: "name : type" on success, or a JSON
error object on failure. Exit code 0 when every let type-checks, 4 when
any error was reported, 2 for usage/IO errors.
"""

from __future__ import annotations

import json
import sys

from .errors import HMError
from .infer import infer_program
from .syntax import parse_program


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m hmtype <file.mini>", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        print(f"error: cannot read {path}: {e}", file=sys.stderr)
        return 2
    try:
        lets = parse_program(src)
    except HMError as e:
        print(json.dumps(e.to_json(), ensure_ascii=False))
        return 4
    exit_code = 0
    for name, ty, err in infer_program(lets):
        if err is not None:
            exit_code = 4
            payload = {"let": name}
            payload.update(err.to_json())
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print(f"{name} : {ty}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
