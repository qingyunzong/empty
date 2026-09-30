"""Scenario tests: conflicts, epochs, timeout/commit race, withdrawal,
recovery, tampering, MTU retransmit planning."""
from __future__ import annotations

import os
import tempfile
import threading
import unittest

from ftgateway import (
    BadFragmentError,
    ConflictError,
    Fragment,
    Gateway,
    LengthChangeError,
    Reassembler,
    sha256_hex,
)
from tests.model import ByteModel

DATA = b"the quick brown fox jumps over"
TH = sha256_hex(DATA)


def frag(fid, off, data, **kw):
    kw.setdefault("total_length", len(DATA))
    kw.setdefault("total_hash", TH)
    return Fragment("t", 0, fid, off, data, **kw)


class ConflictTest(unittest.TestCase):
    def test_identical_overlap_accepted(self):
        r = Reassembler("t", 0)
        r.add(frag("a", 0, DATA[:10]))
        r.add(frag("b", 4, DATA[4:20]))   # [4,10) overlaps identically
        self.assertEqual(r.coverage.covered_bytes(), 20)
        self.assertEqual(r.gaps(), [(20, len(DATA))])

    def test_conflicting_overlap_rejected_with_minimal_interval(self):
        r = Reassembler("t", 0)
        r.add(frag("a", 0, DATA[:16]))
        evil = bytearray(DATA[8:24])
        evil[3] ^= 0xFF                    # differs at absolute offset 11
        evil[9] ^= 0xFF                    # and at 17
        model = ByteModel()
        model.add("a", 0, DATA[:16])
        expected = model.add("b", 8, bytes(evil))
        with self.assertRaises(ConflictError) as ctx:
            r.add(frag("b", 8, bytes(evil)))
        err = ctx.exception
        # minimal span covers exactly the differing bytes [11, 12) within
        # the model's overlap; model span starts at first diff too
        self.assertEqual((err.start, err.end), (11, 12))
        self.assertEqual(err.existing_fragment_id, "a")
        self.assertEqual(err.new_fragment_id, "b")
        self.assertEqual(expected[0], err.start)   # model agrees on first diff
        # state unpolluted: coverage unchanged, fragment not recorded
        self.assertEqual(r.coverage.covered_bytes(), 16)
        self.assertNotIn("b", r.fragments)
        # transfer still completable with honest data
        r.add(frag("c", 16, DATA[16:]))
        self.assertTrue(r.verify())

    def test_bad_fragment_never_pollutes(self):
        r = Reassembler("t", 0)
        r.add(frag("a", 0, DATA[:8]))
        with self.assertRaises(BadFragmentError):
            r.add(Fragment("t", 0, "bad", 8, b"junk",
                           total_length=len(DATA), total_hash=TH,
                           content_hash="0" * 64))
        with self.assertRaises(BadFragmentError):
            r.add(Fragment("t", 1, "stale", 8, b"junk"))   # wrong epoch
        with self.assertRaises(BadFragmentError):
            r.add(frag("over", len(DATA) - 2, b"waytoolong"))
        self.assertEqual(r.coverage.covered_bytes(), 8)
        self.assertEqual(sorted(r.fragments), ["a"])


class EpochTest(unittest.TestCase):
    def test_length_fixed_once_then_requires_new_epoch(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p")
            gw.add_fragment(frag("a", 0, DATA[:8]))
            with self.assertRaises(LengthChangeError) as ctx:
                gw.add_fragment(Fragment("t", 0, "b", 8, b"x",
                                         total_length=999))
            self.assertEqual(ctx.exception.fixed, len(DATA))
            # new epoch allows the new length
            ep = gw.start_new_epoch("t")
            self.assertEqual(ep, 1)
            res = gw.add_fragment(Fragment("t", 1, "b", 0, b"x",
                                           total_length=1,
                                           total_hash=sha256_hex(b"x")))
            self.assertTrue(res["committed"])
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), b"x")
            # stale epoch fragments are dropped
            with self.assertRaises(BadFragmentError):
                gw.add_fragment(frag("c", 8, DATA[8:16]))


