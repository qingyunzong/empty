"""Canonical JSON helpers shared by the planner, executor and tests."""

import json


def canonical(value):
    """Deterministic JSON encoding used for keys, dedup and ordering."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def row_sort_key(row):
    return canonical(row)


def qualify(table, row):
    """Prefix every attribute with its table name: ``T.a``."""
    return {"{}.{}".format(table, k): v for k, v in row.items()}
