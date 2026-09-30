"""CLI: python -m nakproto run loss_script.json"""

from __future__ import annotations

import json
import sys

from .errors import ConfigError
from .script import load_script
from .sim import run_simulation

USAGE = "usage: python -m nakproto run <loss_script.json>"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2 or argv[0] != "run":
        print(USAGE, file=sys.stderr)
        return 2
    try:
        script = load_script(argv[1])
    except ConfigError as exc:
        print(f"ConfigError: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: cannot read script: {exc}", file=sys.stderr)
        return 2
    result = run_simulation(script)
    print(json.dumps(result.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
