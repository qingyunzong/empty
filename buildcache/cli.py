"""Command line interface: scan / build / clean.

Exit codes: 0 ok, 2 bad manifest, 3 dependency cycle, 7 write failure.
Set BUILDCACHE_CRASH_AT=before_rename|after_rename to simulate a crash.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .core import (
    CycleError,
    ManifestError,
    WriteFailure,
    build,
    clean,
    scan,
)

EXIT_OK = 0
EXIT_MANIFEST = 2
EXIT_CYCLE = 3
EXIT_WRITE = 7


def _crash_hook(point, context):
    if os.environ.get("BUILDCACHE_CRASH_AT") == point:
        print(f"simulated crash at {point} (target {context['target']})",
              file=sys.stderr)
        sys.stderr.flush()
        os._exit(1)  # hard crash: no cleanup, like a real failure


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="buildcache",
        description="Incremental build cache with content fingerprints.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for cmd in ("scan", "build", "clean"):
        p = sub.add_parser(cmd)
        p.add_argument("dir", nargs="?", default=".",
                       help="project directory containing manifest.json")
    args = parser.parse_args(argv)
    root = Path(args.dir).resolve()

    try:
        if args.command == "scan":
            for item in scan(root):
                print(f"{item['target']}\t{item['status']}\t{item['disposition']}")
        elif args.command == "build":
            for line in build(root, crash_hook=_crash_hook):
                print(line)
        elif args.command == "clean":
            for line in clean(root):
                print(line)
    except ManifestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_MANIFEST
    except CycleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CYCLE
    except WriteFailure as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_WRITE
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
