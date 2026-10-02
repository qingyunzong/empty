"""JSON-lines CLI for the reassembly gateway.

Reads one JSON command per line on stdin, writes one JSON result per
line on stdout.

Commands:
  {"op":"submit","transfer_id":"t","epoch":0,"frag_id":"f1","offset":0,
   "data_b64":"...","total_length":10,"total_hash":"<sha256hex>","now":0}
  {"op":"retract","transfer_id":"t","epoch":0,"frag_id":"f1"}
  {"op":"finalize","transfer_id":"t","epoch":0}
  {"op":"status","transfer_id":"t","epoch":0}
  {"op":"retransmit","transfer_id":"t","epoch":0,"mtu":512}
  {"op":"tick","now":100.0}
  {"op":"recover"}
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from typing import IO

from .fragments import Fragment
from .gateway import Gateway, GatewayConfig


def _handle(gateway: Gateway, cmd: dict) -> dict:
    op = cmd.get("op")
    if op == "submit":
        frag = Fragment(
            transfer_id=cmd["transfer_id"],
            epoch=int(cmd.get("epoch", 0)),
            frag_id=cmd["frag_id"],
            offset=int(cmd["offset"]),
            data=base64.b64decode(cmd.get("data_b64", "")),
            total_length=cmd.get("total_length"),
            total_hash=cmd.get("total_hash"),
        )
        return gateway.submit(frag, now=cmd.get("now")).to_dict()
    if op == "retract":
        ok = gateway.retract(
            cmd["transfer_id"],
            int(cmd.get("epoch", 0)),
            cmd["frag_id"],
            now=cmd.get("now"),
        )
        return {"status": "retracted" if ok else "not_found"}
    if op == "finalize":
        return gateway.finalize(
            cmd["transfer_id"], int(cmd.get("epoch", 0)), now=cmd.get("now")
        )
    if op == "status":
        return gateway.status(cmd["transfer_id"], int(cmd.get("epoch", 0)))
    if op == "retransmit":
        plan = gateway.retransmit_plan(
            cmd["transfer_id"], int(cmd.get("epoch", 0)), int(cmd["mtu"])
        )
        return {"plan": [{"offset": o, "length": n} for o, n in plan]}
    if op == "tick":
        reclaimed = gateway.advance_time(float(cmd["now"]))
        return {
            "reclaimed": [
                {"transfer_id": tid, "epoch": ep} for tid, ep in reclaimed
            ]
        }
    if op == "recover":
        return gateway.recover()
    return {"status": "error", "reason": f"unknown op: {op!r}"}


def run(gateway: Gateway, stdin: IO[str], stdout: IO[str]) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            result = _handle(gateway, cmd)
        except Exception as exc:  # keep the stream alive on bad input
            result = {"status": "error", "reason": str(exc)}
        stdout.write(json.dumps(result) + "\n")
        stdout.flush()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="reassembler")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--memory-threshold", type=int, default=1 << 20)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--out-dir", default=None)
    args = parser.parse_args(argv)
    gateway = Gateway(
        GatewayConfig(
            workdir=args.workdir,
            memory_threshold=args.memory_threshold,
            timeout=args.timeout,
            out_dir=args.out_dir,
        )
    )
    gateway.recover()
    run(gateway, sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
