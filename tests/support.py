import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "netsim", *args],
        cwd=REPO_ROOT, capture_output=True, text=True)


def write_json(directory, name, data):
    path = Path(directory) / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


def parse_jsonl(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def mesh_topo(node_ids, delay=5, **node_kw):
    nodes = []
    for nid in node_ids:
        cfg = {"id": nid}
        cfg.update(node_kw.get(nid, {}))
        nodes.append(cfg)
    links = [{"src": a, "dst": b, "delay": delay}
             for a in node_ids for b in node_ids if a != b]
    return {"nodes": nodes, "links": links, "workload": []}


class TempConfig:
    """Context manager handing out a temp dir for config files."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        return self

    def __exit__(self, *exc):
        self._tmp.cleanup()

    def write(self, name, data):
        return write_json(self.dir, name, data)
