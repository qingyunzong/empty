"""JSON command-line interface for the document store.

Usage: python -m jsondoc --dir PATH [--keep-versions] <command> ...
All inputs and outputs are JSON (strict: duplicate keys rejected,
integers and decimals kept lexically distinct).
"""
from __future__ import annotations

import argparse
import sys

from . import strictjson
from .store import DocumentStore


def _build_parser():
    parser = argparse.ArgumentParser(prog="jsondoc")
    parser.add_argument("--dir", required=True, help="store directory")
    parser.add_argument("--keep-versions", action="store_true",
                        help="disable automatic version reclamation")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("put", help="create or replace a document")
    p.add_argument("doc")
    p.add_argument("value", help="JSON document")

    p = sub.add_parser("get", help="print a document")
    p.add_argument("doc")
    p.add_argument("--version", type=int)

    p = sub.add_parser("apply", help="apply a JSON Patch batch")
    p.add_argument("doc")
    p.add_argument("patch", help="JSON array of patch operations")

    p = sub.add_parser("index", help="create a path index")
    p.add_argument("name")
    p.add_argument("pattern", help="JSON pointer, '*' segments are wildcards")

    p = sub.add_parser("query", help="run a query")
    p.add_argument("query", help="query JSON object")
    p.add_argument("--version", type=int)

    sub.add_parser("versions", help="list available versions")
    sub.add_parser("gc", help="reclaim unpinned versions")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    store = DocumentStore(args.dir, auto_gc=not args.keep_versions)
    try:
        if args.cmd == "put":
            out = {"version": store.put(args.doc, strictjson.loads(args.value))}
        elif args.cmd == "get":
            out = store.get(args.doc, version=args.version)
        elif args.cmd == "apply":
            out = {"version": store.apply(args.doc, strictjson.loads(args.patch))}
        elif args.cmd == "index":
            store.create_index(args.name, args.pattern)
            out = {"index": args.name, "pattern": args.pattern}
        elif args.cmd == "query":
            out = {"result": store.query(strictjson.loads(args.query),
                                         version=args.version)}
        elif args.cmd == "versions":
            out = {"latest": store.latest, "versions": store.versions()}
        elif args.cmd == "gc":
            store.gc()
            out = {"versions": store.versions()}
        else:  # pragma: no cover - argparse prevents this
            raise AssertionError(args.cmd)
    except Exception as exc:
        print(strictjson.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}),
              file=sys.stderr)
        return 2
    finally:
        store.close()
    print(strictjson.dumps(out))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
