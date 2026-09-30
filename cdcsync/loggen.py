"""Helpers to build hash-chained CDC logs (used by tests and tools)."""
from __future__ import annotations

import json

from .core import GENESIS, record_hash


def make_record(src, seq, op, key, value=None, ts=0.0, prev_hash=GENESIS):
    """Build one chained record; returns (record_dict, its_hash)."""
    payload = {"src": src, "seq": seq, "op": op, "key": key,
               "value": value, "ts": ts}
    digest = record_hash(payload, prev_hash)
    rec = dict(payload)
    rec["hash"] = digest
    return rec, digest


def chain_records(payloads, prev_hash=GENESIS):
    """Attach chain hashes to a sequence of payload dicts."""
    records = []
    for payload in payloads:
        digest = record_hash(payload, prev_hash)
        rec = dict(payload)
        rec["hash"] = digest
        records.append(rec)
        prev_hash = digest
    return records


def write_log(path, payloads, prev_hash=GENESIS):
    """Write payloads as a hash-chained JSONL log; returns the records."""
    records = chain_records(payloads, prev_hash)
    with open(path, "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return records
