"""Read-only checks against the two final source trees, using Python 3.11."""

import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
LOCATIONS = json.loads((ROOT / "source-locations.json").read_text())
for side in "AB":
    item = LOCATIONS[side]
    sha = subprocess.run(
        ["git", "-C", item["workspace"], "rev-parse", "HEAD"],
        text=True, capture_output=True, check=True,
    ).stdout.strip()
    assert sha == item["sha"], (side, sha, item["sha"])
    print(json.dumps({"side": side, "sha": sha}, ensure_ascii=False))

sys.path.insert(0, LOCATIONS["A"]["workspace"])
sys.path.insert(0, LOCATIONS["B"]["workspace"])
from repligroup import Cluster, StaleEpoch  # noqa: E402
from rgroup import Group  # noqa: E402

with tempfile.TemporaryDirectory() as directory:
    a = Cluster(nodes=["a", "b", "c"], data_dir=directory)
    a.begin_change(["a", "b", "c"], ["c", "d", "e"])
    recovered = Cluster(data_dir=directory)
    print(json.dumps({"case": "restart_after_begin", "side": "A", "phase": recovered.phase,
                      "epoch": recovered.current_epoch, "committed_config_epoch": recovered.config_epoch},
                     ensure_ascii=False))

with tempfile.TemporaryDirectory() as directory:
    b = Group(["a", "b", "c"], path=directory)
    b._persist()
    b.begin_change(["a", "b", "c"], ["c", "d", "e"])
    recovered = Group.load(directory)
    print(json.dumps({"case": "restart_after_begin", "side": "B", "joint": recovered.joint,
                      "epoch": recovered.config.epoch}, ensure_ascii=False))

a = Cluster(nodes=["a", "b", "c"])
seq, old_epoch = a.propose("old")
a.begin_change(["a", "b", "c"], ["c", "d", "e"])
try:
    a.ack("a", seq)
except StaleEpoch as error:
    a_result = error.code
else:
    a_result = "accepted"
print(json.dumps({"case": "old_write_ack_after_begin", "side": "A", "old_epoch": old_epoch,
                  "joint_epoch": a.current_epoch, "result": a_result, "committed": a.is_committed(seq)},
                 ensure_ascii=False))

b = Group(["a", "b", "c"])
write = b.propose("old")
b.begin_change(["a", "b", "c"], ["c", "d", "e"])
results = [b.ack(write.id, node) for node in ("d", "e", "a", "c")]
print(json.dumps({"case": "old_write_ack_after_begin", "side": "B", "old_epoch": write.epoch,
                  "joint_epoch": b.config.epoch, "ack_results": results,
                  "committed": write.committed, "read": b.read()}, ensure_ascii=False))
