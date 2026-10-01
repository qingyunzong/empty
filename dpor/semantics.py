"""Concrete execution semantics for the shared-memory model."""

E_LOCK = "E_LOCK"
VIOLATION = "VIOLATION"


class State:
    __slots__ = ("pcs", "memory", "locals", "locks", "error", "error_op")

    def __init__(self, nthreads):
        self.pcs = [0] * nthreads
        self.memory = {}
        self.locals = [{} for _ in range(nthreads)]
        self.locks = {}  # lock name -> [holder tid, recursion count]
        self.error = None
        self.error_op = None


def initial_state(program):
    return State(len(program))


def thread_enabled(program, state, tid):
    if state.error is not None:
        return False
    pc = state.pcs[tid]
    if pc >= len(program[tid]):
        return False
    op = program[tid][pc]
    if op["op"] == "lock":
        entry = state.locks.get(op["lock"])
        if entry is not None and entry[0] != tid:
            return False  # blocked on a lock held by another thread
    return True


def enabled_threads(program, state):
    return [t for t in range(len(program))
            if thread_enabled(program, state, t)]


def is_complete(program, state):
    return all(state.pcs[t] >= len(program[t]) for t in range(len(program)))


def step(program, state, tid):
    """Execute the next op of thread tid. Assumes tid is enabled."""
    op = program[tid][state.pcs[tid]]
    kind = op["op"]
    if kind == "read":
        state.locals[tid][op.get("dst", "_")] = state.memory.get(op["addr"], 0)
        state.pcs[tid] += 1
    elif kind == "write":
        state.memory[op["addr"]] = op["value"]
        state.pcs[tid] += 1
    elif kind == "lock":
        entry = state.locks.get(op["lock"])
        if entry is None:
            state.locks[op["lock"]] = [tid, 1]
        else:
            entry[1] += 1  # reentrant lock by the holding thread
        state.pcs[tid] += 1
    elif kind == "unlock":
        entry = state.locks.get(op["lock"])
        if entry is None or entry[0] != tid:
            state.error = E_LOCK
            state.error_op = (tid, state.pcs[tid])
            return
        entry[1] -= 1
        if entry[1] == 0:
            del state.locks[op["lock"]]
        state.pcs[tid] += 1
    elif kind == "assert":
        if "addr" in op:
            actual = state.memory.get(op["addr"], 0)
        else:
            actual = state.locals[tid].get(op["var"], 0)
        if actual != op["equals"]:
            state.error = VIOLATION
            state.error_op = (tid, state.pcs[tid])
            return
        state.pcs[tid] += 1


def replay(program, prefix):
    """Replay a schedule prefix (sequence of thread ids).

    Returns (state, trace) where trace is a list of (tid, pc, op) triples.
    """
    state = initial_state(program)
    trace = []
    for tid in prefix:
        if not thread_enabled(program, state, tid):
            raise ValueError("prefix is not a valid schedule: %r" % (prefix,))
        pc = state.pcs[tid]
        op = program[tid][pc]
        trace.append((tid, pc, op))
        step(program, state, tid)
        if state.error is not None:
            break
    return state, trace
