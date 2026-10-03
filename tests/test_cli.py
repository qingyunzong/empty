import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "examples"


def run_cli(*args):
    proc = subprocess.run(
        [sys.executable, "-m", "dvv", *args],
        cwd=ROOT, capture_output=True, text=True)
    return proc


class TestCli(unittest.TestCase):
    def test_run_script_produces_log_and_digest(self):
        proc = run_cli(str(EXAMPLES / "partition_merge.json"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertIn("log", output)
        self.assertIn("digest", output)
        # concurrent values survived the partition, then delete won
        reads = [r for r in output["results"] if isinstance(r, dict) and "values" in r]
        merged = reads[2]["values"]
        self.assertEqual(sorted(v["value"] for v in merged),
                         ["draft-a", "draft-b"])
        self.assertEqual(reads[4]["values"], [])  # after delete
        gc = [r for r in output["results"] if isinstance(r, dict) and "reclaimed" in r]
        self.assertGreaterEqual(gc[0]["reclaimed"], 1)

    def test_replay_matches_digest(self):
        proc = run_cli(str(EXAMPLES / "retire_rejoin.json"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        run_file = ROOT / "examples" / ".last_run.json"
        run_file.write_text(proc.stdout)
        try:
            replay = run_cli("--replay", str(run_file))
            self.assertEqual(replay.returncode, 0, replay.stderr)
            self.assertTrue(json.loads(replay.stdout)["match"])
        finally:
            run_file.unlink()

    def test_retire_rejoin_semantics_via_cli(self):
        proc = run_cli(str(EXAMPLES / "retire_rejoin.json"))
        output = json.loads(proc.stdout)
        reads = [r for r in output["results"] if isinstance(r, dict) and "values" in r]
        # after rejoin: the fresh epoch-2 write is the only live value
        self.assertEqual([v["value"] for v in reads[0]["values"]], ["fresh"])
        # after crash + restore + resync: identical
        self.assertEqual([v["value"] for v in reads[1]["values"]], ["fresh"])
        # the rejoined write carries the new epoch
        puts = [e for e in output["log"] if e["op"] == "put"]
        self.assertEqual(puts[-1]["dot"][1], 2)

    def test_check_command_verifies_scenario(self):
        proc = run_cli("--check", str(EXAMPLES / "partition_merge.json"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["status"], "ok")
        self.assertGreater(report["orders"], 1)


if __name__ == "__main__":
    unittest.main()
