"""Independent path-enumeration checker used to cross-validate typedbc.

Unlike typedbc.verifier (block-level abstract interpretation), this checker
explores individual execution paths instruction by instruction and records
every problem category it can find. It deliberately shares no code with the
verifier under test.
"""

from __future__ import annotations

LIMIT = 32


def path_check(program):
    """Return (ok, categories) where categories is a set of problem kinds.

    Kinds: "verify" (bad target / underflow / overflow / fall-off-end),
    "type" (operand type mismatch on some path),
    "join" (two paths reach the same pc with different type stacks).
    """
    n = len(program)
    problems: set[str] = set()

    # Structural pre-pass (applies to the whole program, even dead code).
    for ins in program:
        if ins.op in ("JZ", "JMP") and not (0 <= ins.arg < n):
            problems.add("verify")
    if program[-1].op not in ("JMP", "HALT"):
        problems.add("verify")

    seen: set[tuple[int, tuple[str, ...]]] = set()
    stacks_at: dict[int, set[tuple[str, ...]]] = {}
    worklist = [(0, ())]

    while worklist:
        pc, stack = worklist.pop()
        if (pc, stack) in seen:
            continue
        seen.add((pc, stack))
        known = stacks_at.setdefault(pc, set())
        if known and stack not in known:
            problems.add("join")
        known.add(stack)

        ins = program[pc]
        op = ins.op
        stack = list(stack)

        def pop(expected):
            if not stack:
                problems.add("verify")
                return None
            actual = stack.pop()
            if actual != expected:
                problems.add("type")
                return None
            return actual

        nxt = []
        if op == "CONST_INT":
            stack.append("int")
            nxt = [pc + 1]
        elif op == "CONST_BOOL":
            stack.append("bool")
            nxt = [pc + 1]
        elif op == "ADD":
            if pop("int") is None or pop("int") is None:
                continue
            stack.append("int")
            nxt = [pc + 1]
        elif op == "CMP":
            if pop("int") is None or pop("int") is None:
                continue
            stack.append("bool")
            nxt = [pc + 1]
        elif op == "NOT":
            if pop("bool") is None:
                continue
            stack.append("bool")
            nxt = [pc + 1]
        elif op == "JZ":
            if pop("bool") is None:
                continue
            nxt = [ins.arg, pc + 1]
        elif op == "JMP":
            nxt = [ins.arg]
        elif op == "HALT":
            nxt = []

        if len(stack) > LIMIT:
            problems.add("verify")
            continue
        for target in nxt:
            if target >= n:
                problems.add("verify")  # falls off the end
                continue
            if 0 <= target < n:
                worklist.append((target, tuple(stack)))

    return (not problems, problems)
