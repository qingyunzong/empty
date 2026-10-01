"""Check deletion locality against the actual cached shortest paths."""

import os
import sys

sys.path.insert(0, os.getcwd())

from incsp import IncrementalSSSP


def check(chain_length):
    graph = IncrementalSSSP()
    for u, v, weight in (
        ("s", "a", 1),
        ("s", "b", 1),
        ("a", "t", 1),
        ("b", "t", 1),
    ):
        graph.add_edge(u, v, weight)

    previous = "t"
    for index in range(chain_length):
        current = f"z{index:03d}"
        graph.add_edge(previous, current, 0)
        previous = current

    graph.set_source("s")
    nodes = graph.nodes()
    before = {node: (graph.dist(node), graph.path(node)) for node in nodes}
    assert before[previous][0] == 2
    assert graph.remove_edge("s", "b")
    after = {node: (graph.dist(node), graph.path(node)) for node in nodes}
    changed = [node for node in nodes if before[node] != after[node]]
    counted = graph.recomputed

    assert changed == ["b"], f"changed={changed}"
    assert before[previous] == after[previous], "chain tail changed"
    assert counted == chain_length + 2, f"recomputed={counted}"
    assert counted > len(changed), "deletion did not overcount"
    print(
        f"节点={len(nodes)} 实际变化={len(changed)} "
        f"recomputed={counted} 链尾距离={after[previous][0]} 路径未变"
    )


if __name__ == "__main__":
    check(0)
    check(99)
