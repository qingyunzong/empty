"""Acceptance and unit tests for leasesim (criteria A, B, C, E + errors)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from leasesim.cli import load_spec, main
from leasesim.sim import SimError, Simulator

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_spec(spec):
    capacities, ops = load_spec(json.dumps(spec))
    return Simulator(capacities).run(ops)


def op_entries(state, kind):
    return [e for e in state["results"] if e["kind"] == kind]


class TestAcceptanceA(unittest.TestCase):
    """Crossed requests on two resources: second requester is DEADLOCK,
    later ops keep flowing."""

    SPEC = {
        "resources": {"r1": 1, "r2": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r1": 1}, "ttl": 10},
            {"t": 0, "client": "b", "acquire": {"r2": 1}, "ttl": 10},
            {"t": 1, "client": "a", "acquire": {"r2": 1}, "ttl": 10},
            {"t": 1, "client": "b", "acquire": {"r1": 1}, "ttl": 10},
            {"t": 2, "client": "b", "release": ["r2"]},
        ],
    }

    def test_second_crossed_request_is_deadlock(self):
        state = run_spec(self.SPEC)
        results = [e["result"] for e in op_entries(state, "acquire")]
        self.assertEqual(results, ["GRANTED", "GRANTED", "WAITING", "DEADLOCK"])
        deadlock = op_entries(state, "acquire")[3]
        self.assertEqual(deadlock["client"], "b")
        self.assertEqual(deadlock["cycle"], ["a", "b"])

    def test_system_continues_after_deadlock(self):
        state = run_spec(self.SPEC)
        release = op_entries(state, "release")
        self.assertEqual([e["result"] for e in release], ["RELEASED"])
        grants = op_entries(state, "grant")
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]["client"], "a")
        self.assertEqual(grants[0]["t"], 2)
        self.assertEqual(grants[0]["resources"], {"r2": 1})
        self.assertEqual(
            state["holders"],
            {"a": {"resources": {"r1": 1, "r2": 1},
                   "expires_at": {"r1": 10, "r2": 12}}})


class TestAcceptanceB(unittest.TestCase):
    """TTL expiry vs same-tick acquire ordering."""

    def test_expiry_precedes_same_tick_acquire(self):
        spec = {
            "resources": {"r": 1},
            "ops": [
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 2},
                {"t": 2, "client": "b", "acquire": {"r": 1}, "ttl": 3},
            ],
        }
        state = run_spec(spec)
        acquires = op_entries(state, "acquire")
        self.assertEqual([e["result"] for e in acquires],
                         ["GRANTED", "GRANTED"])
        expires = op_entries(state, "expire")
        self.assertEqual(len(expires), 1)
        self.assertEqual(expires[0]["t"], 2)
        self.assertLess(expires[0]["seq"], acquires[1]["seq"])
        self.assertEqual(acquires[1]["expires_at"], 5)

    def test_ttl_zero_released_at_end_of_tick(self):
        spec = {
            "resources": {"r": 1},
            "ops": [
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 0},
                {"t": 0, "client": "b", "acquire": {"r": 1}, "ttl": 4},
            ],
        }
        state = run_spec(spec)
        acquires = op_entries(state, "acquire")
        # a holds r for the rest of tick 0, so b must wait first...
        self.assertEqual([e["result"] for e in acquires],
                         ["GRANTED", "WAITING"])
        # ...then a's lease expires at end of tick 0 and b is granted at t=0.
        expire = op_entries(state, "expire")[0]
        self.assertEqual(expire["t"], 0)
        self.assertEqual(expire["client"], "a")
        grant = op_entries(state, "grant")[0]
        self.assertEqual(grant["client"], "b")
        self.assertEqual(grant["t"], 0)
        self.assertEqual(grant["expires_at"], 4)
        self.assertEqual(
            state["holders"],
            {"b": {"resources": {"r": 1}, "expires_at": {"r": 4}}})

    def test_same_tick_ops_ordered_by_client(self):
        spec = {
            "resources": {"r": 1},
            "ops": [
                {"t": 0, "client": "z", "acquire": {"r": 1}, "ttl": 5},
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 5},
            ],
        }
        state = run_spec(spec)
        acquires = op_entries(state, "acquire")
        self.assertEqual([e["client"] for e in acquires], ["a", "z"])
        self.assertEqual([e["result"] for e in acquires],
                         ["GRANTED", "WAITING"])


class TestAcceptanceC(unittest.TestCase):
    """Atomicity: a 3-resource request must never hold a partial bundle."""

    SPEC = {
        "resources": {"r1": 1, "r2": 1, "r3": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r3": 1}, "ttl": 10},
            {"t": 1, "client": "b",
             "acquire": {"r1": 1, "r2": 1, "r3": 1}, "ttl": 5},
            {"t": 1, "client": "c", "acquire": {"r1": 1}, "ttl": 5},
            {"t": 2, "client": "a", "release": ["r3"]},
        ],
    }

    def test_no_partial_occupation(self):
        state = run_spec(self.SPEC)
        acquires = op_entries(state, "acquire")
        self.assertEqual([e["result"] for e in acquires],
                         ["GRANTED", "WAITING", "WAITING"])
        # While b waits, nothing of its bundle is held by b: r1/r2 stay free
        # until the atomic grant, which covers all three resources at once.
        grants = op_entries(state, "grant")
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]["client"], "b")
        self.assertEqual(grants[0]["t"], 2)
        self.assertEqual(grants[0]["resources"],
                         {"r1": 1, "r2": 1, "r3": 1})
        self.assertEqual(
            state["holders"],
            {"b": {"resources": {"r1": 1, "r2": 1, "r3": 1},
                   "expires_at": {"r1": 7, "r2": 7, "r3": 7}}})

    def test_fifo_head_of_line_blocking(self):
        # c's request is satisfiable on its own but queued behind b.
        state = run_spec(self.SPEC)
        c_acquire = [e for e in op_entries(state, "acquire")
                     if e["client"] == "c"][0]
        self.assertEqual(c_acquire["result"], "WAITING")
        self.assertNotIn("c", state["holders"])


class TestAcceptanceE(unittest.TestCase):
    """Determinism: repeated runs produce byte-identical output."""

    SPEC = {
        "resources": {"r1": 1, "r2": 2, "r3": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r1": 1, "r2": 1}, "ttl": 5},
            {"t": 0, "client": "b", "acquire": {"r2": 2}, "ttl": 0},
            {"t": 1, "client": "c", "acquire": {"r3": 1, "r2": 1}, "ttl": 2},
            {"t": 1, "client": "d", "acquire": {"r1": 1}, "ttl": 1},
            {"t": 3, "client": "e", "acquire": {"r2": 1}, "ttl": 4},
            {"t": 4, "client": "a", "release": ["r1"]},
        ],
    }

    def _payload(self):
        state = run_spec(self.SPEC)
        return json.dumps(state, indent=2, sort_keys=True) + "\n"

    def test_byte_identical_across_runs(self):
        first = self._payload()
        for _ in range(5):
            self.assertEqual(self._payload(), first)

    def test_cli_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            ops = Path(tmp) / "ops.json"
            ops.write_text(json.dumps(self.SPEC), encoding="utf-8")
            outputs = []
            for i in range(2):
                out = Path(tmp) / f"state{i}.json"
                rc = main(["run", str(ops), "--out", str(out)])
                self.assertEqual(rc, 0)
                outputs.append(out.read_bytes())
            self.assertEqual(outputs[0], outputs[1])


class TestErrors(unittest.TestCase):
    """Invalid inputs must abort with exit code 2."""

    def _run_cli(self, spec):
        with tempfile.TemporaryDirectory() as tmp:
            ops = Path(tmp) / "ops.json"
            ops.write_text(json.dumps(spec), encoding="utf-8")
            out = Path(tmp) / "state.json"
            rc = main(["run", str(ops), "--out", str(out)])
            return rc, out.exists()

    def assert_exit2(self, spec):
        rc, wrote = self._run_cli(spec)
        self.assertEqual(rc, 2)
        self.assertFalse(wrote)

    def test_need_zero(self):
        self.assert_exit2({
            "resources": {"r": 1},
            "ops": [{"t": 0, "client": "a", "acquire": {"r": 0}, "ttl": 1}]})

    def test_need_negative(self):
        self.assert_exit2({
            "resources": {"r": 1},
            "ops": [{"t": 0, "client": "a", "acquire": {"r": -2}, "ttl": 1}]})

    def test_need_exceeds_capacity(self):
        self.assert_exit2({
            "resources": {"r": 1},
            "ops": [{"t": 0, "client": "a", "acquire": {"r": 2}, "ttl": 1}]})

    def test_unknown_resource(self):
        self.assert_exit2({
            "resources": {"r": 1},
            "ops": [{"t": 0, "client": "a", "acquire": {"nope": 1}, "ttl": 1}]})

    def test_release_unheld(self):
        self.assert_exit2({
            "resources": {"r": 1},
            "ops": [{"t": 0, "client": "a", "release": ["r"]}]})

    def test_release_after_expiry(self):
        self.assert_exit2({
            "resources": {"r": 1},
            "ops": [
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 1},
                {"t": 2, "client": "a", "release": ["r"]},
            ]})

    def test_duplicate_client_same_tick(self):
        self.assert_exit2({
            "resources": {"r": 2},
            "ops": [
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 1},
                {"t": 0, "client": "a", "release": ["r"]},
            ]})

    def test_concurrent_hold_conflict_same_resource(self):
        self.assert_exit2({
            "resources": {"r": 2},
            "ops": [
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 5},
                {"t": 1, "client": "a", "acquire": {"r": 1}, "ttl": 5},
            ]})

    def test_concurrent_hold_conflict_pending_request(self):
        self.assert_exit2({
            "resources": {"r": 1, "s": 1},
            "ops": [
                {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 9},
                {"t": 1, "client": "b", "acquire": {"r": 1}, "ttl": 9},
                {"t": 2, "client": "b", "acquire": {"s": 1}, "ttl": 9},
            ]})

    def test_sim_raises_simerror(self):
        with self.assertRaises(SimError):
            run_spec({
                "resources": {"r": 1},
                "ops": [{"t": 0, "client": "a",
                         "acquire": {"r": 5}, "ttl": 1}]})


class TestCliSubprocess(unittest.TestCase):
    """End-to-end via `python -m leasesim`."""

    def _cli(self, *args, cwd=REPO_ROOT):
        return subprocess.run(
            [sys.executable, "-m", "leasesim", *args],
            cwd=cwd, capture_output=True, text=True)

    def test_deadlock_example_exit0(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "state.json"
            proc = self._cli("run", "examples/deadlock.json",
                             "--out", str(out))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            state = json.loads(out.read_text())
            results = [e["result"] for e in state["results"]
                       if e["kind"] == "acquire"]
            self.assertEqual(results,
                             ["GRANTED", "GRANTED", "WAITING", "DEADLOCK"])

    def test_error_example_exit2(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "state.json"
            proc = self._cli("run", "examples/over_capacity.json",
                             "--out", str(out))
            self.assertEqual(proc.returncode, 2)
            self.assertIn("exceeds capacity", proc.stderr)
            self.assertFalse(out.exists())

    def test_missing_file_exit2(self):
        proc = self._cli("run", "examples/does_not_exist.json",
                         "--out", "/tmp/never_written.json")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
