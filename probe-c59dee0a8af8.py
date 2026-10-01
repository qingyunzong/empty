"""Focused, read-only checks of the submitted OR-Set behavior."""

import importlib.util
import json
import sys
from pathlib import Path


def load_orset():
    spec = importlib.util.spec_from_file_location("submitted_orset", Path.cwd() / "orset.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ORSet


def clone(cls, replica):
    return cls.from_json(json.loads(json.dumps(replica.to_json())))


def overlap(cls):
    events = [
        ("add", "C", "y"),
        ("merge", "A", "C"),
        ("add", "C", "y"),
        ("merge", "C", "A"),
        ("merge", "B", "C"),
        ("merge", "A", "B"),
        ("compact", "A"),
        ("compact", "B"),
        ("remove", "B", "y"),
        ("merge", "B", "A"),
    ]
    compacted = {node: cls(node) for node in "ABC"}
    control = {node: cls(node) for node in "ABC"}
    for op, node, *args in events:
        for replicas in (compacted, control):
            if op == "compact":
                if replicas is compacted:
                    replicas[node].compact()
            elif op == "merge":
                replicas[node].merge(clone(cls, replicas[args[0]]))
            else:
                getattr(replicas[node], op)(args[0])

    actual = compacted["B"].contains("y")
    expected = control["B"].contains("y")
    print(f"交叠摘要：压缩后存在={actual}；未压缩存在={expected}")
    if actual is not True or expected is not False:
        raise AssertionError("交叠摘要反例未复现")


def growth(cls):
    a = cls("A")
    a.add("x")
    b = cls("B")
    b.merge(clone(cls, a))
    a.merge(clone(cls, b))
    before_state = a.to_json()
    before = len(json.dumps(before_state, sort_keys=True).encode("utf-8"))
    made = a.compact()
    after_state = a.to_json()
    after = len(json.dumps(after_state, sort_keys=True).encode("utf-8"))
    covered = after_state["summaries"]["x"][0]["covered"]
    original = before_state["live"]["x"]
    increased = after > before
    retained = covered == original
    print(f"单标签压缩：压缩前={before}字节；压缩后={after}字节")
    print(f"压缩后更大={increased}；保留完整标签={retained}；摘要数={made}")
    if not (made == 1 and increased and retained):
        raise AssertionError("状态增大或原标签保留未复现")


if __name__ == "__main__":
    checks = {"overlap": overlap, "growth": growth}
    if len(sys.argv) != 2 or sys.argv[1] not in checks:
        raise SystemExit("usage: probe.py overlap|growth")
    checks[sys.argv[1]](load_orset())
