import json
import os
import subprocess
import sys
import tempfile

from netsim.config import Config, Faults, Link


def make_config(nodes, links=None, clock_offsets=None, timeout_intervals=None, workload=None):
    link_map = {}
    for src, dst, latency, jitter in links or []:
        link_map[(src, dst)] = Link(float(latency), float(jitter))
    return Config(
        nodes=list(nodes),
        links=link_map,
        clock_offsets={k: float(v) for k, v in (clock_offsets or {}).items()},
        timeout_intervals={k: float(v) for k, v in (timeout_intervals or {}).items()},
        workload=[
            {"time": float(t), "src": s, "dst": d, "app_id": a, "payload": p}
            for (t, s, d, a, p) in (workload or [])
        ],
    )


def write_json(directory, name, doc):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    return path


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "netsim", *args],
        capture_output=True,
        text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )


class TempDirCaseMixin:
    def make_tempdir(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return tmp.name
