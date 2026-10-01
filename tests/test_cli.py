import json
import subprocess
import sys
import unittest


def run_cli(stdin_text):
    return subprocess.run(
        [sys.executable, "-m", "topo"],
        input=stdin_text,
        capture_output=True,
        text=True,
    )


class TestCli(unittest.TestCase):
    def test_basic_flow_and_order_output(self):
        proc = run_cli(
            '{"op":"add_node","node":"b"}\n'
            '{"op":"add_node","node":"a"}\n'
            '{"op":"add_edge","src":"b","dst":"a"}\n'
            '{"op":"order"}\n'
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.strip().splitlines()]
        self.assertEqual(lines[-1]["order"], ["b", "a"])
        self.assertIsInstance(lines[-1]["version"], int)

    def test_bad_json_exit2(self):
        proc = run_cli('{"op":"add_node","node":"a"}\nnot json\n')
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stderr.strip().splitlines()[-1])
        self.assertEqual(err["error"], "bad_json")
        self.assertEqual(err["line"], 2)

    def test_malformed_command_exit2(self):
        proc = run_cli('{"op":"add_edge","src":"a"}\n')
        self.assertEqual(proc.returncode, 2)

    def test_unknown_op_exit2(self):
        proc = run_cli('{"op":"explode"}\n')
        self.assertEqual(proc.returncode, 2)

    def test_unknown_node_exit4(self):
        proc = run_cli('{"op":"add_node","node":"a"}\n{"op":"add_edge","src":"a","dst":"ghost"}\n')
        self.assertEqual(proc.returncode, 4)
        err = json.loads(proc.stderr.strip().splitlines()[-1])
        self.assertEqual(err["error"], "unknown_node")
        self.assertEqual(err["node"], "ghost")

    def test_del_node_unknown_exit4(self):
        proc = run_cli('{"op":"del_node","node":"ghost"}\n')
        self.assertEqual(proc.returncode, 4)

    def test_cycle_exit3_and_minimal_node_set(self):
        proc = run_cli(
            '{"op":"add_node","node":"b"}\n'
            '{"op":"add_node","node":"a"}\n'
            '{"op":"add_edge","src":"a","dst":"b"}\n'
            '{"op":"add_edge","src":"b","dst":"a"}\n'
        )
        self.assertEqual(proc.returncode, 3)
        err = json.loads(proc.stderr.strip().splitlines()[-1])
        self.assertEqual(err["error"], "cycle")
        self.assertEqual(err["nodes"], ["a", "b"])

    def test_self_loop_exit3(self):
        proc = run_cli('{"op":"add_node","node":"a"}\n{"op":"add_edge","src":"a","dst":"a"}\n')
        self.assertEqual(proc.returncode, 3)
        err = json.loads(proc.stderr.strip().splitlines()[-1])
        self.assertEqual(err["nodes"], ["a"])

    def test_determinism_across_runs(self):
        script = "".join(
            '{"op":"add_node","node":"%s"}\n' % n for n in ["z", "m", "a", "q"]
        ) + '{"op":"add_edge","src":"m","dst":"q"}\n{"op":"order"}\n'
        outs = {run_cli(script).stdout for _ in range(5)}
        self.assertEqual(len(outs), 1)
        order = json.loads(outs.pop().strip())["order"]
        self.assertEqual(order, ["a", "m", "q", "z"])

    def test_del_node_cascade_via_cli(self):
        proc = run_cli(
            '{"op":"add_node","node":"a"}\n'
            '{"op":"add_node","node":"b"}\n'
            '{"op":"add_node","node":"c"}\n'
            '{"op":"add_edge","src":"a","dst":"b"}\n'
            '{"op":"add_edge","src":"b","dst":"c"}\n'
            '{"op":"del_node","node":"b"}\n'
            '{"op":"order"}\n'
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        order = json.loads(proc.stdout.strip().splitlines()[-1])["order"]
        self.assertEqual(order, ["a", "c"])

    def test_duplicate_edge_no_version_change_via_cli(self):
        proc = run_cli(
            '{"op":"add_node","node":"a"}\n'
            '{"op":"add_node","node":"b"}\n'
            '{"op":"add_edge","src":"a","dst":"b"}\n'
            '{"op":"order"}\n'
            '{"op":"add_edge","src":"a","dst":"b"}\n'
            '{"op":"order"}\n'
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.strip().splitlines()]
        self.assertEqual(lines[0]["version"], lines[1]["version"])
        self.assertEqual(lines[0]["order"], lines[1]["order"])


if __name__ == "__main__":
    unittest.main()
