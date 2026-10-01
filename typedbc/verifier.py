"""Bytecode type-stack verifier based on forward abstract interpretation.

The abstract domain is the concrete type stack (a tuple of "int"/"bool",
top of stack last), bounded to MAX_STACK_HEIGHT entries.  Each basic block
is interpreted once with its input abstract state; at CFG join points the
incoming stacks must have equal height and equal element types, otherwise a
JoinError is raised.  Because stacks are concrete and bounded, the analysis
terminates: the first state to reach a block fixes its input state and any
later, different state is a join error.

Unreachable (dead) blocks never receive a state and therefore do not take
part in the runtime typing.  They are still checked for structural legality
(bad jump targets are VerifyError everywhere) and are re-simulated locally
from the empty stack to produce DeadType warnings.
"""

from collections import deque
from dataclasses import dataclass, field

from .errors import DeadType, JoinError, TypeFault, VerifyError
from .isa import BOOL, INT

MAX_STACK_HEIGHT = 32


@dataclass
class BlockInfo:
    start: int
    end: int  # exclusive
    reachable: bool = False
    in_stack: tuple = None
    out_stack: tuple = None
    successors: list = field(default_factory=list)


@dataclass
class VerifyResult:
    blocks: list
    warnings: list


def check_structure(prog):
    """Whole-program structural checks (also cover dead code)."""
    n = len(prog)
    if n == 0:
        raise VerifyError("empty program")
    for ins in prog:
        if ins.op in ("JZ", "JMP"):
            if not 0 <= ins.arg < n:
                raise VerifyError(
                    "bad jump target %r at pc %d (program has %d instructions)"
                    % (ins.arg, ins.pc, n),
                    pc=ins.pc,
                )


def compute_blocks(prog):
    """Split the program into basic blocks, returns a list of BlockInfo."""
    n = len(prog)
    leaders = {0}
    for ins in prog:
        if ins.op in ("JZ", "JMP"):
            leaders.add(ins.arg)
            if ins.pc + 1 < n:
                leaders.add(ins.pc + 1)
        elif ins.op == "HALT":
            if ins.pc + 1 < n:
                leaders.add(ins.pc + 1)
    starts = sorted(leaders)
    blocks = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else n
        blocks.append(BlockInfo(start=start, end=end))
    return blocks


def _push(stack, typ, pc):
    if len(stack) >= MAX_STACK_HEIGHT:
        raise VerifyError(
            "stack height overflow (>%d) at pc %d" % (MAX_STACK_HEIGHT, pc), pc=pc
        )
    stack.append(typ)


def _pop_expect(stack, want, pc, before):
    if not stack:
        raise VerifyError("stack underflow at pc %d" % pc, pc=pc)
    got = stack[-1]
    if got != want:
        raise TypeFault(pc=pc, expected=want, actual=got, stack=before)
    stack.pop()


def transfer(pc, ins, stack):
    """Execute one instruction abstractly.

    Takes and returns plain lists/tuples of type names.  Returns
    (edges, result_stack) where edges is a list of (next_pc, stack) with
    fallthrough first; HALT yields no edges.
    """
    stack = list(stack)
    before = tuple(stack)
    op = ins.op
    if op == "CONST_INT":
        _push(stack, INT, pc)
    elif op == "CONST_BOOL":
        _push(stack, BOOL, pc)
    elif op == "ADD":
        _pop_expect(stack, INT, pc, before)
        _pop_expect(stack, INT, pc, before)
        _push(stack, INT, pc)
    elif op == "CMP":
        _pop_expect(stack, INT, pc, before)
        _pop_expect(stack, INT, pc, before)
        _push(stack, BOOL, pc)
    elif op == "NOT":
        _pop_expect(stack, BOOL, pc, before)
        _push(stack, BOOL, pc)
    elif op == "JZ":
        _pop_expect(stack, BOOL, pc, before)
        out = tuple(stack)
        return [(pc + 1, out), (ins.arg, out)], out
    elif op == "JMP":
        out = tuple(stack)
        return [(ins.arg, out)], out
    elif op == "HALT":
        return [], tuple(stack)
    else:  # pragma: no cover - parser rejects unknown opcodes
        raise VerifyError("unknown opcode %r at pc %d" % (op, pc), pc=pc)
    out = tuple(stack)
    return [(pc + 1, out)], out


def simulate_block(prog, block, in_stack):
    """Run one basic block; returns (edges, out_stack)."""
    stack = tuple(in_stack)
    edges = []
    out = stack
    for pc in range(block.start, block.end):
        edges, out = transfer(pc, prog[pc], stack)
        if pc != block.end - 1:
            # Non-final instructions must be plain fallthrough.
            if len(edges) != 1 or edges[0][0] != pc + 1:  # pragma: no cover
                raise VerifyError("control flow inside basic block at pc %d" % pc, pc=pc)
            stack = edges[0][1]
    return edges, out


def verify(prog):
    """Verify a parsed program.  Raises TypeFault / JoinError / VerifyError.

    On success returns a VerifyResult with per-block abstract states and
    DeadType warnings for unreachable code.
    """
    check_structure(prog)
    blocks = compute_blocks(prog)
    by_start = {b.start: b for b in blocks}
    n = len(prog)

    states = {0: ()}
    entry = blocks[0]
    entry.reachable = True
    entry.in_stack = ()
    queue = deque([entry])
    while queue:
        block = queue.popleft()
        edges, out = simulate_block(prog, block, block.in_stack)
        block.out_stack = out
        for succ_pc, succ_stack in edges:
            if succ_pc >= n:
                continue  # running off the end is an implicit HALT
            succ = by_start[succ_pc]
            if succ_pc not in states:
                states[succ_pc] = succ_stack
                succ.reachable = True
                succ.in_stack = succ_stack
                queue.append(succ)
            elif states[succ_pc] != succ_stack:
                raise JoinError(
                    pc=succ_pc,
                    expected=states[succ_pc],
                    actual=succ_stack,
                )
            if succ_pc not in block.successors:
                block.successors.append(succ_pc)

    warnings = []
    for block in blocks:
        if block.reachable:
            continue
        try:
            simulate_block(prog, block, ())
        except TypeFault as exc:
            warnings.append(DeadType(pc=exc.pc, message=str(exc), stack=exc.stack))
        except VerifyError as exc:
            warnings.append(DeadType(pc=exc.pc, message=str(exc), stack=[]))
    return VerifyResult(blocks=blocks, warnings=warnings)


def result_to_json(result):
    """Serialisable view of a VerifyResult (the CLI 'blocks JSON')."""
    return {
        "ok": True,
        "max_stack_height": MAX_STACK_HEIGHT,
        "blocks": [
            {
                "start": b.start,
                "end": b.end,
                "reachable": b.reachable,
                "in": list(b.in_stack) if b.in_stack is not None else None,
                "out": list(b.out_stack) if b.out_stack is not None else None,
                "successors": list(b.successors),
            }
            for b in result.blocks
        ],
        "warnings": [
            {
                "kind": "DeadType",
                "pc": w.pc,
                "message": w.message,
                "stack": list(w.stack),
            }
            for w in result.warnings
        ],
    }
