"""JSON command-line interface for docindex.

Usage examples::

    python3.11 -m docindex.cli --store db.json add --doc-id d1 --doc '{"title": "hello world"}'
    python3.11 -m docindex.cli --store db.json query --q 'title:"hello world"'
    python3.11 -m docindex.cli --store db.json batch --ops '[{"op": "move_field", ...}]'
    python3.11 -m docindex.cli --store db.json alias --rules '{"headline": ["title"]}'
    python3.11 -m docindex.cli --store db.json snapshot --name s1
    python3.11 -m docindex.cli --store db.json stats
    python3.11 -m docindex.cli run --script script.json [--store db.json]

Every command prints a JSON object to stdout.  ``run`` executes a JSON list
of command objects and prints a JSON array of per-command results.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .errors import DocIndexError
from .index import Index


def _load_index(store):
    if store and os.path.exists(store):
        return Index.restore(store)
    return Index()


def _read_json_arg(value, file_value):
    if file_value:
        with open(file_value, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.loads(value)


def _execute(index: Index, command: dict):
    """Execute one command dict against *index*; returns a JSON-able result."""
    cmd = command.get("cmd")
    if cmd == "add":
        index.add_doc(command["doc_id"], command["doc"])
        return {"added": command["doc_id"]}
    if cmd == "delete":
        index.delete_doc(command["doc_id"])
        return {"deleted": command["doc_id"]}
    if cmd == "query":
        return index.search(command["q"], snapshot=command.get("snapshot"))
    if cmd == "batch":
        return index.apply_batch(command["ops"])
    if cmd == "alias":
        index.set_aliases(command["rules"])
        return {"alias_version": index.aliases.version}
    if cmd == "snapshot":
        index.create_snapshot(command["name"])
        return {"snapshot": command["name"]}
    if cmd == "stats":
        return index.stats()
    raise DocIndexError(f"unknown command: {cmd!r}")


def _run_script(script_path, store):
    with open(script_path, "r", encoding="utf-8") as fh:
        commands = json.load(fh)
    if not isinstance(commands, list):
        raise DocIndexError("script must be a JSON list of commands")
    index = _load_index(store)
    results = []
    ok = True
    for i, command in enumerate(commands):
        try:
            results.append({"ok": True, "result": _execute(index, command)})
        except Exception as exc:
            results.append({"ok": False, "error": f"{type(exc).__name__}: {exc}", "command_index": i})
            ok = False
            break
    if store:
        index.save(store)
    return results, ok


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="docindex", description="positional multi-field document index")
    parser.add_argument("--store", help="path to a JSON store file (created if missing)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="add or replace a document")
    p_add.add_argument("--doc-id", required=True)
    p_add.add_argument("--doc", help="document as a JSON string")
    p_add.add_argument("--doc-file", help="read the document JSON from a file")

    p_del = sub.add_parser("delete", help="delete a document")
    p_del.add_argument("--doc-id", required=True)

    p_query = sub.add_parser("query", help="run a query")
    p_query.add_argument("--q", required=True)
    p_query.add_argument("--snapshot")

    p_batch = sub.add_parser("batch", help="apply a batch of mutations atomically")
    p_batch.add_argument("--ops", help="operations as a JSON string")
    p_batch.add_argument("--ops-file", help="read operations JSON from a file")

    p_alias = sub.add_parser("alias", help="replace field alias rules")
    p_alias.add_argument("--rules", help="alias rules as a JSON string")
    p_alias.add_argument("--rules-file", help="read alias rules JSON from a file")

    p_snap = sub.add_parser("snapshot", help="create a named snapshot")
    p_snap.add_argument("--name", required=True)

    sub.add_parser("stats", help="print index statistics")

    p_run = sub.add_parser("run", help="run a JSON script of commands")
    p_run.add_argument("--script", required=True)

    args = parser.parse_args(argv)
    try:
        if args.cmd == "run":
            results, ok = _run_script(args.script, args.store)
            print(json.dumps(results, ensure_ascii=False, indent=1))
            return 0 if ok else 1

        index = _load_index(args.store)
        if args.cmd == "add":
            doc = _read_json_arg(args.doc, args.doc_file)
            result = _execute(index, {"cmd": "add", "doc_id": args.doc_id, "doc": doc})
        elif args.cmd == "delete":
            result = _execute(index, {"cmd": "delete", "doc_id": args.doc_id})
        elif args.cmd == "query":
            result = _execute(index, {"cmd": "query", "q": args.q, "snapshot": args.snapshot})
        elif args.cmd == "batch":
            ops = _read_json_arg(args.ops, args.ops_file)
            result = _execute(index, {"cmd": "batch", "ops": ops})
        elif args.cmd == "alias":
            rules = _read_json_arg(args.rules, args.rules_file)
            result = _execute(index, {"cmd": "alias", "rules": rules})
        elif args.cmd == "snapshot":
            result = _execute(index, {"cmd": "snapshot", "name": args.name})
        elif args.cmd == "stats":
            result = _execute(index, {"cmd": "stats"})
        else:  # pragma: no cover
            parser.error(f"unknown command {args.cmd}")
        if args.store and args.cmd in ("add", "delete", "batch", "alias", "snapshot"):
            index.save(args.store)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, indent=1))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
