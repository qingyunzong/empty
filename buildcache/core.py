"""Core build-cache engine.

Semantics implemented here:

* Target fingerprint = SHA256 over (src path + src content) and dependency
  fingerprints.  File mtimes are never consulted.
* A target's output is the deterministic textual concatenation of its
  dependency outputs (in ``deps`` order) followed by its source file
  contents (in ``src`` order).  ``cmd`` is declarative only; execution is
  simulated.
* Rewrites go through ``<output>.tmp`` + ``os.replace`` and the state file
  is persisted atomically after every target, so a crash can only leave
  two well-defined fault points:
    1. tmp written, rename not done   -> restart rolls the tmp back.
    2. rename done, state not updated -> restart re-records the state
       (the output content is verified against the deterministic product
       before being adopted, so a half-written target is never kept).
* A target with a missing source is STALE; its old output is preserved.
* ``clean`` removes only artifacts recorded in the state manifest or
  declared as targets in ``manifest.json``.
"""

from __future__ import annotations

import hashlib
import json
import os

STATE_DIRNAME = ".buildcache"
STATE_FILENAME = "state.json"
MANIFEST_FILENAME = "manifest.json"
FAULT_ENV = "BUILDCACHE_FAULT"


class ManifestError(Exception):
    """manifest.json is missing, malformed, or semantically invalid."""


class CycleError(Exception):
    """The target dependency graph contains a cycle."""


class WriteError(Exception):
    """An output or state file could not be written."""


class CrashFault(Exception):
    """Simulated crash injected at a defined fault point (testing)."""


def _fault(point: str, target: str) -> None:
    spec = os.environ.get(FAULT_ENV)
    if not spec:
        return
    parts = spec.split(":", 1)
    if parts[0] == point and (len(parts) == 1 or parts[1] == target):
        raise CrashFault(f"simulated crash at {point} for target {target!r}")


# ---------------------------------------------------------------------------
# manifest / state loading
# ---------------------------------------------------------------------------

def load_manifest(project_dir: str) -> dict:
    path = os.path.join(project_dir, MANIFEST_FILENAME)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise ManifestError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ManifestError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("targets"), dict):
        raise ManifestError("manifest must be an object with a 'targets' object")
    manifest: dict = {}
    for name, spec in data["targets"].items():
        if not isinstance(name, str) or not name:
            raise ManifestError("target names must be non-empty strings")
        if not isinstance(spec, dict):
            raise ManifestError(f"target {name!r} must be an object")
        src = spec.get("src", [])
        deps = spec.get("deps", [])
        cmd = spec.get("cmd", "echo")
        if not _is_str_list(src):
            raise ManifestError(f"target {name!r}: 'src' must be a list of strings")
        if not _is_str_list(deps):
            raise ManifestError(f"target {name!r}: 'deps' must be a list of strings")
        if not isinstance(cmd, str):
            raise ManifestError(f"target {name!r}: 'cmd' must be a string")
        manifest[name] = {"src": list(src), "deps": list(deps), "cmd": cmd}
    for name, spec in manifest.items():
        for dep in spec["deps"]:
            if dep not in manifest:
                raise ManifestError(f"target {name!r}: unknown dependency {dep!r}")
    return manifest


def _is_str_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _state_path(project_dir: str) -> str:
    return os.path.join(project_dir, STATE_DIRNAME, STATE_FILENAME)


def _load_state(project_dir: str) -> dict:
    try:
        with open(_state_path(project_dir), "r", encoding="utf-8") as fh:
            state = json.load(fh)
        if isinstance(state, dict) and isinstance(state.get("targets"), dict):
            return state
    except (OSError, json.JSONDecodeError):
        pass
    return {"targets": {}}


def _save_state(project_dir: str, state: dict) -> None:
    state_dir = os.path.join(project_dir, STATE_DIRNAME)
    try:
        os.makedirs(state_dir, exist_ok=True)
        tmp = _state_path(project_dir) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, _state_path(project_dir))
    except OSError as exc:
        raise WriteError(f"cannot write state file: {exc}") from exc


# ---------------------------------------------------------------------------
# fingerprints
# ---------------------------------------------------------------------------

def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _topo_order(manifest: dict) -> list:
    order: list = []
    done: set = set()
    visiting: list = []

    def visit(name: str) -> None:
        if name in done:
            return
        if name in visiting:
            cycle = " -> ".join(visiting[visiting.index(name):] + [name])
            raise CycleError(f"dependency cycle: {cycle}")
        visiting.append(name)
        for dep in manifest[name]["deps"]:
            visit(dep)
        visiting.pop()
        done.add(name)
        order.append(name)

    for name in manifest:
        visit(name)
    return order


def _fingerprint_targets(manifest: dict, project_dir: str, order: list):
    """Return (fingerprints, missing_sources) keyed by target name.

    A target with a missing source gets fingerprint ``None`` (STALE).
    """
    fingerprints: dict = {}
    missing: dict = {}
    for name in order:
        spec = manifest[name]
        digest = hashlib.sha256()
        absent = []
        for dep in spec["deps"]:
            dep_fp = fingerprints[dep] or "STALE"
            digest.update(b"D\0" + dep.encode("utf-8") + b"\0")
            digest.update(dep_fp.encode("ascii") + b"\n")
        for src in spec["src"]:
            path = os.path.join(project_dir, src)
            if not os.path.isfile(path):
                absent.append(src)
                continue
            digest.update(b"F\0" + src.encode("utf-8") + b"\0")
            digest.update(_sha256_file(path).encode("ascii") + b"\n")
        missing[name] = absent
        fingerprints[name] = None if absent else digest.hexdigest()
    return fingerprints, missing


