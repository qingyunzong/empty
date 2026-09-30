"""命令行入口：python -m sr run trace.json"""

from __future__ import annotations

import argparse
import json

from .simulation import Simulation


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="sr", description="选择重传（SR）协议仿真")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="按 trace 文件运行仿真")
    run_p.add_argument("trace", help="trace JSON 文件路径")
    args = parser.parse_args(argv)

    if args.command == "run":
        with open(args.trace, encoding="utf-8") as f:
            cfg = json.load(f)
        sim = Simulation(
            window_size=cfg.get("window_size", 4),
            seq_space=cfg.get("seq_space", 8),
            timeout=cfg.get("timeout", 10),
            num_frames=cfg["num_frames"],
            loss=cfg.get("loss", []),
            first_seq=cfg.get("first_seq", 1),
        )
        delivered, retransmissions = sim.run()
        out = {
            "delivered": delivered,
            "retransmissions": retransmissions,
            "events": [list(e) for e in sim.events],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0
