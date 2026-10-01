"""JSON command line interface for docret.

Commands:
    build  <docs.jsonl> <index.json>          build an index from documents
    query  <index.json> <query>               run a query, print JSON hits
    check  <index.json> <query>               cross-check index vs interpreter
    alias  <index.json> --set name=spec ...   add alias rules (--unset name)
    batch  <index.json> <ops.json>            apply a batch of update ops
    stats  <index.json>                       print index statistics

Document file format (JSONL): one JSON object per line, each with an "id"
and a "doc" object, e.g. {"id": "d1", "doc": {"title": "hello world"}}.
"""
from __future__ import annotations

import argparse
import json
import sys

from .index import AliasError, BatchError, Index
from .interpreter import evaluate_document
from .index import resolve_alias
from .query import QueryError, parse


def _emit(payload) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _load_docs(path: str) -> list[tuple[str, dict]]:
    docs = []
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if "id" not in record or "doc" not in record:
                raise ValueError(f"line {lineno}: need both 'id' and 'doc'")
            docs.append((str(record["id"]), record["doc"]))
    return docs


def cmd_build(args) -> int:
    index = Index()
    docs = _load_docs(args.docs)
    index.apply_batch([
        {"op": "add_doc", "doc": doc_id, "document": doc} for doc_id, doc in docs
    ])
    index.save(args.index)
    _emit({"ok": True, "indexed": len(docs), "index": args.index})
    return 0


def cmd_query(args) -> int:
    index = Index.load(args.index)
    result = index.query(args.query)
    payload = result.to_dict()
    payload["query"] = args.query
    _emit(payload)
    return 0


def cmd_check(args) -> int:
    index = Index.load(args.index)
    result = index.query(args.query)
    ast = parse(args.query)
    aliases = index.aliases
    expected, mismatches = [], []
    for doc_id, doc in index._state.docs.items():
        matched, _ = evaluate_document(
            ast, doc, lambda name: resolve_alias(name, aliases))
        if matched:
            expected.append(doc_id)
        if matched != (doc_id in result.docs):
            mismatches.append(doc_id)
    _emit({
        "ok": not mismatches,
        "query": args.query,
        "index_docs": result.docs,
        "interpreter_docs": sorted(expected),
        "mismatches": sorted(mismatches),
    })
    return 0 if not mismatches else 1


def cmd_alias(args) -> int:
    index = Index.load(args.index)
    for item in args.set or []:
        name, sep, spec = item.partition("=")
        if not sep or not name or not spec:
            raise AliasError(f"bad --set value {item!r}, expected name=spec")
        index.set_alias(name, spec)
    for name in args.unset or []:
        index.remove_alias(name)
    index.save(args.index)
    _emit({"ok": True, "aliases": index.aliases})
    return 0


def cmd_batch(args) -> int:
    index = Index.load(args.index)
    with open(args.ops, encoding="utf-8") as fh:
        ops = json.load(fh)
    if not isinstance(ops, list):
        raise BatchError("ops file must contain a JSON list")
    index.apply_batch(ops)
    index.save(args.index)
    _emit({"ok": True, "applied": len(ops), "stats": index.stats()})
    return 0


def cmd_stats(args) -> int:
    index = Index.load(args.index)
    _emit(index.stats())
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="docret", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="build an index from a JSONL doc file")
    p.add_argument("docs")
    p.add_argument("index")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("query", help="run a query against a saved index")
    p.add_argument("index")
    p.add_argument("query")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("check", help="cross-check index results vs interpreter")
    p.add_argument("index")
    p.add_argument("query")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("alias", help="add or remove alias rules")
    p.add_argument("index")
    p.add_argument("--set", action="append", metavar="NAME=SPEC")
    p.add_argument("--unset", action="append", metavar="NAME")
    p.set_defaults(func=cmd_alias)

    p = sub.add_parser("batch", help="apply a batch of update ops")
    p.add_argument("index")
    p.add_argument("ops")
    p.set_defaults(func=cmd_batch)

    p = sub.add_parser("stats", help="print index statistics")
    p.add_argument("index")
    p.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (QueryError, BatchError, AliasError, ValueError, OSError) as exc:
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