class TimeoutCommitRaceTest(unittest.TestCase):
    def test_reclaim_excluded_while_committing(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p", timeout=5.0)
            gw.add_fragment(frag("a", 0, DATA[:10]), now=0.0)
            r = gw.reassemblers[("t", 0)]
            r.last_activity = 0.0
            r.committing = True            # commit critical section entered
            reclaimed = gw.tick(100.0)     # way past timeout
            self.assertEqual(reclaimed, [])
            self.assertIn(("t", 0), gw.reassemblers)
            r.committing = False
            reclaimed = gw.tick(100.0)
            self.assertEqual(len(reclaimed), 1)
            self.assertNotIn(("t", 0), gw.reassemblers)

    def test_completion_at_timeout_moment_commits(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p", timeout=5.0)
            gw.add_fragment(frag("a", 0, DATA[:10]), now=0.0)
            # final fragment arrives exactly at the timeout boundary;
            # add refreshes activity and auto-commit must win
            res = gw.add_fragment(frag("b", 10, DATA[10:]), now=5.0)
            self.assertTrue(res["committed"])
            self.assertEqual(gw.tick(5.0), [])   # nothing to reclaim
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), DATA)

    def test_concurrent_commit_and_tick(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p", timeout=0.0)
            for i in range(0, len(DATA), 4):
                gw.add_fragment(frag(f"f{i}", i, DATA[i:i + 4]), now=0.0)
            errors = []

            def ticker():
                try:
                    gw.tick(1000.0)
                except Exception as exc:  # pragma: no cover
                    errors.append(exc)

            threads = [threading.Thread(target=ticker) for _ in range(4)]
            for t in threads:
                t.start()
            ok = gw.commit("t", 0)
            for t in threads:
                t.join()
            self.assertFalse(errors)
            self.assertTrue(ok)
            self.assertTrue(os.path.exists(f"{d}/p/t"))


class WithdrawTest(unittest.TestCase):
    def test_withdrawal_opens_new_gap(self):
        r = Reassembler("t", 0)
        r.add(frag("a", 0, DATA[:12]))
        r.add(frag("b", 8, DATA[8:20]))     # overlaps a identically
        r.add(frag("c", 20, DATA[20:]))
        self.assertTrue(r.is_complete())
        self.assertTrue(r.withdraw("b"))
        self.assertEqual(r.gaps(), [(12, 20)])
        self.assertFalse(r.is_complete())
        # refill the hole with identical bytes -> complete again
        r.add(frag("d", 12, DATA[12:20]))
        self.assertTrue(r.verify())
        self.assertFalse(r.withdraw("nonexistent"))


class SpillAndRecoveryTest(unittest.TestCase):
    def test_spill_to_sparse_temp_file(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p", memory_threshold=4)
            gw.add_fragment(frag("a", 0, DATA[:8]))
            r = gw.reassemblers[("t", 0)]
            self.assertTrue(r.spilled)
            self.assertTrue(os.path.exists(r.temp_path))
            gw.add_fragment(frag("b", 8, DATA[8:]))
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), DATA)

    def test_recovery_never_publishes_holed_file(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p", memory_threshold=4)
            gw.add_fragment(frag("a", 0, DATA[:8]))
            gw.add_fragment(frag("c", 20, DATA[20:]))   # hole [8,20)
            gw2 = Gateway.recover(f"{d}/w", f"{d}/p", memory_threshold=4)
            self.assertFalse(os.path.exists(f"{d}/p/t"))
            self.assertEqual(gw2.gaps("t", 0), [(8, 20)])
            # finish after recovery
            gw2.add_fragment(frag("b", 8, DATA[8:20]))
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), DATA)

    def test_duplicate_recovery_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p")
            for i in range(0, len(DATA), 5):
                gw.add_fragment(frag(f"f{i}", i, DATA[i:i + 5]))
            with open(f"{d}/p/t", "rb") as fh:
                first = fh.read()
            gw2 = Gateway.recover(f"{d}/w", f"{d}/p")
            gw3 = Gateway.recover(f"{d}/w", f"{d}/p")
            self.assertEqual(gw2.published, gw3.published)
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), first)
            self.assertEqual(first, DATA)

    def test_tampered_temp_file_quarantined(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p", memory_threshold=4)
            gw.add_fragment(frag("a", 0, DATA[:16]))
            path = gw.reassemblers[("t", 0)].temp_path
            gw.reassemblers[("t", 0)].close()
            with open(path, "r+b") as fh:      # attacker flips a byte
                fh.seek(3)
                b = fh.read(1)
                fh.seek(3)
                fh.write(bytes([b[0] ^ 0xFF]))
            gw2 = Gateway.recover(f"{d}/w", f"{d}/p", memory_threshold=4)
            r = gw2.reassemblers[("t", 0)]
            self.assertTrue(r.failed)
            self.assertFalse(os.path.exists(f"{d}/p/t"))
            self.assertTrue(any(e["event"] == "quarantined"
                                for e in gw2.events))


class RetransmitTest(unittest.TestCase):
    def test_dynamic_mtu_plan(self):
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p")
            gw.add_fragment(frag("a", 0, DATA[:4]))
            gw.add_fragment(frag("b", 24, DATA[24:]))
            self.assertEqual(gw.gaps("t", 0), [(4, 24)])
            self.assertEqual(gw.retransmit_plan("t", 0, 8),
                             [(4, 8), (12, 8), (20, 4)])
            # MTU renegotiated down mid-transfer
            self.assertEqual(gw.retransmit_plan("t", 0, 3),
                             [(4, 3), (7, 3), (10, 3), (13, 3),
                              (16, 3), (19, 3), (22, 2)])


if __name__ == "__main__":
    unittest.main()
