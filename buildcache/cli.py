"""Command line interface: scan / build / clean."""

from __future__ import annotations

import argparse
import sys

from . import core

EXIT_OK = 0
EXIT_MANIFEST_ERROR = 2
EXIT_CYCLE_ERROR = 3
EXIT_WRITE_ERROR = 7
EXIT_CRASH = 75  # simulated crash fault injection (testing only)


def _cmd_scan(project_dir: str) -> int:
    report = core.scan(project_dir)
    for name, info in report.items():
        fingerprint = info["fingerprint"]
        short = fingerprint[:12] if fingerprint else "-"
        line = f"{name}: {info['status']} fingerprint={short}"
        if info["missing"]:
            line += f" missing={','.join(info['missing'])}"
        print(line)
    return EXIT_OK


def _cmd_build(project_dir: str) -> int:
    results = core.build(project_dir)
    for name, status in results.items():
        print(f"{name}: {status}")
    return EXIT_OK


def _cmd_clean(project_dir: str) -> int:
    removed = core.clean(project_dir)
    for path in removed:
        print(f"removed {path}")
    return EXIT_OK


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="buildcache",
        description="Content-addressed incremental build cache.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("scan", "build", "clean"):
        sub_parser = sub.add_parser(command)
        sub_parser.add_argument("dir", help="project directory containing manifest.json")
    args = parser.parse_args(argv)

    handler = {"scan": _cmd_scan, "build": _cmd_build, "clean": _cmd_clean}[args.command]
    try:
        return handler(args.dir)
    except core.ManifestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_MANIFEST_ERROR
    except core.CycleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CYCLE_ERROR
    except core.WriteError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_WRITE_ERROR
    except core.CrashFault as exc:
        print(f"crash: {exc}", file=sys.stderr)
        return EXIT_CRASH


if __name__ == "__main__":
    sys.exit(main())
