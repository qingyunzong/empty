"""Program model, validation, operational semantics and dependency relation.

A program is a JSON object:

    {
      "threads": [
        {"name": "T1", "ops": [ {"op": "write", "addr": "x", "value": 1}, ... ]},
        ...
      ]
    }

Operations (at most 8 per thread, at most 4 threads):
  read    {"op": "read",   "addr": "x"}
  write   {"op": "write",  "addr": "x", "value": 1}
  lock    {"op": "lock",   "lock": "m"}
  unlock  {"op": "unlock", "lock": "m"}
  assert  {"op": "assert", "addr": "x", "eq": 0}   (fails if memory[x] != eq)

Memory locations default to 0.  Locks are re-entrant for the owning thread;
unlocking a lock the current thread does not hold is an E_LOCK error and
terminates that schedule.
"""

from __future__ import annotations

from dataclasses import dataclass, field

MAX_THREADS = 4
MAX_OPS_PER_THREAD = 8

MEMORY_OPS = frozenset({"read", "write", "assert"})
LOCK_OPS = frozenset({"lock", "unlock"})


class ProgramError(Exception):
    """Raised when a program description is invalid."""


@dataclass(frozen=True)
class Op:
    kind: str
    addr: str | None = None
    lock: str | None = None
    value: int | None = None
    raw: dict = field(default_factory=dict, compare=False)


@dataclass
class Thread:
    name: str
    ops: list


@dataclass
class Program:
    threads: list

    @property
    def num_threads(self) -> int:
        return len(self.threads)


def _require(cond, msg):
    if not cond:
        raise ProgramError(msg)


def _is_name(value) -> bool:
    return isinstance(value, str) and value != ""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


_ALLOWED_KEYS = {
    "read": {"op", "addr"},
    "write": {"op", "addr", "value"},
    "lock": {"op", "lock"},
    "unlock": {"op", "lock"},
    "assert": {"op", "addr", "eq"},
}


def parse_op(obj, where) -> Op:
    _require(isinstance(obj, dict), f"{where}: operation must be an object")
    kind = obj.get("op")
    _require(kind in _ALLOWED_KEYS, f"{where}: unknown op {kind!r}")
    unknown = set(obj) - _ALLOWED_KEYS[kind]
    _require(not unknown, f"{where}: unexpected keys {sorted(unknown)}")
    if kind == "read":
        _require(_is_name(obj.get("addr")), f"{where}: read requires string 'addr'")
        return Op("read", addr=obj["addr"], raw=dict(obj))
    if kind == "write":
        _require(_is_name(obj.get("addr")), f"{where}: write requires string 'addr'")
        _require(_is_int(obj.get("value")), f"{where}: write requires integer 'value'")
        return Op("write", addr=obj["addr"], value=obj["value"], raw=dict(obj))
    if kind in ("lock", "unlock"):
        _require(_is_name(obj.get("lock")), f"{where}: {kind} requires string 'lock'")
        return Op(kind, lock=obj["lock"], raw=dict(obj))
    _require(_is_name(obj.get("addr")), f"{where}: assert requires string 'addr'")
    _require(_is_int(obj.get("eq")), f"{where}: assert requires integer 'eq'")
    return Op("assert", addr=obj["addr"], value=obj["eq"], raw=dict(obj))


def parse_program(obj) -> Program:
    """Validate a decoded JSON object and return a Program.

    Raises ProgramError on any invalid input.
    """
    _require(isinstance(obj, dict), "program must be a JSON object")
    _require(set(obj) <= {"threads"}, "unexpected top-level keys")
    threads = obj.get("threads")
    _require(
        isinstance(threads, list) and 1 <= len(threads) <= MAX_THREADS,
        f"program must declare 1..{MAX_THREADS} threads",
    )
    names = set()
    parsed_threads = []
    for i, t in enumerate(threads):
        where = f"thread {i}"
        _require(isinstance(t, dict), f"{where}: must be an object")
        _require(set(t) <= {"name", "ops"}, f"{where}: unexpected keys")
        name = t.get("name", f"T{i + 1}")
        _require(_is_name(name), f"{where}: invalid thread name")
        _require(name not in names, f"duplicate thread name {name!r}")
        names.add(name)
        _require("ops" in t, f"{where}: missing 'ops'")
        ops = t["ops"]
        _require(
            isinstance(ops, list) and len(ops) <= MAX_OPS_PER_THREAD,
            f"{where}: thread must have 0..{MAX_OPS_PER_THREAD} ops",
        )
        parsed = [parse_op(o, f"{where} op {j}") for j, o in enumerate(ops)]
        parsed_threads.append(Thread(name, parsed))
    return Program(parsed_threads)


def dependent(a: Op, b: Op) -> bool:
    """Dependency relation between two operations of *different* threads.

    Two operations are dependent iff they access the same address and at
    least one is a write, or they contend on the same lock.  An assert reads
    its address, so it behaves like a read for dependency purposes.
    """
    if a.kind in MEMORY_OPS and b.kind in MEMORY_OPS:
        return a.addr == b.addr and (a.kind == "write" or b.kind == "write")
    if a.kind in LOCK_OPS and b.kind in LOCK_OPS:
        return a.lock == b.lock
    return False


class State:
    """Concrete execution state."""

    __slots__ = ("pcs", "memory", "locks")

    def __init__(self, pcs, memory, locks):
        self.pcs = pcs          # tuple of per-thread program counters
        self.memory = memory    # addr -> int
        self.locks = locks      # lock name -> (owner_tid, recursion count)

    @classmethod
    def initial(cls, num_threads):
        return cls((0,) * num_threads, {}, {})


def enabled(program: Program, state: State) -> list:
    """Threads that may execute their next operation in this state."""
    result = []
    for tid, thread in enumerate(program.threads):
        pc = state.pcs[tid]
        if pc >= len(thread.ops):
            continue
        op = thread.ops[pc]
        if op.kind == "lock":
            owner = state.locks.get(op.lock, (None, 0))[0]
            if owner is not None and owner != tid:
                continue  # blocked on a lock held by another thread
        result.append(tid)
    return result


def step(program: Program, state: State, tid: int):
    """Execute the next operation of thread ``tid``.

    Returns ``(new_state, None)`` on success, or ``(None, event)`` where
    event is ``"E_LOCK"`` or ``"ASSERT"``.
    """
    op = program.threads[tid].ops[state.pcs[tid]]
    pcs = list(state.pcs)
    pcs[tid] += 1
    pcs = tuple(pcs)

    if op.kind == "read":
        state.memory.get(op.addr, 0)
        return State(pcs, state.memory, state.locks), None

    if op.kind == "write":
        memory = dict(state.memory)
        memory[op.addr] = op.value
        return State(pcs, memory, state.locks), None

    if op.kind == "assert":
        if state.memory.get(op.addr, 0) != op.value:
            return None, "ASSERT"
        return State(pcs, state.memory, state.locks), None

    if op.kind == "lock":
        locks = dict(state.locks)
        _, count = locks.get(op.lock, (None, 0))
        locks[op.lock] = (tid, count + 1)  # re-entrant for the owner
        return State(pcs, state.memory, locks), None

    if op.kind == "unlock":
        owner, count = state.locks.get(op.lock, (None, 0))
        if owner != tid:
            return None, "E_LOCK"
        locks = dict(state.locks)
        if count == 1:
            del locks[op.lock]
        else:
            locks[op.lock] = (tid, count - 1)
        return State(pcs, state.memory, locks), None

    raise AssertionError(f"unhandled op kind {op.kind!r}")