# ---------------------------------------------------------------------------
# simulated build product
# ---------------------------------------------------------------------------

def output_relpath(name: str) -> str:
    return name


def _output_path(project_dir: str, name: str) -> str:
    return os.path.join(project_dir, output_relpath(name))


def _simulate_product(manifest: dict, project_dir: str, name: str):
    """Deterministic product text, or None if inputs are unavailable."""
    spec = manifest[name]
    parts = []
    for dep in spec["deps"]:
        path = _output_path(project_dir, dep)
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as fh:
            parts.append(fh.read())
    for src in spec["src"]:
        path = os.path.join(project_dir, src)
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as fh:
            parts.append(fh.read())
    return "".join(parts)


# ---------------------------------------------------------------------------
# crash recovery
# ---------------------------------------------------------------------------

def _known_outputs(manifest: dict, state: dict) -> set:
    outputs = {output_relpath(name) for name in manifest}
    for record in state.get("targets", {}).values():
        if isinstance(record, dict) and isinstance(record.get("output"), str):
            outputs.add(record["output"])
    return outputs


def _rollback_tmp_files(project_dir: str, manifest: dict, state: dict) -> list:
    """Fault point 1: tmp written but rename never happened -> delete tmp."""
    removed = []
    for rel in sorted(_known_outputs(manifest, state)):
        tmp = os.path.join(project_dir, rel + ".tmp")
        if os.path.isfile(tmp):
            os.unlink(tmp)
            removed.append(rel + ".tmp")
    return removed


# ---------------------------------------------------------------------------
# public operations
# ---------------------------------------------------------------------------

def build(project_dir: str) -> dict:
    """Incrementally build all targets; returns {target: status}."""
    manifest = load_manifest(project_dir)
    state = _load_state(project_dir)
    _rollback_tmp_files(project_dir, manifest, state)
    order = _topo_order(manifest)
    fingerprints, missing = _fingerprint_targets(manifest, project_dir, order)

    results: dict = {}
    for name in order:
        if missing[name]:
            results[name] = "STALE"
            continue
        fingerprint = fingerprints[name]
        record = state["targets"].get(name)
        out_path = _output_path(project_dir, name)
        if (
            record
            and record.get("fingerprint") == fingerprint
            and os.path.isfile(out_path)
        ):
            results[name] = "OK"
            continue
        product = _simulate_product(manifest, project_dir, name)
        if product is None:
            results[name] = "STALE"
            continue
        if os.path.isfile(out_path):
            with open(out_path, "r", encoding="utf-8") as fh:
                existing = fh.read()
            if existing == product:
                # Fault point 2: rename completed but the state update was
                # lost -> adopt the verified output and re-record the state.
                state["targets"][name] = {
                    "fingerprint": fingerprint,
                    "output": output_relpath(name),
                }
                _save_state(project_dir, state)
                results[name] = "RECOVERED"
                continue
        tmp_path = out_path + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                fh.write(product)
        except OSError as exc:
            raise WriteError(f"cannot write {tmp_path}: {exc}") from exc
        _fault("before_rename", name)
        try:
            os.replace(tmp_path, out_path)
        except OSError as exc:
            raise WriteError(f"cannot rename {tmp_path} -> {out_path}: {exc}") from exc
        _fault("after_rename", name)
        state["targets"][name] = {
            "fingerprint": fingerprint,
            "output": output_relpath(name),
        }
        _save_state(project_dir, state)
        results[name] = "BUILT"
    return results


def scan(project_dir: str) -> dict:
    """Report per-target status without building; recovers crash residue."""
    manifest = load_manifest(project_dir)
    state = _load_state(project_dir)
    _rollback_tmp_files(project_dir, manifest, state)
    order = _topo_order(manifest)
    fingerprints, missing = _fingerprint_targets(manifest, project_dir, order)

    report: dict = {}
    for name in order:
        record = state["targets"].get(name)
        out_path = _output_path(project_dir, name)
        if missing[name]:
            status = "STALE"
        elif not os.path.isfile(out_path):
            status = "UNBUILT"
        elif record and record.get("fingerprint") == fingerprints[name]:
            status = "OK"
        else:
            status = "OUTDATED"
        report[name] = {
            "status": status,
            "fingerprint": fingerprints[name],
            "missing": missing[name],
        }
    return report


def clean(project_dir: str) -> list:
    """Remove only artifacts listed in the state/build manifest."""
    try:
        manifest = load_manifest(project_dir)
    except ManifestError:
        manifest = {}
    state = _load_state(project_dir)
    removed = []
    for rel in sorted(_known_outputs(manifest, state)):
        for path in (os.path.join(project_dir, rel),
                     os.path.join(project_dir, rel + ".tmp")):
            if os.path.isfile(path):
                os.unlink(path)
                removed.append(os.path.relpath(path, project_dir))
    state_file = _state_path(project_dir)
    if os.path.isfile(state_file):
        os.unlink(state_file)
        removed.append(os.path.relpath(state_file, project_dir))
    state_tmp = state_file + ".tmp"
    if os.path.isfile(state_tmp):
        os.unlink(state_tmp)
        removed.append(os.path.relpath(state_tmp, project_dir))
    state_dir = os.path.join(project_dir, STATE_DIRNAME)
    if os.path.isdir(state_dir) and not os.listdir(state_dir):
        os.rmdir(state_dir)
    return removed
