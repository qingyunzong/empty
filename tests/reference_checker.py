"""Independent path-enumeration type checker.

Deliberately separate from typedbc.verifier: instead of block-level abstract
interpretation it executes the program path by path (a FIFO worklist of
concrete (pc, type-stack) states) and collects *every* error it can reach.
Used by the differential fuzz test to cross-check typedbc.verify.
"""

from collections import deque

MAX_STACK_HEIGHT = 32
_STEP_BUDGET = 1_000_000


def _structural_errors(prog):
    errors = []
    n = len(prog)
    if n == 0:
        errors.append(("VerifyError", None))
        return errors
    for ins in prog:
        if ins.op in ("JZ", "JMP") and not 0 <= ins.arg < n:
            errors.append(("VerifyError", ins.pc))
    return errors


def check(prog):
    """Return a list of (category, pc) errors; empty list means the program
    is well-typed.  Categories: "VerifyError", "TypeFault", "JoinError"."""
    errors = _structural_errors(prog)
    if errors:
        return errors

    n = len(prog)
    seen = {0: ()}
    queue = deque([(0, ())])
    steps = 0
    while queue:
        steps += 1
        if steps > _STEP_BUDGET:
            raise RuntimeError("reference checker step budget exceeded")
        pc, stack = queue.popleft()
        ins = prog[pc]
        stack = list(stack)
        op = ins.op

        def push(typ):
            if len(stack) >= MAX_STACK_HEIGHT:
                errors.append(("VerifyError", pc))
                return False
            stack.append(typ)
            return True

        succ = []
        if op == "CONST_INT":
            if not push("int"):
                continue
            succ = [(pc + 1, tuple(stack))]
        elif op == "CONST_BOOL":
            if not push("bool"):
                continue
            succ = [(pc + 1, tuple(stack))]
        elif op in ("ADD", "CMP"):
            failed = False
            for _ in range(2):
                if not stack:
                    errors.append(("VerifyError", pc))
                    failed = True
                    break
                if stack[-1] != "int":
                    errors.append(("TypeFault", pc))
                    failed = True
                    break
                stack.pop()
            if failed:
                continue
            if not push("int" if op == "ADD" else "bool"):
                continue
            succ = [(pc + 1, tuple(stack))]
        elif op == "NOT":
            if not stack:
                errors.append(("VerifyError", pc))
                continue
            if stack[-1] != "bool":
                errors.append(("TypeFault", pc))
                continue
            succ = [(pc + 1, tuple(stack))]
        elif op == "JZ":
            if not stack:
                errors.append(("VerifyError", pc))
                continue
            if stack[-1] != "bool":
                errors.append(("TypeFault", pc))
                continue
            stack.pop()
            succ = [(pc + 1, tuple(stack)), (ins.arg, tuple(stack))]
        elif op == "JMP":
            succ = [(ins.arg, tuple(stack))]
        else:  # HALT
            succ = []

        for succ_pc, succ_stack in succ:
            if succ_pc >= n:
                continue  # implicit halt off the end
            prev = seen.get(succ_pc)
            if prev is None:
                seen[succ_pc] = succ_stack
                queue.append((succ_pc, succ_stack))
            elif prev != succ_stack:
                errors.append(("JoinError", succ_pc))
    return errors
