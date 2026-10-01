"""Deterministic operation-stream engine.

Determinism rules:
- The only randomness source is ``random.Random``.
- No wall-clock time, pid, or ``hash()`` is ever used, so output is
  independent of PYTHONHASHSEED and stable across processes.
- ``fork(name)`` derives a child stream from (parent seed, parent draw
  position, name) via SHA-256 and never consumes parent random numbers.
"""

import hashlib
import json
import random

RECORD_VERSION = 1
_FORK_DRAW_MODULUS = 2**32


def canonical(obj):
    """Canonical JSON encoding used for all hashing and derivation."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Stream:
    """A ``random.Random`` wrapper that tracks its draw position."""

    def __init__(self, seed):
        self.seed = seed
        self.position = 0
        self._rng = random.Random(seed)

    def randrange(self, stop):
        self.position += 1
        return self._rng.randrange(stop)

    def randint(self, lo, hi):
        self.position += 1
        return self._rng.randint(lo, hi)

    def choice(self, seq):
        self.position += 1
        return self._rng.choice(seq)

    def fork(self, name):
        """Derive a child stream without consuming this stream's randoms."""
        material = canonical(
            {"kind": "fork", "seed": self.seed, "pos": self.position, "name": name}
        )
        digest = hashlib.sha256(material.encode("utf-8")).digest()
        child_seed = int.from_bytes(digest[:8], "big")
        return Stream(child_seed)


def _eval(expr, env):
    return bool(eval(expr, {"__builtins__": {}}, dict(env)))  # noqa: S102


def _exec(effect, env):
    exec(effect, {"__builtins__": {}}, env)  # noqa: S102


class Engine:
    """Drives a spec-defined state machine with a deterministic stream."""

    def __init__(self, spec, seed):
        self.spec = spec
        self.seed = seed
        self.stream = Stream(seed)
        self.state = spec["initial"]
        self.vars = dict(spec.get("vars", {}))
        self.prev_digest = _sha(canonical({"seed": seed, "spec": spec}))
        self.path = []

    def available_ops(self):
        names = self.spec["transitions"].get(self.state, [])
        available = []
        for name in sorted(names):
            guard = self.spec["ops"][name].get("guard")
            if guard is None or _eval(guard, self.vars):
                available.append(name)
        return available

    def step(self, index):
        """Advance one step.

        Returns ``(record, violations)`` or ``None`` when no op is
        available (the machine halts).
        """
        available = self.available_ops()
        if not available:
            return None
        if len(available) == 1:
            name = available[0]
        else:
            name = self.stream.choice(available)
        op = self.spec["ops"][name]

        args = {}
        for arg_name in sorted(op.get("args", {})):
            arg = op["args"][arg_name]
            if arg["kind"] == "int":
                args[arg_name] = self.stream.randint(arg["lo"], arg["hi"])
            else:
                args[arg_name] = self.stream.choice(list(arg["options"]))

        fork = op.get("fork")
        if fork is not None:
            child = self.stream.fork(fork["name"])
            args["fork"] = fork["name"]
            args["fork_results"] = [
                child.randrange(_FORK_DRAW_MODULUS) for _ in range(fork["draws"])
            ]

        effect = op.get("effect")
        if effect:
            env = dict(self.vars)
            env.update(args)
            _exec(effect, env)
            self.vars = {key: env[key] for key in self.vars}

        self.state = op.get("to", self.state)
        digest = _sha(
            self.prev_digest
            + "|"
            + canonical({"step": index, "state": self.state, "vars": self.vars})
        )
        self.prev_digest = digest

        record = {
            "type": "step",
            "step": index,
            "op": name,
            "args": args,
            "state": self.state,
            "digest": digest,
        }
        self.path.append({"step": index, "op": name, "args": args})
        violations = [
            inv
            for inv in self.spec.get("invariants", [])
            if not _eval(inv, self.vars)
        ]
        return record, violations


def run_engine(spec, seed, steps):
    """Run the engine; returns ``(engine, step_records, result_line)``."""
    engine = Engine(spec, seed)
    records = []
    status = "ok"
    invariant = None
    steps_run = 0
    for index in range(steps):
        outcome = engine.step(index)
        if outcome is None:
            status = "halted"
            break
        record, violations = outcome
        records.append(record)
        steps_run = index + 1
        if violations:
            status = "invariant_violation"
            invariant = violations[0]
            break
    result_line = {
        "type": "result",
        "status": status,
        "steps_run": steps_run,
        "last_digest": engine.prev_digest,
    }
    if invariant is not None:
        result_line["invariant"] = invariant
    return engine, records, result_line


def header_line(spec, seed, steps):
    return {
        "type": "header",
        "version": RECORD_VERSION,
        "seed": seed,
        "steps": steps,
        "spec": spec,
        "spec_digest": _sha(canonical(spec)),
    }
