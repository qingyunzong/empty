"""Command line interface: python -m dedupwin --in e.jsonl --skew N --ret M"""

import argparse
import json
import sys

from .core import DedupWin


def build_parser():
    parser = argparse.ArgumentParser(
        prog="dedupwin",
        description="Deduplicate JSONL events under skew/retention semantics.",
    )
    parser.add_argument("--in", dest="infile", required=True,
                        help="input JSONL file with {id, key, ts, val} records")
    parser.add_argument("--skew", type=int, required=True,
                        help="global skew: upper bound on max-ts difference")
    parser.add_argument("--ret", type=int, required=True,
                        help="retention horizon")
    parser.add_argument("--out", dest="outfile", default=None,
                        help="output file (default: stdout)")
    return parser


def run(infile, skew, ret, outfile=None, err=None):
    """Process ``infile``; return (exit_code, DedupWin)."""
    err = err if err is not None else sys.stderr
    dw = DedupWin(skew=skew, ret=ret)
    read = 0
    with open(infile, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            read += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                dw.bad += 1
                continue
            if not isinstance(rec, dict) or "id" not in rec or "ts" not in rec:
                print("error: line %d: missing required field 'id' or 'ts'"
                      % lineno, file=err)
                return 2, dw
            ts = rec["ts"]
            if isinstance(ts, bool) or not isinstance(ts, (int, float)) or ts < 0:
                dw.bad += 1
                continue
            dw.add(rec)
    out = open(outfile, "w", encoding="utf-8") if outfile else sys.stdout
    try:
        for rec in dw.results():
            out.write(json.dumps(rec, ensure_ascii=False, sort_keys=True))
            out.write("\n")
    finally:
        if outfile:
            out.close()
    stats = dw.stats()
    print("stats: read=%d %s" % (
        read, " ".join("%s=%d" % (k, v) for k, v in stats.items())), file=err)
    return 0, dw


def main(argv=None):
    args = build_parser().parse_args(argv)
    code, _ = run(args.infile, args.skew, args.ret, args.outfile)
    return code


if __name__ == "__main__":
    sys.exit(main())
