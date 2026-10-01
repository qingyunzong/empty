"""Independent, read-only checks of dedupwin's observable result semantics."""

import os
import sys

sys.path.insert(0, os.getcwd())

from dedupwin import DedupWin


def event(rid, ts, value):
    return {"id": rid, "key": "k", "ts": ts, "val": value}


def result_pairs(processor):
    return [(item["id"], item["ts"]) for item in processor.results()]


def main(case):
    if case == "winner":
        processor = DedupWin(100, 100)
        processor.add(event("x", 20, "later"))
        processor.add(event("x", 10, "earlier"))
        actual = result_pairs(processor)
        expected = [("x", 10)]  # stable sort by (ts, id), then deduplicate
        failed = actual != expected
        print(f"乱序重复ID：预期={expected} 实际={actual}")
    elif case == "lower_bound":
        processor = DedupWin(5, 5)
        processor.add(event("a", 0, "old"))
        processor.add(event("b", 20, "new"))
        actual = result_pairs(processor)
        lower = processor.lower_bound
        stale = [(rid, ts) for rid, ts in actual if ts < lower]
        failed = bool(stale)
        print(f"最终下限={lower} 输出={actual} 低于下限={stale}")
    elif case == "eviction":
        processor = DedupWin(10, 5)
        processor.add(event("a", 0, "old"))
        processor.add(event("b", 21, "new"))
        processor.add(event("a", 6, "accepted"))
        actual = result_pairs(processor)
        ids = [rid for rid, _ in actual]
        repeated = sorted({rid for rid in ids if ids.count(rid) > 1})
        failed = bool(repeated)
        print(f"驱逐后输出={actual} 重复ID={repeated}")
    else:
        raise ValueError(f"unknown case: {case}")
    print("语义检查：失败" if failed else "语义检查：通过")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: probe.py winner|lower_bound|eviction")
    raise SystemExit(main(sys.argv[1]))
