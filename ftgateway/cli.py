"""JSON-lines CLI: one JSON command per line on stdin, one JSON reply per line.

Commands:
  add        {cmd, transfer_id, epoch, fragment_id, offset, data_b64,
              [total_length], [total_hash], [content_hash], [now]}
  withdraw   {cmd, transfer_id, epoch, fragment_id, [now]}
  gaps       {cmd, transfer_id, epoch}
  retransmit {cmd, transfer_id, epoch, mtu}
  new_epoch  {cmd, transfer_id}
  tick       {cmd, now}
  commit     {cmd, transfer_id, epoch}
  status     {cmd}
"""
from __future__ import annotations

import argparse
import base64
import json
import sys

from .fragments import Fragment
from .gateway import Gateway
from .reassembler import BadFragmentError, ConflictError, LengthChangeError


def _reply(ok: bool, **fields) -> str:
    return json.dumps({"ok": ok, **fields})


def handle(gw: Gateway, cmd: dict) -> dict:
    op = cmd.get("cmd")
    if op == "add":
        frag = Fragment(
            transfer_id=cmd["transfer_id"],
            epoch=cmd.get("epoch", 0),
            fragment_id=cmd["fragment_id"],
            offset=cmd["offset"],
            data=base64.b64decode(cmd.get("data_b64", "")),
            total_length=cmd.get("total_length"),
            total_hash=cmd.get("total_hash"),
            content_hash=cmd.get("content_hash"),
        )
        return gw.add_fragment(frag, now=cmd.get("now", 0.0))
    if op == "withdraw":
        return gw.withdraw(cmd["transfer_id"], cmd.get("epoch", 0),
                           cmd["fragment_id"], now=cmd.get("now", 0.0))
    if op == "gaps":
        return {"gaps": gw.gaps(cmd["transfer_id"], cmd.get("epoch", 0))}
    if op == "retransmit":
        return {"plan": gw.retransmit_plan(cmd["transfer_id"],
                                           cmd.get("epoch", 0), cmd["mtu"])}
    if op == "new_epoch":
        return {"epoch": gw.start_new_epoch(cmd["transfer_id"])}
    if op == "tick":
        return {"reclaimed": gw.tick(cmd["now"])}
    if op == "commit":
        return {"committed": gw.commit(cmd["transfer_id"],
                                       cmd.get("epoch", 0))}
    if op == "status":
        return gw.status()
    raise ValueError(f"unknown cmd {op!r}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python3.11 -m ftgateway.cli")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--publish-dir", required=True)
    ap.add_argument("--memory-threshold", type=int, default=1 << 20)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--recover", action="store_true",
                    help="rebuild state from checkpoints/commit log first")
    args = ap.parse_args(argv)

    if args.recover:
        gw = Gateway.recover(args.workdir, args.publish_dir,
                             memory_threshold=args.memory_threshold,
                             timeout=args.timeout)
    else:
        gw = Gateway(args.workdir, args.publish_dir,
                     memory_threshold=args.memory_threshold,
                     timeout=args.timeout)

    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            result = handle(gw, json.loads(line))
            out.write(_reply(True, **result) + "\n")
        except ConflictError as exc:
            out.write(_reply(
                False, error="conflict",
                conflict={"start": exc.start, "end": exc.end,
                          "existing_fragment_id": exc.existing_fragment_id,
                          "new_fragment_id": exc.new_fragment_id}) + "\n")
        except LengthChangeError as exc:
            out.write(_reply(False, error="length_change",
                             fixed=exc.fixed, attempted=exc.attempted,
                             hint="start a new epoch") + "\n")
        except (BadFragmentError, ValueError, KeyError) as exc:
            out.write(_reply(False, error=type(exc).__name__,
                             message=str(exc)) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
