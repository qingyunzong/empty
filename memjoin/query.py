"""Parsing and validation of query.json / data.json."""

import json


class InputError(Exception):
    """Raised for any invalid user input (maps to CLI exit code 2)."""


def _load_json(path, what):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        raise InputError("{} file not found: {}".format(what, path))
    except json.JSONDecodeError as exc:
        raise InputError("invalid JSON in {} file {}: {}".format(what, path, exc))
    except OSError as exc:
        raise InputError("cannot read {} file {}: {}".format(what, path, exc))


def load_query(path):
    """Return (tables, edges) where edges are (lt, lattr, rt, rattr) tuples."""
    obj = _load_json(path, "query")
    if not isinstance(obj, dict):
        raise InputError("query file must contain a JSON object")
    tables = obj.get("tables")
    if not isinstance(tables, list) or not all(isinstance(t, str) for t in tables):
        raise InputError("query 'tables' must be a list of table names")
    if not 2 <= len(tables) <= 4:
        raise InputError("query must involve 2 to 4 tables, got {}".format(len(tables)))
    if len(set(tables)) != len(tables):
        raise InputError("duplicate table names in query")
    joins = obj.get("joins", [])
    if not isinstance(joins, list):
        raise InputError("query 'joins' must be a list")
    edges = []
    for i, j in enumerate(joins):
        if not isinstance(j, dict):
            raise InputError("join #{} must be an object".format(i))
        try:
            if "left_attr" in j or "right_attr" in j:
                lt, la = j["left"], j["left_attr"]
                rt, ra = j["right"], j["right_attr"]
            else:
                lt, la = j["left"].split(".", 1)
                rt, ra = j["right"].split(".", 1)
        except (KeyError, ValueError):
            raise InputError(
                "join #{} must give left/left_attr and right/right_attr "
                "(or dotted 'T.a' names)".format(i))
        for t in (lt, rt):
            if t not in tables:
                raise InputError("join #{} references unknown table {!r}".format(i, t))
        edges.append((lt, la, rt, ra))
    return tables, edges


def load_data(path, tables):
    """Return {table: [row, ...]} with every row a JSON object."""
    obj = _load_json(path, "data")
    if not isinstance(obj, dict):
        raise InputError("data file must contain a JSON object")
    data = {}
    for t in tables:
        rows = obj.get(t)
        if rows is None:
            raise InputError("data file is missing table {!r}".format(t))
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise InputError("data table {!r} must be a list of objects".format(t))
        data[t] = rows
    return data
