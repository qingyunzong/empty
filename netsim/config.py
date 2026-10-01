"""Configuration loading and validation.

Any validation failure raises :class:`ConfigError`; the CLI maps it to
exit code 2.
"""
from __future__ import annotations

import json
import numbers

MAX_NODES = 8
_RULE_TYPES = {"drop", "dup", "delay", "partition", "clock"}


class ConfigError(Exception):
    pass


def _load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON in {path}: {exc}") from exc


def _is_num(value) -> bool:
    return isinstance(value, numbers.Real) and not isinstance(value, bool)


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ConfigError(msg)


def validate_topo(topo) -> dict:
    _require(isinstance(topo, dict), "topology must be a JSON object")
    nodes = topo.get("nodes")
    _require(isinstance(nodes, list) and 1 <= len(nodes) <= MAX_NODES,
             f"topology needs 1..{MAX_NODES} nodes")
    ids = set()
    for node in nodes:
        _require(isinstance(node, dict), "each node must be an object")
        nid = node.get("id")
        _require(isinstance(nid, str) and nid, "node id must be a non-empty string")
        _require(nid not in ids, f"duplicate node id {nid!r}")
        ids.add(nid)
        offset = node.get("clock_offset", 0)
        _require(_is_num(offset), f"node {nid}: clock_offset must be a number")
        node.setdefault("clock_offset", 0)
        timeouts = node.get("timeouts", [])
        _require(isinstance(timeouts, list), f"node {nid}: timeouts must be a list")
        for tmo in timeouts:
            _require(isinstance(tmo, dict), f"node {nid}: timeout must be an object")
            _require(isinstance(tmo.get("id"), str) and tmo["id"],
                     f"node {nid}: timeout id must be a non-empty string")
            _require(_is_num(tmo.get("at_local")),
                     f"node {nid}: timeout at_local must be a number")
        node.setdefault("timeouts", [])

    links = topo.get("links", [])
    _require(isinstance(links, list), "links must be a list")
    seen_links = set()
    for link in links:
        _require(isinstance(link, dict), "each link must be an object")
        src, dst = link.get("src"), link.get("dst")
        _require(src in ids and dst in ids,
                 f"link references unknown node: {src!r}->{dst!r}")
        _require(src != dst, f"self link not allowed: {src!r}")
        _require((src, dst) not in seen_links, f"duplicate link {src!r}->{dst!r}")
        seen_links.add((src, dst))
        _require(_is_num(link.get("delay")) and link["delay"] >= 0,
                 f"link {src!r}->{dst!r}: delay must be a number >= 0")
        jitter = link.get("jitter", 0)
        _require(isinstance(jitter, int) and not isinstance(jitter, bool) and jitter >= 0,
                 f"link {src!r}->{dst!r}: jitter must be an integer >= 0")
        link.setdefault("jitter", 0)
    topo.setdefault("links", [])

    workload = topo.get("workload", [])
    _require(isinstance(workload, list), "workload must be a list")
    for i, item in enumerate(workload):
        _require(isinstance(item, dict), f"workload[{i}] must be an object")
        _require(_is_num(item.get("time")) and item["time"] >= 0,
                 f"workload[{i}]: time must be a number >= 0")
        _require(item.get("src") in ids and item.get("dst") in ids,
                 f"workload[{i}] references unknown node")
        _require(item["src"] != item["dst"], f"workload[{i}]: src == dst")
        _require((item["src"], item["dst"]) in seen_links,
                 f"workload[{i}]: no link {item['src']!r}->{item['dst']!r}")
        if "app_id" in item:
            _require(isinstance(item["app_id"], str) and item["app_id"],
                     f"workload[{i}]: app_id must be a non-empty string")
        if "payload" in item:
            _require(isinstance(item["payload"], str),
                     f"workload[{i}]: payload must be a string")
    topo.setdefault("workload", [])
    return topo


def _validate_window(rule: dict, ctx: str, require: bool) -> None:
    start, end = rule.get("start"), rule.get("end")
    if require:
        _require(_is_num(start) and _is_num(end) and end > start,
                 f"{ctx}: numeric start < end required")
    else:
        if start is not None:
            _require(_is_num(start) and start >= 0, f"{ctx}: start must be >= 0")
        if end is not None:
            _require(_is_num(end), f"{ctx}: end must be a number")
        if start is not None and end is not None:
            _require(end >= start, f"{ctx}: end must be >= start")


def validate_faults(faults, topo: dict) -> dict:
    _require(isinstance(faults, dict), "faults must be a JSON object")
    rules = faults.get("rules", [])
    _require(isinstance(rules, list), "faults.rules must be a list")
    ids = {n["id"] for n in topo["nodes"]}
    for i, rule in enumerate(rules):
        ctx = f"faults.rules[{i}]"
        _require(isinstance(rule, dict), f"{ctx} must be an object")
        rtype = rule.get("type")
        _require(rtype in _RULE_TYPES, f"{ctx}: unknown rule type {rtype!r}")
        if rtype in ("drop", "dup", "delay"):
            for key in ("src", "dst"):
                if key in rule:
                    _require(rule[key] in ids, f"{ctx}: unknown node {rule[key]!r}")
            _validate_window(rule, ctx, require=False)
        if rtype in ("drop", "dup"):
            prob = rule.get("prob", 1.0)
            _require(_is_num(prob) and 0.0 <= prob <= 1.0,
                     f"{ctx}: prob must be in [0, 1]")
            rule.setdefault("prob", prob)
        elif rtype == "delay":
            _require(_is_num(rule.get("extra")) and rule["extra"] >= 0,
                     f"{ctx}: extra must be a number >= 0")
        elif rtype == "partition":
            edges = rule.get("edges")
            _require(isinstance(edges, list) and edges,
                     f"{ctx}: edges must be a non-empty list")
            for edge in edges:
                _require(isinstance(edge, list) and len(edge) == 2,
                         f"{ctx}: each edge must be a [src, dst] pair")
                _require(edge[0] in ids and edge[1] in ids,
                         f"{ctx}: edge references unknown node")
                _require(edge[0] != edge[1], f"{ctx}: self edge not allowed")
            _validate_window(rule, ctx, require=True)
        elif rtype == "clock":
            _require(rule.get("node") in ids, f"{ctx}: unknown node {rule.get('node')!r}")
            _require(_is_num(rule.get("offset")), f"{ctx}: offset must be a number")
            _require(_is_num(rule.get("start")) and rule["start"] >= 0,
                     f"{ctx}: start must be a number >= 0")
    faults.setdefault("rules", [])
    return faults


def load_topo(path: str) -> dict:
    return validate_topo(_load_json(path))


def load_faults(path: str, topo: dict) -> dict:
    return validate_faults(_load_json(path), topo)
