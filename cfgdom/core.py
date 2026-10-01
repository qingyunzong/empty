"""Core CFG construction and dominator analysis for cfgdom.

Input programs are flat lists of instructions, each a mapping with:
  - "offset":      unique integer offset of the instruction (required)
  - "fallthrough": bool, whether control may continue to the next
                   instruction in offset order (default True)
  - "targets":     list of integer jump-target offsets (default [])

An instruction with fallthrough=False and targets=[] is terminal
(HALT/RET semantics: no successors).
"""

from __future__ import annotations

from dataclasses import dataclass, field


class CFGError(Exception):
    """Raised for malformed programs. Carries the offending offset."""

    def __init__(self, message, offset=None):
        super().__init__(message)
        self.message = message
        self.offset = offset

    def __str__(self):
        if self.offset is not None:
            return f"{self.message} (offset {self.offset})"
        return self.message


@dataclass
class Instruction:
    offset: int
    fallthrough: bool = True
    targets: list = field(default_factory=list)


@dataclass
class Block:
    id: int
    start: int
    end: int = -1
    instructions: list = field(default_factory=list)
    successors: list = field(default_factory=list)
    reachable: bool = False
    dom: object = None  # sorted list of dominating block ids, None if unreachable
    idom: object = None  # immediate dominator block id, None for entry/unreachable


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def parse_program(data):
    """Validate raw JSON data and return sorted Instruction objects."""
    if not isinstance(data, list) or not data:
        raise CFGError("empty program")
    instrs = []
    seen = set()
    for index, raw in enumerate(data):
        if not isinstance(raw, dict) or "offset" not in raw:
            raise CFGError(f"instruction #{index} missing 'offset'")
        offset = raw["offset"]
        if not _is_int(offset):
            raise CFGError(f"invalid offset {offset!r}")
        if offset in seen:
            raise CFGError("duplicate offset", offset=offset)
        seen.add(offset)
        fallthrough = raw.get("fallthrough", True)
        if not isinstance(fallthrough, bool):
            raise CFGError("'fallthrough' must be a boolean", offset=offset)
        targets = raw.get("targets", [])
        if not isinstance(targets, list) or any(not _is_int(t) for t in targets):
            raise CFGError("'targets' must be a list of integer offsets", offset=offset)
        instrs.append(Instruction(offset, fallthrough, list(dict.fromkeys(targets))))
    instrs.sort(key=lambda ins: ins.offset)
    offsets = {ins.offset for ins in instrs}
    for ins in instrs:
        for target in ins.targets:
            if target not in offsets:
                raise CFGError(
                    f"bad edge: target {target} is not an instruction offset",
                    offset=ins.offset,
                )
    return instrs


def build_cfg(instrs):
    """Split sorted instructions into basic blocks and wire successors."""
    leaders = {instrs[0].offset}
    for i, ins in enumerate(instrs):
        leaders.update(ins.targets)
        if (ins.targets or not ins.fallthrough) and i + 1 < len(instrs):
            leaders.add(instrs[i + 1].offset)

    blocks = []
    start_to_block = {}
    current = None
    for ins in instrs:
        if ins.offset in leaders:
            current = Block(id=len(blocks), start=ins.offset)
            blocks.append(current)
            start_to_block[ins.offset] = current
        current.instructions.append(ins)
        current.end = ins.offset

    for i, block in enumerate(blocks):
        last = block.instructions[-1]
        succ = set()
        if last.fallthrough and i + 1 < len(blocks):
            succ.add(blocks[i + 1].id)
        for target in last.targets:
            succ.add(start_to_block[target].id)
        block.successors = sorted(succ)
    return blocks


def compute_dominators(n, successors, entry=0):
    """Iterative-fixpoint dominators over the reachable subgraph.

    Returns (reachable, dom, idom):
      reachable[i] -> bool
      dom[i]       -> set of dominators of i (None if unreachable)
      idom[i]      -> immediate dominator (None for entry/unreachable)
    """
    preds = [[] for _ in range(n)]
    for u in range(n):
        for v in successors[u]:
            preds[v].append(u)

    reachable = [False] * n
    reachable[entry] = True
    stack = [entry]
    while stack:
        u = stack.pop()
        for v in successors[u]:
            if not reachable[v]:
                reachable[v] = True
                stack.append(v)

    reach_set = {i for i in range(n) if reachable[i]}
    dom = [None] * n
    dom[entry] = {entry}
    for i in range(n):
        if reachable[i] and i != entry:
            dom[i] = set(reach_set)

    changed = True
    while changed:
        changed = False
        for u in range(n):
            if not reachable[u] or u == entry:
                continue
            reach_preds = [p for p in preds[u] if reachable[p]]
            new = set(reach_set)
            for p in reach_preds:
                new &= dom[p]
            new.add(u)
            if new != dom[u]:
                dom[u] = new
                changed = True

    idom = [None] * n
    for u in range(n):
        if not reachable[u] or u == entry:
            continue
        strict = dom[u] - {u}
        idom[u] = max(strict, key=lambda d: len(dom[d]))
    return reachable, dom, idom


def analyze_program(data):
    """Full pipeline: validate, build CFG, compute dom/idom/back-edges."""
    instrs = parse_program(data)
    blocks = build_cfg(instrs)
    succ = [b.successors for b in blocks]
    reachable, dom, idom = compute_dominators(len(blocks), succ, entry=0)

    for i, block in enumerate(blocks):
        block.reachable = reachable[i]
        block.dom = sorted(dom[i]) if reachable[i] else None
        block.idom = idom[i] if reachable[i] else None

    edges = sorted((u, v) for u in range(len(blocks)) for v in succ[u])
    back_edges = sorted(
        (u, v)
        for (u, v) in edges
        if reachable[u] and reachable[v] and v in dom[u]
    )
    loop_headers = sorted({v for _, v in back_edges})

    return {
        "blocks": [
            {
                "id": b.id,
                "start": b.start,
                "end": b.end,
                "offsets": [ins.offset for ins in b.instructions],
                "successors": b.successors,
                "reachable": b.reachable,
                "dom": b.dom,
                "idom": b.idom,
            }
            for b in blocks
        ],
        "edges": [list(e) for e in edges],
        "back_edges": [list(e) for e in back_edges],
        "loop_headers": loop_headers,
    }
