import json
import os
import subprocess
import sys
import tempfile
import unittest

from msdeliv.frames import message_frames

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(commands):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "msdeliv.cli"],
        input="\n".join(json.dumps(c) for c in commands) + "\n",
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


class TestCli(unittest.TestCase):
    def test_session_send_poll_acks(self):
        (m0,) = message_frames("s", 0, 0, "zero")
        (m2,) = message_frames("s", 0, 2, "two")
        events = run_cli([
            {"op": "new", "mod": 16, "window": 4},
            {"op": "send", "frame": m2.to_dict()},
            {"op": "poll"},
            {"op": "acks", "stream": "s", "epoch": 0},
            {"op": "send", "frame": m0.to_dict()},
            {"op": "poll"},
        ])
        self.assertEqual(events[0]["event"], "ready")
        self.assertEqual(events[1]["status"], "accepted")
        self.assertEqual(events[2]["outputs"], [])  # gap at seq 0... wait seq1 missing
        self.assertEqual(events[3]["acks"]["retransmit"], [0, 1])
        self.assertEqual(events[4]["status"], "accepted")
        contents = [o["content"] for o in events[5]["outputs"]]
        self.assertEqual(contents, ["zero"])  # seq 1 still missing

    def test_crash_recover_via_cli(self):
        (m0,) = message_frames("s", 0, 0, "zero")
        (m1,) = message_frames("s", 0, 1, "one")
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "log.jsonl")
            events = run_cli([
                {"op": "new", "mod": 16, "window": 4, "log": log},
                {"op": "send", "frame": m0.to_dict()},
                {"op": "send", "frame": m1.to_dict()},
                {"op": "crash"},
                {"op": "recover"},
                {"op": "poll"},
            ])
        self.assertEqual(events[3]["event"], "crashed")
        self.assertEqual(events[4]["event"], "recovered")
        self.assertEqual(events[4]["cursor"], 0)
        contents = [o["content"] for o in events[5]["outputs"]]
        self.assertEqual(contents, ["zero", "one"])

    def test_replay_and_verify_ops(self):
        frames = (
            message_frames("s", 0, 1, "one")
            + message_frames("s", 0, 0, "zero")
        )
        schedule = [f.to_dict() for f in frames]
        events = run_cli([
            {"op": "replay", "mod": 16, "window": 4, "schedule": schedule},
            {"op": "verify", "mod": 16, "window": 4, "schedule": schedule},
        ])
        self.assertEqual(events[0]["event"], "outputs")
        self.assertEqual(
            [o["content"] for o in events[0]["outputs"]], ["zero", "one"]
        )
        self.assertEqual(events[1]["event"], "ok")

    def test_unknown_op_and_bad_json(self):
        events = run_cli([{"op": "nope"}])
        self.assertEqual(events[0]["event"], "error")


if __name__ == "__main__":
    unittest.main()
