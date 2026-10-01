"""cfgdom core: build a CFG from linear bytecode and compute dominators.

Program schema (JSON)::

    {"instructions": [
        {"offset": 0, "fallthrough": true,  "targets": [8], "op": "JNZ"},
        {"offset": 4, "fallthrough": false, "targets": [],  "op": "HALT"}
    ]}

A bare top-level list of instructions is also accepted.  ``fallthrough``
defaults to ``true`` and ``targets`` to ``[]``.  Instructions whose ``op``
is ``HALT`` or ``RET`` never have successors, regardless of the other
fields.  An instruction with ``fallthrough: false`` and no targets is
treated as a halt even without an explicit ``op``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

__all__ = ["CFGError", "Block", "CFG", "build_cfg", "analyze"]

TERMINATORS = ("HALT", "RET")


class CFGError(Exception):
    """Raised for malformed programs.  Carries the offending offset."""

    def __init__(self, message: str, offset: int | None = None):
        self.offset = offset
        if offset is not None:
            message = f"{message} (offset={offset})"
        super().__init__(message)


@dataclass
class Instruction:
    offset: int
    fallthrough: bool
    targets: tuple[int, ...]
    op: str | None = None

    @property
    def is_terminator(self) -> bool:
        return self.op is not None and self.op.upper() in TERMINATORS


@dataclass
class Block:
    id: int
    offsets: list[int]
    successors: list[int] = field(default_factory=list)
    unreachable: bool = False
    dom: set[int] = field(default_factory=set)
    idom: int | None = None

    @property
    def start(self) -> int:
        return self.offsets[0]

    @property
    def end(self) -> int:
        return self.offsets[-1]


@dataclass
class CFG:
    blocks: list[Block]
    edges: list[tuple[int, int]]
    back_edges: list[tuple[int, int]]
    loop_headers: list[int]

    def to_dict(self) -> dict:
        return {
            "blocks": [
                {
                    "id": b.id,
                    "start": b.start,
                    "end": b.end,
                    "offsets": list(b.offsets),
                    "successors": list(b.successors),
                    "unreachable": b.unreachable,
                    "dom": sorted(b.dom),
                    "idom": b.idom,
                }
                for b in self.blocks
            ],
            "edges": [list(e) for e in self.edges],
            "back_edges": [list(e) for e in self.back_edges],
            "loop_headers": list(self.loop_headers),
        }


def _parse_instructions(program) -> list[Instruction]:
    if isinstance(program, dict):
        program = program.get("instructions")
    if not isinstance(program, list):
        raise CFGError("program must be a list of instructions "
                       "or an object with an 'instructions' list")
    if len(program) == 0:
        raise CFGError("empty program: no instructions")

    instructions = []
    for index, raw in enumerate(program):
        if not isinstance(raw, dict):
            raise CFGError(f"instruction #{index} is not an object")
        offset = raw.get("offset")
        if isinstance(offset, bool) or not isinstance(offset, int):
            raise CFGError(f"instruction #{index} has a missing or non-integer offset")
        fallthrough = raw.get("fallthrough", True)
        if not isinstance(fallthrough, bool):
            raise CFGError("fallthrough must be a boolean", offset)
        targets = raw.get("targets", [])
        if not isinstance(targets, list) or any(
            isinstance(t, bool) or not isinstance(t, int) for t in targets
        ):
            raise CFGError("targets must be a list of integer offsets", offset)
        op = raw.get("op")
        if op is not None and not isinstance(op, str):
            raise CFGError("op must be a string", offset)
        instructions.append(Instruction(offset, fallthrough, tuple(targets), op))
    return instructions


def build_cfg(program) -> CFG:
    """Build the CFG and compute dom sets, idom, back edges, loop headers."""
    instructions = _parse_instructions(program)

    seen: set[int] = set()
    for ins in instructions:
        if ins.offset in seen:
            raise CFGError("duplicate instruction offset", ins.offset)
        seen.add(ins.offset)

    instructions.sort(key=lambda i: i.offset)
    offsets = [i.offset for i in instructions]
    index_of = {off: idx for idx, off in enumerate(offsets)}

    for ins in instructions:
        for target in ins.targets:
            if target not in index_of:
                raise CFGError(f"bad edge: target {target} has no instruction",
                               ins.offset)

    # Successor offsets of each instruction (instruction level).
    def succ_offsets(idx: int) -> list[int]:
        ins = instructions[idx]
        if ins.is_terminator:
            return []
        succ = list(ins.targets)
        if ins.fallthrough and idx + 1 < len(instructions):
            succ.append(offsets[idx + 1])
        return succ

    # Leaders: entry, jump targets, and the instruction after any
    # instruction that does not simply fall through (jump or halt/ret).
    leaders = {offsets[0]}
    for idx, ins in enumerate(instructions):
        leaders.update(ins.targets)
        if idx + 1 < len(instructions) and (ins.targets or not ins.fallthrough):
            leaders.add(offsets[idx + 1])

    # Split into blocks: maximal fallthrough runs starting at leaders.
    blocks: list[Block] = []
    block_of: dict[int, int] = {}
    for idx, off in enumerate(offsets):
        if off in leaders or not blocks:
            blocks.append(Block(id=len(blocks), offsets=[off]))
        else:
            blocks[-1].offsets.append(off)
        block_of[off] = len(blocks) - 1

    edges: set[tuple[int, int]] = set()
    for block in blocks:
        last_idx = index_of[block.end]
        succ_ids = sorted({block_of[o] for o in succ_offsets(last_idx)})
        block.successors = succ_ids
        for s in succ_ids:
            edges.add((block.id, s))

    # Reachability from the entry block (id 0).
    reachable = {0}
    worklist = [0]
    while worklist:
        u = worklist.pop()
        for v in blocks[u].successors:
            if v not in reachable:
                reachable.add(v)
                worklist.append(v)
    for block in blocks:
        block.unreachable = block.id not in reachable

    # Dominators: iterative fixed point over all blocks.
    # dom(0) = {0}; dom(n) = {n} | intersect(dom(p) for p in preds).
    # Blocks with no predecessors keep the universe, which matches the
    # vacuous path-based definition for unreachable blocks.
    universe = set(range(len(blocks)))
    preds: list[list[int]] = [[] for _ in blocks]
    for u, v in edges:
        preds[v].append(u)

    dom = [{0} if b.id == 0 else set(universe) for b in blocks]
    changed = True
    while changed:
        changed = False
        for n in range(1, len(blocks)):
            if preds[n]:
                new = set.intersection(*(dom[p] for p in preds[n]))
            else:
                new = set(universe)
            new.add(n)
            if new != dom[n]:
                dom[n] = new
                changed = True
    for block in blocks:
        block.dom = dom[block.id]

    # idom: strict dominator with the largest dom set.  Only meaningful
    # for reachable blocks; unreachable blocks get null.
    for block in blocks:
        if block.id == 0 or block.unreachable:
            block.idom = None
            continue
        strict = block.dom - {block.id}
        block.idom = min(strict, key=lambda d: (-len(dom[d]), d), default=None)

    # Back edges: edge u -> v with v in dom(u), restricted to reachable
    # blocks (dominance in unreachable code is vacuous).
    back_edges = sorted(
        (u, v) for u, v in edges
        if u in reachable and v in reachable and v in dom[u]
    )
    loop_headers = sorted({v for _, v in back_edges})

    return CFG(
        blocks=blocks,
        edges=sorted(edges),
        back_edges=back_edges,
        loop_headers=loop_headers,
    )


def analyze(program) -> dict:
    """Build the CFG and return a JSON-serialisable result dict."""
    return build_cfg(program).to_dict()
