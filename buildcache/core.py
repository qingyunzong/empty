"""Core build-cache logic.

Layout of a project directory::

    manifest.json           declares targets: {name: {"src": [...], "cmd": "echo ..."}}
    .buildcache/state.json  persisted build state (target -> fingerprint/status)
    .buildcache/journal.json  crash-recovery journal for the in-flight target

Semantics:
  * Fingerprint = SHA256(target path + src file paths/contents + dependency
    target fingerprints).  mtime is never consulted.
  * A target is rewritten only when its fingerprint changes; the rewrite goes
    to a tmp file first and is then atomically renamed into place.
  * Two crash points are handled on restart: (1) tmp written but not renamed
    -> the tmp file is rolled back; (2) renamed but state not updated -> the
    state record is back-filled from the journal.  A half-written target
    artifact is never visible.
  * A target whose source is missing is marked STALE; its old artifact is
    kept untouched.
  * clean removes only artifacts declared in the manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

CACHE_DIR = ".buildcache"
STATE_NAME = "state.json"
JOURNAL_NAME = "journal.json"
TMP_SUFFIX = ".tmp"

STATUS_OK = "OK"
STATUS_STALE = "STALE"


class ManifestError(Exception):
    """manifest.json is missing, malformed, or semantically invalid."""


class CycleError(Exception):
    """The target dependency graph contains a cycle."""


class WriteFailure(Exception):
    """A filesystem write (tmp, rename, state, journal) failed."""


# ---------------------------------------------------------------------------
# manifest


def _check_rel_path(root: Path, rel: str, what: str) -> None:
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts:
        raise ManifestError(f"{what} must be a relative path inside the project: {rel!r}")


def load_manifest(root: Path) -> dict:
    path = root / "manifest.json"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ManifestError(f"manifest not found: {path}")
    except OSError as exc:
        raise ManifestError(f"cannot read manifest: {exc}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ManifestError(f"manifest is not valid JSON: {exc}")
    if not isinstance(data, dict) or not data:
        raise ManifestError("manifest must be a non-empty JSON object of targets")
    targets = {}
    for name, spec in data.items():
        if not isinstance(name, str) or not name:
            raise ManifestError("target names must be non-empty strings")
        _check_rel_path(root, name, "target name")
        if not isinstance(spec, dict):
            raise ManifestError(f"target {name!r}: spec must be an object")
        src = spec.get("src")
        cmd = spec.get("cmd")
        if not isinstance(src, list) or not all(isinstance(s, str) for s in src):
            raise ManifestError(f"target {name!r}: 'src' must be a list of strings")
        if not isinstance(cmd, str) or not cmd:
            raise ManifestError(f"target {name!r}: 'cmd' must be a non-empty string")
        for s in src:
            _check_rel_path(root, s, f"target {name!r} src")
        targets[name] = {"src": list(src), "cmd": cmd}
    return targets


def topo_order(targets: dict) -> list:
    """Return target names in dependency order; raise CycleError on cycles."""
    order: list = []
    done: set = set()
    visiting: list = []

    def visit(name: str) -> None:
        if name in done:
            return
        if name in visiting:
            cycle = visiting[visiting.index(name):] + [name]
            raise CycleError("dependency cycle: " + " -> ".join(cycle))
        visiting.append(name)
        for s in targets[name]["src"]:
            if s in targets:
                visit(s)
        visiting.pop()
        done.add(name)
        order.append(name)

    for name in targets:
        visit(name)
    return order


# ---------------------------------------------------------------------------
# fingerprints


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compute_fingerprints(root: Path, targets: dict, order: list):
    """Compute (fingerprint, status) per target, in dependency order.

    Fingerprint = SHA256(target path + per-src path/content hashes + dep
    target fingerprints).  STALE propagates from missing sources and from
    stale dependencies.
    """
    fps: dict = {}
    status: dict = {}
    for name in order:
        spec = targets[name]
        h = hashlib.sha256()
        h.update(b"target\0")
        h.update(name.encode("utf-8"))
        h.update(b"\0")
        stale = False
        for s in spec["src"]:
            if s in targets:
                h.update(b"dep\0")
                h.update(s.encode("utf-8"))
                h.update(b"\0")
                h.update(fps[s].encode("ascii"))
                h.update(b"\0")
                if status[s] == STATUS_STALE:
                    stale = True
            else:
                p = root / s
                if p.is_file():
                    h.update(b"file\0")
                    h.update(s.encode("utf-8"))
                    h.update(b"\0")
                    h.update(_sha256(p.read_bytes()).encode("ascii"))
                    h.update(b"\0")
                else:
                    stale = True
        fps[name] = h.hexdigest()
        status[name] = STATUS_STALE if stale else STATUS_OK
    return fps, status


def simulate_output(root: Path, targets: dict, name: str) -> bytes:
    """Simulate the command: product is the text concatenation of inputs.

    File sources contribute their own bytes; target sources contribute the
    dependency's current artifact bytes (dependencies build first).
    """
    parts = []
    for s in targets[name]["src"]:
        p = root / s
        if p.is_file():
            parts.append(p.read_bytes())
    return b"".join(parts)


# ---------------------------------------------------------------------------
# state / journal persistence


def _cache_dir(root: Path) -> Path:
    return root / CACHE_DIR


def _atomic_write_json(path: Path, obj) -> None:
    tmp = path.with_name(path.name + TMP_SUFFIX)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(obj, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        raise WriteFailure(f"cannot write {path}: {exc}")


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def load_state(root: Path) -> dict:
    state = _read_json(_cache_dir(root) / STATE_NAME)
    return state if isinstance(state, dict) else {}


def save_state(root: Path, state: dict) -> None:
    _atomic_write_json(_cache_dir(root) / STATE_NAME, state)


def _write_journal(root: Path, entry: dict) -> None:
    _atomic_write_json(_cache_dir(root) / JOURNAL_NAME, entry)


def _clear_journal(root: Path) -> None:
    try:
        (_cache_dir(root) / JOURNAL_NAME).unlink(missing_ok=True)
    except OSError as exc:
        raise WriteFailure(f"cannot clear journal: {exc}")


# ---------------------------------------------------------------------------
# crash recovery


def recover(root: Path) -> list:
    """Resolve any interrupted build.  Returns a list of human-readable actions.

    * journal phase "tmp_written": the tmp file was never renamed -> roll it
      back (delete tmp) so no half product can be picked up.
    * journal phase "renamed": the artifact is already atomically in place but
      the state was not updated -> back-fill the state record from the journal.
    """
    actions = []
    journal = _read_json(_cache_dir(root) / JOURNAL_NAME)
    if not isinstance(journal, dict):
        return actions
    phase = journal.get("phase")
    name = journal.get("target")
    tmp_rel = journal.get("tmp")
    if phase == "tmp_written":
        if tmp_rel:
            try:
                (root / tmp_rel).unlink(missing_ok=True)
            except OSError as exc:
                raise WriteFailure(f"cannot roll back tmp file: {exc}")
        _clear_journal(root)
        actions.append(f"recovered: rolled back tmp for {name}")
    elif phase == "renamed":
        state = load_state(root)
        state[name] = {
            "fingerprint": journal.get("fingerprint"),
            "artifact": name,
            "status": STATUS_OK,
        }
        save_state(root, state)
        _clear_journal(root)
        actions.append(f"recovered: back-filled state for {name}")
    else:
        _clear_journal(root)
        actions.append("recovered: discarded unknown journal entry")
    return actions


# ---------------------------------------------------------------------------
# scan / build / clean


def scan(root: Path):
    """Inspect targets without building.  Returns a list of report dicts."""
    targets = load_manifest(root)
    order = topo_order(targets)
    recover(root)
    fps, status = compute_fingerprints(root, targets, order)
    state = load_state(root)
    report = []
    for name in order:
        recorded = state.get(name, {})
        artifact = root / name
        if status[name] == STATUS_STALE:
            disposition = "stale (old artifact kept)"
        elif recorded.get("fingerprint") != fps[name] or not artifact.is_file():
            disposition = "dirty"
        else:
            disposition = "up-to-date"
        report.append({
            "target": name,
            "status": status[name],
            "disposition": disposition,
            "fingerprint": fps[name],
        })
    return report


def build(root: Path, crash_hook=None) -> list:
    """Build dirty targets in dependency order.  Returns log lines.

    ``crash_hook(point, context)`` is invoked at the two defined crash points
    ("before_rename", "after_rename"); used by tests/CLI to simulate crashes.
    """
    targets = load_manifest(root)
    order = topo_order(targets)
    log = recover(root)
    fps, status = compute_fingerprints(root, targets, order)
    state = load_state(root)

    for name in order:
        if status[name] == STATUS_STALE:
            entry = state.get(name, {})
            state[name] = {
                "fingerprint": entry.get("fingerprint"),
                "artifact": name,
                "status": STATUS_STALE,
            }
            log.append(f"STALE {name} (source missing, old artifact kept)")
            continue
        recorded = state.get(name, {})
        artifact = root / name
        if recorded.get("fingerprint") == fps[name] and artifact.is_file():
            log.append(f"UP-TO-DATE {name}")
            continue

        content = simulate_output(root, targets, name)
        tmp_rel = name + TMP_SUFFIX
        tmp = root / tmp_rel
        try:
            artifact.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise WriteFailure(f"cannot create directory for {name}: {exc}")

        # Journal the intent first so a crash anywhere below is recoverable.
        _write_journal(root, {
            "phase": "tmp_written",
            "target": name,
            "tmp": tmp_rel,
            "fingerprint": fps[name],
        })
        try:
            tmp.write_bytes(content)
        except OSError as exc:
            raise WriteFailure(f"cannot write tmp for {name}: {exc}")

        if crash_hook:
            crash_hook("before_rename", {"target": name, "tmp": tmp_rel})

        try:
            os.replace(tmp, artifact)
        except OSError as exc:
            raise WriteFailure(f"cannot rename {tmp_rel} -> {name}: {exc}")

        _write_journal(root, {
            "phase": "renamed",
            "target": name,
            "tmp": tmp_rel,
            "fingerprint": fps[name],
        })

        if crash_hook:
            crash_hook("after_rename", {"target": name})

        state[name] = {
            "fingerprint": fps[name],
            "artifact": name,
            "status": STATUS_OK,
        }
        save_state(root, state)
        _clear_journal(root)
        log.append(f"BUILD {name}")

    save_state(root, state)
    return log


def clean(root: Path) -> list:
    """Remove only artifacts declared in the manifest (plus cache metadata)."""
    targets = load_manifest(root)
    topo_order(targets)  # validate graph for consistency with build
    recover(root)
    log = []
    for name in targets:
        for rel in (name, name + TMP_SUFFIX):
            p = root / rel
            try:
                if p.is_file():
                    p.unlink()
                    log.append(f"REMOVE {rel}")
            except OSError as exc:
                raise WriteFailure(f"cannot remove {rel}: {exc}")
    cache = _cache_dir(root)
    if cache.is_dir():
        for child in sorted(cache.iterdir()):
            try:
                if child.is_file():
                    child.unlink()
            except OSError as exc:
                raise WriteFailure(f"cannot remove {child}: {exc}")
        try:
            cache.rmdir()
        except OSError:
            pass
    log.append("CLEAN done")
    return log
