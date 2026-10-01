"""Shared helpers for the mmcheck test suite."""
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = ".mmcheck.json"
DIAG_RE = re.compile(r"^#(\d+) (\S+):(\d+): (E_[A-Z]+): (.*)$")


def write_project(root, files):
    os.makedirs(root, exist_ok=True)
    for name, content in files.items():
        with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
            fh.write(content)


def write_file(path, content):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def run_cli(args, cwd):
    env = os.environ.copy()
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "mmcheck", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
    )


def parse_diagnostics(output):
    """Parse '#id file:line: CODE: message' lines from CLI output."""
    diags = []
    for line in output.splitlines():
        m = DIAG_RE.match(line)
        if m:
            diags.append({
                "id": int(m.group(1)),
                "file": m.group(2),
                "line": int(m.group(3)),
                "code": m.group(4),
                "message": m.group(5),
            })
    return diags


def diag_set(diags):
    """Diagnostic identity ignoring the (session-dependent) id."""
    return {(d["file"], d["line"], d["code"], d["message"]) for d in diags}


def parse_rechecked(output):
    for line in output.splitlines():
        if line.startswith("rechecked: "):
            return set(line[len("rechecked: "):].split(", "))
    return set()


def read_state(cwd):
    with open(os.path.join(cwd, STATE_FILE), encoding="utf-8") as fh:
        return json.load(fh)


def state_diag_entries(state, module):
    """(id, line, code, message) tuples for one module in a state dict."""
    return [
        (d["id"], d["line"], d["code"], d["message"])
        for d in state["modules"][module]["diagnostics"]
    ]
