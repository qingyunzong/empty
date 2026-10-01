"""Configuration loading and validation for netsim.

All validation failures raise ConfigError; the CLI maps that to exit code 2.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

MAX_NODES = 8

# Fault rules are always applied in this fixed phase order, regardless of
# the key order used inside the faults JSON document.
PHASES = ("drop", "dup", "delay", "clock_apply")


class ConfigError(Exception):
    """Raised when a topology or faults document is invalid."""


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _load_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON in {path}: {exc}") from exc


def _require_obj(value: Any, what: str) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(f"{what} must be a JSON object")
    return value


def _require_list(value: Any, what: str) -> list:
    if not isinstance(value, list):
        raise ConfigError(f"{what} must be a JSON array")
    return value


@dataclass
class Link:
    latency: float = 1.0
    jitter: float = 0.0


@dataclass
class Config:
    nodes: list[str]
    links: dict[tuple[str, str], Link]
    clock_offsets: dict[str, float]
    timeout_intervals: dict[str, float]
    workload: list[dict]


@dataclass
class Faults:
    drop: list[dict] = field(default_factory=list)
    dup: list[dict] = field(default_factory=list)
    delay: list[dict] = field(default_factory=list)
    clock_apply: list[dict] = field(default_factory=list)
    partitions: list[dict] = field(default_factory=list)


def load_topo(path: str) -> Config:
    doc = _require_obj(_load_json(path), "topology")
    unknown = set(doc) - {"nodes", "links", "clock_offsets", "workload"}
    if unknown:
        raise ConfigError(f"topology: unknown keys: {sorted(unknown)}")

    raw_nodes = _require_list(doc.get("nodes"), "topology.nodes")
    nodes: list[str] = []
    timeout_intervals: dict[str, float] = {}
    for entry in raw_nodes:
        if isinstance(entry, str):
            node_id = entry
            interval = None
        elif isinstance(entry, dict):
            node_id = entry.get("id")
            interval = entry.get("timeout_interval")
        else:
            raise ConfigError("topology.nodes entries must be strings or objects")
        if not isinstance(node_id, str) or not node_id:
            raise ConfigError("topology.nodes entries need a non-empty string id")
        if node_id in nodes:
            raise ConfigError(f"duplicate node id: {node_id}")
        if interval is not None:
            if not _is_num(interval) or interval <= 0:
                raise ConfigError(f"node {node_id}: timeout_interval must be > 0")
            timeout_intervals[node_id] = float(interval)
        nodes.append(node_id)
    if not 1 <= len(nodes) <= MAX_NODES:
        raise ConfigError(f"topology must declare 1..{MAX_NODES} nodes")

    node_set = set(nodes)

    links: dict[tuple[str, str], Link] = {}
    for entry in _require_list(doc.get("links", []), "topology.links"):
        obj = _require_obj(entry, "link")
        src, dst = obj.get("src"), obj.get("dst")
        if src not in node_set or dst not in node_set:
            raise ConfigError(f"link references unknown node: {src!r}->{dst!r}")
        if src == dst:
            raise ConfigError(f"self link not allowed: {src!r}")
        latency = obj.get("latency", 1.0)
        jitter = obj.get("jitter", 0.0)
        if not _is_num(latency) or latency < 0:
            raise ConfigError("link latency must be a number >= 0")
        if not _is_num(jitter) or jitter < 0:
            raise ConfigError("link jitter must be a number >= 0")
        links[(src, dst)] = Link(float(latency), float(jitter))

    clock_offsets: dict[str, float] = {}
    raw_offsets = _require_obj(doc.get("clock_offsets", {}), "topology.clock_offsets")
    for node_id, offset in raw_offsets.items():
        if node_id not in node_set:
            raise ConfigError(f"clock_offsets references unknown node: {node_id!r}")
        if not _is_num(offset):
            raise ConfigError(f"clock offset for {node_id} must be a number")
        clock_offsets[node_id] = float(offset)

    workload: list[dict] = []
    for entry in _require_list(doc.get("workload", []), "topology.workload"):
        obj = _require_obj(entry, "workload entry")
        src, dst = obj.get("src"), obj.get("dst")
        if src not in node_set or dst not in node_set:
            raise ConfigError(f"workload references unknown node: {src!r}->{dst!r}")
        when = obj.get("time")
        if not _is_num(when) or when < 0:
            raise ConfigError("workload entry time must be a number >= 0")
        app_id = obj.get("app_id")
        if not isinstance(app_id, str) or not app_id:
            raise ConfigError("workload entry needs a non-empty string app_id")
        workload.append(
            {
                "time": float(when),
                "src": src,
                "dst": dst,
                "app_id": app_id,
                "payload": obj.get("payload", ""),
            }
        )

    return Config(nodes, links, clock_offsets, timeout_intervals, workload)


def _endpoint(value: Any) -> str:
    if value != "*" and not isinstance(value, str):
        raise ConfigError("endpoint must be a node id or '*'")
    return value


def load_faults(path: str, config: Config) -> Faults:
    doc = _require_obj(_load_json(path), "faults")
    unknown = set(doc) - set(PHASES) - {"partitions"}
    if unknown:
        raise ConfigError(f"faults: unknown keys: {sorted(unknown)}")
    node_set = set(config.nodes)
    faults = Faults()

    def check_endpoint(value: Any) -> str:
        endpoint = _endpoint(value)
        if endpoint != "*" and endpoint not in node_set:
            raise ConfigError(f"fault rule references unknown node: {endpoint!r}")
        return endpoint

    for entry in _require_list(doc.get("drop", []), "faults.drop"):
        obj = _require_obj(entry, "drop rule")
        rate = obj.get("rate")
        if not _is_num(rate) or not 0.0 <= rate <= 1.0:
            raise ConfigError("drop rule rate must be in [0, 1]")
        faults.drop.append(
            {"src": check_endpoint(obj.get("src")), "dst": check_endpoint(obj.get("dst")), "rate": float(rate)}
        )

    for entry in _require_list(doc.get("dup", []), "faults.dup"):
        obj = _require_obj(entry, "dup rule")
        rate = obj.get("rate")
        copies = obj.get("copies", 1)
        if not _is_num(rate) or not 0.0 <= rate <= 1.0:
            raise ConfigError("dup rule rate must be in [0, 1]")
        if not isinstance(copies, int) or isinstance(copies, bool) or copies < 1:
            raise ConfigError("dup rule copies must be an integer >= 1")
        faults.dup.append(
            {
                "src": check_endpoint(obj.get("src")),
                "dst": check_endpoint(obj.get("dst")),
                "rate": float(rate),
                "copies": copies,
            }
        )

    for entry in _require_list(doc.get("delay", []), "faults.delay"):
        obj = _require_obj(entry, "delay rule")
        extra = obj.get("extra")
        if not _is_num(extra) or extra < 0:
            raise ConfigError("delay rule extra must be a number >= 0")
        faults.delay.append(
            {"src": check_endpoint(obj.get("src")), "dst": check_endpoint(obj.get("dst")), "extra": float(extra)}
        )

    for entry in _require_list(doc.get("clock_apply", []), "faults.clock_apply"):
        obj = _require_obj(entry, "clock_apply rule")
        node = obj.get("node")
        if node not in node_set:
            raise ConfigError(f"clock_apply references unknown node: {node!r}")
        offset = obj.get("offset")
        at = obj.get("at")
        if not _is_num(offset):
            raise ConfigError("clock_apply offset must be a number")
        if not _is_num(at) or at < 0:
            raise ConfigError("clock_apply at must be a number >= 0")
        faults.clock_apply.append({"node": node, "offset": float(offset), "at": float(at)})

    for entry in _require_list(doc.get("partitions", []), "faults.partitions"):
        obj = _require_obj(entry, "partition rule")
        a, b = obj.get("a"), obj.get("b")
        if a not in node_set or b not in node_set:
            raise ConfigError(f"partition references unknown node: {a!r}/{b!r}")
        if a == b:
            raise ConfigError("partition endpoints must differ")
        start, end = obj.get("start"), obj.get("end")
        if not _is_num(start) or start < 0 or not _is_num(end) or end <= start:
            raise ConfigError("partition needs 0 <= start < end")
        faults.partitions.append({"a": a, "b": b, "start": float(start), "end": float(end)})

    return faults
