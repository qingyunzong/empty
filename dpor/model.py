"""Program model: JSON validation and the transition dependency relation."""

OPS = ("read", "write", "lock", "unlock", "assert")
MAX_THREADS = 4
MAX_OPS = 8


class ProgramError(Exception):
    """Raised when a program description is invalid."""


def _require(cond, msg):
    if not cond:
        raise ProgramError(msg)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_op(tid, idx, op):
    where = "thread %d op %d" % (tid, idx)
    _require(isinstance(op, dict), where + ": operation must be an object")
    kind = op.get("op")
    _require(kind in OPS, "%s: unknown op %r" % (where, kind))
    if kind == "read":
        _require(isinstance(op.get("addr"), str),
                 where + ": read requires a string 'addr'")
        dst = op.get("dst")
        _require(dst is None or isinstance(dst, str),
                 where + ": read 'dst' must be a string")
    elif kind == "write":
        _require(isinstance(op.get("addr"), str),
                 where + ": write requires a string 'addr'")
        _require(_is_int(op.get("value")),
                 where + ": write requires an integer 'value'")
    elif kind in ("lock", "unlock"):
        _require(isinstance(op.get("lock"), str),
                 "%s: %s requires a string 'lock'" % (where, kind))
    elif kind == "assert":
        has_addr = "addr" in op
        has_var = "var" in op
        _require(has_addr != has_var,
                 where + ": assert requires exactly one of 'addr' or 'var'")
        if has_addr:
            _require(isinstance(op.get("addr"), str),
                     where + ": assert 'addr' must be a string")
        else:
            _require(isinstance(op.get("var"), str),
                     where + ": assert 'var' must be a string")
        _require(_is_int(op.get("equals")),
                 where + ": assert requires an integer 'equals'")
    return dict(op)


def validate_program(data):
    """Validate a decoded JSON program; return normalized thread lists."""
    _require(isinstance(data, dict), "program must be a JSON object")
    threads = data.get("threads")
    _require(isinstance(threads, list), "program requires a 'threads' list")
    _require(1 <= len(threads) <= MAX_THREADS,
             "program must have between 1 and %d threads" % MAX_THREADS)
    checked = []
    for tid, ops in enumerate(threads):
        _require(isinstance(ops, list),
                 "thread %d must be a list of operations" % tid)
        _require(len(ops) <= MAX_OPS,
                 "thread %d has more than %d operations" % (tid, MAX_OPS))
        checked.append([validate_op(tid, i, op) for i, op in enumerate(ops)])
    return checked


def _addr_accesses(op):
    """Shared-memory accesses of an op as (addr, is_write) pairs."""
    kind = op["op"]
    if kind == "write":
        return ((op["addr"], True),)
    if kind == "read":
        return ((op["addr"], False),)
    if kind == "assert" and "addr" in op:
        return ((op["addr"], False),)
    return ()


def _lock_accesses(op):
    if op["op"] in ("lock", "unlock"):
        return (op["lock"],)
    return ()


def dependent(op1, op2):
    """Two ops are dependent iff they access the same address with at
    least one write, or they compete for the same lock."""
    for addr1, is_write1 in _addr_accesses(op1):
        for addr2, is_write2 in _addr_accesses(op2):
            if addr1 == addr2 and (is_write1 or is_write2):
                return True
    return bool(set(_lock_accesses(op1)) & set(_lock_accesses(op2)))
