"""Deterministic operation-stream engine.

Determinism rules:
- The only random source is ``random.Random`` instances.
- No wall-clock time, no pid, no ``hash()`` of str/bytes (hash randomization).
  All derivation uses ``hashlib.sha256`` over explicit byte strings.
- All JSON output uses sorted keys and fixed separators so bytes are
  identical across processes and across PYTHONHASHSEED values.
"""

from __future__ import annotations

import copy
import hashlib
import json
import random

from .errors import DivergeError, ReplayError, SpecError

FORMAT = "detrand/1"
FORK_DOMAIN = b"detrand-fork-v1\x00"

SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "int": int,
    "len": len,
    "max": max,
    "min": min,
    "sorted": sorted,
    "str": str,
    "sum": sum,
}

OP_KINDS = ("int", "choice", "fork")


def canonical(obj) -> str:
    """Canonical JSON: byte-identical for equal values on any process."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def digest_of(state) -> str:
    try:
        blob = canonical(state)
    except (TypeError, ValueError) as exc:
        raise SpecError(f"state is not JSON-serializable: {exc}") from exc
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def spec_hash(spec) -> str:
    return hashlib.sha256(canonical(spec).encode("utf-8")).hexdigest()


def derive_child_seed(parent_seed: int, position: int, name: str) -> int:
    """Child seed from parent stream position and fork name.

    Pure function of (parent_seed, position, name); consumes nothing from
    the parent's ``random.Random`` stream.
    """
    h = hashlib.sha256()
    h.update(FORK_DOMAIN)
    h.update(str(parent_seed).encode("ascii"))
    h.update(b"\x00")
    h.update(str(position).encode("ascii"))
    h.update(b"\x00")
    h.update(name.encode("utf-8"))
    return int.from_bytes(h.digest()[:16], "big")


# ---------------------------------------------------------------- spec loading

def _require(cond, msg):
    if not cond:
        raise SpecError(msg)


def _validate_op(op, ctx, allow_fork):
    _require(isinstance(op, dict), f"{ctx}: op must be an object")
    name = op.get("name")
    _require(isinstance(name, str) and name, f"{ctx}: op needs a non-empty string 'name'")
    kind = op.get("kind")
    _require(kind in OP_KINDS, f"{ctx} op {name!r}: kind must be one of {OP_KINDS}")
    if kind == "int":
        _require(isinstance(op.get("min"), int) and isinstance(op.get("max"), int),
                 f"{ctx} op {name!r}: int op needs integer 'min' and 'max'")
        _require(op["min"] <= op["max"], f"{ctx} op {name!r}: min > max")
    elif kind == "choice":
        choices = op.get("choices")
        _require(isinstance(choices, list) and len(choices) > 0,
                 f"{ctx} op {name!r}: choice op needs a non-empty 'choices' list")
    else:  # fork
        _require(allow_fork, f"{ctx} op {name!r}: nested fork ops are not supported")
        _require(isinstance(op.get("substeps"), int) and op["substeps"] >= 1,
                 f"{ctx} op {name!r}: fork op needs integer 'substeps' >= 1")
        subops = op.get("subops")
        _require(isinstance(subops, list) and len(subops) > 0,
                 f"{ctx} op {name!r}: fork op needs a non-empty 'subops' list")
        seen = set()
        for i, sub in enumerate(subops):
            _validate_op(sub, f"{ctx} op {name!r} subops[{i}]", allow_fork=False)
            _require(sub["kind"] != "fork",
                     f"{ctx} op {name!r} subops[{i}]: nested fork not supported")
            _require(sub["name"] not in seen,
                     f"{ctx} op {name!r}: duplicate subop name {sub['name']!r}")
            seen.add(sub["name"])
        return
    apply_expr = op.get("apply")
    _require(isinstance(apply_expr, str) and apply_expr.strip(),
             f"{ctx} op {name!r}: op needs a non-empty string 'apply'")
    try:
        compile(apply_expr, "<apply>", "exec")
    except SyntaxError as exc:
        raise SpecError(f"{ctx} op {name!r}: bad apply expression: {exc}") from exc


def validate_spec(spec):
    _require(isinstance(spec, dict), "spec must be a JSON object")
    _require("initial" in spec and isinstance(spec["initial"], dict),
             "spec needs an 'initial' object")
    ops = spec.get("ops")
    _require(isinstance(ops, list) and len(ops) > 0, "spec needs a non-empty 'ops' list")
    seen = set()
    for i, op in enumerate(ops):
        _validate_op(op, f"ops[{i}]", allow_fork=True)
        _require(op["name"] not in seen, f"duplicate op name {op['name']!r}")
        seen.add(op["name"])
    invariants = spec.get("invariants", [])
    _require(isinstance(invariants, list) and all(isinstance(x, str) for x in invariants),
             "'invariants' must be a list of strings")
    for inv in invariants:
        try:
            compile(inv, "<invariant>", "eval")
        except SyntaxError as exc:
            raise SpecError(f"bad invariant expression: {exc}") from exc
    try:
        canonical(spec["initial"])
    except (TypeError, ValueError) as exc:
        raise SpecError(f"'initial' is not JSON-serializable: {exc}") from exc
    return spec


def load_spec(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except OSError as exc:
        raise SpecError(f"cannot read spec {path!r}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SpecError(f"spec {path!r} is not valid JSON: {exc}") from exc
    return validate_spec(spec)


# ------------------------------------------------------------------- engine

class InvariantViolation(Exception):
    def __init__(self, record, invariant):
        super().__init__(invariant)
        self.record = record
        self.invariant = invariant


class Engine:
    """Drives a spec state machine with a deterministic op stream."""

    def __init__(self, spec, seed):
        self.spec = spec
        self.seed = seed
        self.rng = random.Random(seed)
        self.state = copy.deepcopy(spec["initial"])

    def _gen_simple_args(self, rng, op):
        if op["kind"] == "int":
            return {"value": rng.randint(op["min"], op["max"])}
        return {"value": op["choices"][rng.randrange(len(op["choices"]))]}

    def _gen_args(self, op, index):
        if op["kind"] != "fork":
            return self._gen_simple_args(self.rng, op)
        child_seed = derive_child_seed(self.seed, index, op["name"])
        child_rng = random.Random(child_seed)
        subops = op["subops"]
        steps = []
        for _ in range(op["substeps"]):
            sub = subops[child_rng.randrange(len(subops))]
            steps.append({"op": sub["name"], "args": self._gen_simple_args(child_rng, sub)})
        return {"seed": child_seed, "steps": steps}

    def _eval_apply(self, expr, arg):
        env = {"state": self.state, "arg": arg}
        eval(compile(expr, "<apply>", "exec"), {"__builtins__": dict(SAFE_BUILTINS)}, env)

    def _apply(self, op, args):
        if op["kind"] == "fork":
            by_name = {sub["name"]: sub for sub in op["subops"]}
            for sub_step in args["steps"]:
                self._eval_apply(by_name[sub_step["op"]]["apply"], sub_step["args"]["value"])
        else:
            self._eval_apply(op["apply"], args["value"])

    def _check_invariants(self):
        for inv in self.spec.get("invariants", []):
            ok = eval(compile(inv, "<invariant>", "eval"),
                      {"__builtins__": dict(SAFE_BUILTINS)}, {"state": self.state})
            if not ok:
                return inv
        return None

    def step(self, index):
        """Advance one step; returns the step record.

        Raises InvariantViolation (carrying the record) if a post-step
        invariant fails.
        """
        ops = self.spec["ops"]
        op = ops[self.rng.randrange(len(ops))]
        args = self._gen_args(op, index)
        self._apply(op, args)
        record = {"index": index, "op": op["name"], "args": args,
                  "digest": digest_of(self.state)}
        bad = self._check_invariants()
        if bad is not None:
            raise InvariantViolation(record, bad)
        return record


# ------------------------------------------------------------------ run

def _write_line(fh, obj):
    fh.write(canonical(obj) + "\n")


def write_failure_file(path, info):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(canonical(info) + "\n")


def run_command(spec_path, seed, steps, record_path, failure_path):
    spec = load_spec(spec_path)
    if steps < 0:
        raise SpecError("--steps must be >= 0")
    engine = Engine(spec, seed)
    with open(record_path, "w", encoding="utf-8") as fh:
        _write_line(fh, {"type": "header", "format": FORMAT, "seed": seed,
                         "steps": steps, "spec": spec, "spec_hash": spec_hash(spec)})
        for index in range(steps):
            try:
                record = engine.step(index)
            except InvariantViolation as exc:
                _write_line(fh, {"type": "step", **exc.record})
                _write_line(fh, {"type": "failure", "reason": "invariant_violation",
                                 "step": index, "invariant": exc.invariant,
                                 "digest": exc.record["digest"]})
                write_failure_file(failure_path, {
                    "error": "E_DIVERGE", "reason": "invariant_violation",
                    "seed": seed, "path": record_path,
                    "last_digest": exc.record["digest"], "step": index,
                    "invariant": exc.invariant})
                raise DivergeError(
                    f"invariant violated at step {index}: {exc.invariant!r} "
                    f"(failure archived to {failure_path})") from exc
            _write_line(fh, {"type": "step", **record})
        _write_line(fh, {"type": "final", "steps": steps,
                         "digest": digest_of(engine.state)})


# ------------------------------------------------------------------ replay

def _load_record(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise ReplayError(f"cannot read record {path!r}: {exc}") from exc
    records = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ReplayError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
    if not records:
        raise ReplayError(f"{path}: empty record")
    return records


def _compare_step(expected, got, path):
    for key in ("index", "op", "args", "digest"):
        if got.get(key) != expected[key]:
            raise DivergeError(
                f"{path}: step {expected['index']} diverges on {key!r}: "
                f"recorded {got.get(key)!r} != recomputed {expected[key]!r}")


def replay_command(record_path, failure_path):
    records = _load_record(record_path)
    header = records[0]
    if not isinstance(header, dict) or header.get("type") != "header":
        raise ReplayError(f"{record_path}: first line must be a header")
    if header.get("format") != FORMAT:
        raise ReplayError(f"{record_path}: unsupported format {header.get('format')!r}")
    spec = header.get("spec")
    seed = header.get("seed")
    if spec is None or not isinstance(seed, int):
        raise ReplayError(f"{record_path}: header missing 'spec' or 'seed'")
    try:
        validate_spec(spec)
    except SpecError as exc:
        raise ReplayError(f"{record_path}: embedded spec invalid: {exc}") from exc
    if spec_hash(spec) != header.get("spec_hash"):
        raise DivergeError(f"{record_path}: header spec_hash does not match embedded spec")

    engine = Engine(spec, seed)
    steps_seen = 0
    pending_failure = None
    saw_terminal = False
    for obj in records[1:]:
        if not isinstance(obj, dict):
            raise ReplayError(f"{record_path}: record line must be a JSON object")
        rtype = obj.get("type")
        if saw_terminal:
            raise ReplayError(f"{record_path}: records found after terminal line")
        if pending_failure is not None and rtype != "failure":
            raise DivergeError(
                f"{record_path}: invariant violated at step {steps_seen - 1} "
                f"but record has no failure line")
        if rtype == "step":
            try:
                record = engine.step(steps_seen)
            except InvariantViolation as exc:
                record = exc.record
                pending_failure = exc
            _compare_step(record, obj, record_path)
            steps_seen += 1
        elif rtype == "failure":
            if pending_failure is None:
                raise DivergeError(
                    f"{record_path}: recorded failure at step {obj.get('step')} "
                    f"does not reproduce")
            if obj.get("reason") != "invariant_violation" or \
                    obj.get("step") != steps_seen - 1 or \
                    obj.get("digest") != pending_failure.record["digest"]:
                raise DivergeError(f"{record_path}: failure line does not match recomputation")
            write_failure_file(failure_path, {
                "error": "E_DIVERGE", "reason": "invariant_violation",
                "seed": seed, "path": record_path,
                "last_digest": pending_failure.record["digest"],
                "step": steps_seen - 1, "invariant": pending_failure.invariant})
            raise DivergeError(
                f"invariant violation reproduced at step {steps_seen - 1}: "
                f"{pending_failure.invariant!r} (failure archived to {failure_path})")
        elif rtype == "final":
            if obj.get("digest") != digest_of(engine.state):
                raise DivergeError(f"{record_path}: final digest mismatch")
            if obj.get("steps") != steps_seen:
                raise DivergeError(
                    f"{record_path}: final step count {obj.get('steps')} != {steps_seen}")
            saw_terminal = True
        else:
            raise ReplayError(f"{record_path}: unknown record type {rtype!r}")
    if pending_failure is not None:
        raise DivergeError(
            f"{record_path}: invariant violated at step {steps_seen - 1} "
            f"but record has no failure line")
    if not saw_terminal:
        raise ReplayError(f"{record_path}: record is truncated (no final line)")
