import os
import tempfile
import unittest

from reassembler import Fragment, Gateway, GatewayConfig, SubmitStatus
from reassembler.fragments import sha256_hex
from reassembler.storage import SparseFileStorage


def make_gateway(tmp, **kw):
    return Gateway(GatewayConfig(workdir=tmp, **kw))


def frag(tid, fid, offset, data, epoch=0, total=None, thash=None):
    return Fragment(
        transfer_id=tid,
        epoch=epoch,
        frag_id=fid,
        offset=offset,
        data=data,
        total_length=total,
        total_hash=thash,
    )


class GatewayCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.gw = make_gateway(self.tmp)

    def submit(self, *args, **kw):
        return self.gw.submit(frag(*args, **kw))


class TestOverlapAndConflict(GatewayCase):
    def test_identical_overlap_accepted(self):
        r1 = self.submit("t", "a", 0, b"hello ", total=11)
        r2 = self.submit("t", "b", 3, b"lo wor")
        r3 = self.submit("t", "c", 6, b"world", total=11)
        self.assertEqual(r1.status, SubmitStatus.ACCEPTED)
        self.assertEqual(r2.status, SubmitStatus.ACCEPTED)
        self.assertEqual(r3.status, SubmitStatus.ACCEPTED)
        self.assertTrue(r3.complete)
        self.assertEqual(self.gw.get("t").assembled(), b"hello world")

    def test_conflict_rejects_whole_fragment_and_reports(self):
        self.submit("t", "a", 0, b"abcdef", total=6)
        # differs only at positions 2 ('X' vs 'c') and 4 ('Y' vs 'e')
        r = self.submit("t", "evil", 1, b"bXdYf")
        self.assertEqual(r.status, SubmitStatus.CONFLICT)
        self.assertEqual((r.conflict_start, r.conflict_end), (2, 5))
        self.assertEqual(r.conflict_frag_incoming, "evil")
        self.assertEqual(r.conflict_frag_existing, "a")
        # verified data unpolluted: no byte of the bad fragment was applied
        st = self.gw.get("t")
        self.assertEqual(st.assembled(), b"abcdef")
        self.assertNotIn("evil", st.fragments)
        # non-conflicting tail of a rejected fragment must not appear either
        r2 = self.submit("t", "ok", 0, b"abcdef")
        self.assertEqual(r2.status, SubmitStatus.ACCEPTED)

    def test_conflict_minimal_interval_single_byte(self):
        self.submit("t", "a", 0, b"aaaa", total=4)
        r = self.submit("t", "b", 0, b"aaba")
        self.assertEqual(r.status, SubmitStatus.CONFLICT)
        self.assertEqual((r.conflict_start, r.conflict_end), (2, 3))

    def test_frag_id_reuse_with_different_content_rejected(self):
        self.submit("t", "a", 0, b"xx", total=4)
        r = self.submit("t", "a", 2, b"yy")
        self.assertEqual(r.status, SubmitStatus.REJECTED)
        self.assertIn("frag_id_reuse", r.reason)

    def test_exact_duplicate_is_noop(self):
        self.submit("t", "a", 0, b"xx", total=4)
        r = self.submit("t", "a", 0, b"xx")
        self.assertEqual(r.status, SubmitStatus.DUPLICATE)
        self.assertEqual(len(self.gw.get("t").fragments), 1)


class TestLengthAndEpoch(GatewayCase):
    def test_total_length_set_once(self):
        self.submit("t", "a", 0, b"ab", total=4)
        r = self.submit("t", "b", 2, b"cd", total=4)
        self.assertEqual(r.status, SubmitStatus.ACCEPTED)
        r2 = self.submit("t", "c", 0, b"ab", total=8)
        self.assertEqual(r2.status, SubmitStatus.REJECTED)
        self.assertIn("new epoch", r2.reason)

    def test_length_change_requires_new_epoch(self):
        self.submit("t", "a", 0, b"ab", total=4)
        bad = self.submit("t", "b", 0, b"ab", total=9)
        self.assertEqual(bad.status, SubmitStatus.REJECTED)
        ok = self.submit("t", "b", 0, b"abcdefghi", epoch=1, total=9)
        self.assertEqual(ok.status, SubmitStatus.ACCEPTED)
        self.assertEqual(self.gw.get("t", 1).assembled(), b"abcdefghi")
        # old epoch untouched
        self.assertEqual(self.gw.get("t", 0).total_length, 4)

    def test_fragment_beyond_total_rejected(self):
        self.submit("t", "a", 0, b"ab", total=4)
        r = self.submit("t", "b", 3, b"cdef")
        self.assertEqual(r.status, SubmitStatus.REJECTED)
        self.assertEqual(r.reason, "fragment_out_of_bounds")

    def test_zero_length_file(self):
        thash = sha256_hex(b"")
        r = self.submit("t", "meta", 0, b"", total=0, thash=thash)
        self.assertEqual(r.status, SubmitStatus.ACCEPTED)
        self.assertTrue(r.complete)
        out = self.gw.finalize("t")
        self.assertEqual(out["status"], "published")
        with open(out["path"], "rb") as fh:
            self.assertEqual(fh.read(), b"")
        self.assertEqual(out["sha256"], thash)

    def test_tail_fragment_arrives_first(self):
        data = b"0123456789"
        thash = sha256_hex(data)
        self.submit("t", "tail", 6, data[6:], total=10, thash=thash)
        self.submit("t", "mid", 3, data[3:6])
        r = self.submit("t", "head", 0, data[:3])
        self.assertTrue(r.complete)
        out = self.gw.finalize("t")
        self.assertEqual(out["status"], "published")
        with open(out["path"], "rb") as fh:
            self.assertEqual(fh.read(), data)


class TestRetractAndRetransmit(GatewayCase):
    def test_retraction_creates_new_gap(self):
        # consistent overlapping content of "aaaabbbb"
        self.submit("t", "a", 0, b"aaaa", total=8)
        self.submit("t", "b", 2, b"aabb")
        self.submit("t", "c", 6, b"bb", total=8)
        st = self.gw.get("t")
        self.assertEqual(st.gaps(), [])
        self.assertTrue(self.gw.retract("t", 0, "b"))
        self.assertEqual(st.gaps(), [(4, 6)])
        # retracted bytes no longer served as verified data
        self.assertEqual(st.coverage.covered_bytes(), 6)
        # refilling the gap works
        r = self.submit("t", "b2", 4, b"bb")
        self.assertTrue(r.complete)

    def test_retract_unknown_or_finalized(self):
        self.assertFalse(self.gw.retract("t", 0, "nope"))
        self.submit("t", "a", 0, b"ab", total=2)
        self.gw.finalize("t")
        self.assertFalse(self.gw.retract("t", 0, "a"))

    def test_dynamic_mtu_retransmit_plan(self):
        self.submit("t", "a", 0, b"aa", total=10)
        self.submit("t", "b", 8, b"bb")
        plan2 = self.gw.retransmit_plan("t", 0, 2)
        self.assertEqual(plan2, [(2, 2), (4, 2), (6, 2)])
        plan3 = self.gw.retransmit_plan("t", 0, 3)
        self.assertEqual(plan3, [(2, 3), (5, 3)])
        plan100 = self.gw.retransmit_plan("t", 0, 100)
        self.assertEqual(plan100, [(2, 6)])
        # mtu can change per call (dynamic MTU retransmission)
        for _, n in plan3:
            self.assertLessEqual(n, 3)


class TestSparseStorage(GatewayCase):
    def test_spills_to_sparse_file_over_threshold(self):
        gw = make_gateway(self.tmp, memory_threshold=16)
        data = bytes(range(64))
        gw.submit(frag("big", "a", 0, data[:32], total=64))
        st = gw.get("big")
        self.assertIsInstance(st.storage, SparseFileStorage)
        gw.submit(frag("big", "b", 32, data[32:]))
        self.assertEqual(st.assembled(), data)
        self.assertTrue(os.path.getsize(st.storage.path) == 64)

    def test_stays_in_memory_under_threshold(self):
        self.submit("t", "a", 0, b"tiny", total=4)
        self.assertEqual(self.gw.get("t").status()["storage"], "MemoryStorage")


class TestTimeout(GatewayCase):
    def test_idle_transfer_reclaimed(self):
        gw = make_gateway(self.tmp, timeout=10.0)
        gw.submit(frag("t", "a", 0, b"ab", total=4), now=0.0)
        reclaimed = gw.advance_time(10.0)
        self.assertEqual(reclaimed, [("t", 0)])
        self.assertIsNone(gw.get("t"))

    def test_completion_at_timeout_tick_wins(self):
        gw = make_gateway(self.tmp, timeout=10.0)
        gw.submit(frag("t", "a", 0, b"ab", total=4), now=0.0)
        # completing fragment arrives exactly when the old state would expire
        r = gw.submit(frag("t", "b", 2, b"cd"), now=10.0)
        self.assertTrue(r.complete)
        out = gw.finalize("t", now=10.0)
        self.assertEqual(out["status"], "published")
        reclaimed = gw.advance_time(10.0)
        self.assertEqual(reclaimed, [])
        self.assertIsNotNone(gw.get("t"))

    def test_reclaim_mutex_with_committing_transfer(self):
        gw = make_gateway(self.tmp, timeout=10.0)
        gw.submit(frag("t", "a", 0, b"ab", total=2), now=0.0)
        st = gw.get("t")
        st.committing = True  # commit in progress
        reclaimed = gw.advance_time(100.0)
        self.assertEqual(reclaimed, [])
        self.assertIsNotNone(gw.get("t"))
        st.committing = False
        # once the commit flag clears, normal rules apply (finalized wins)
        gw.finalize("t")
        self.assertEqual(gw.advance_time(100.0), [])


class TestTampering(GatewayCase):
    def test_tampered_temp_file_fails_total_hash(self):
        gw = make_gateway(self.tmp, memory_threshold=4)
        data = b"0123456789abcdef"
        thash = sha256_hex(data)
        gw.submit(frag("t", "a", 0, data[:8], total=16, thash=thash))
        gw.submit(frag("t", "b", 8, data[8:]))
        st = gw.get("t")
        self.assertIsInstance(st.storage, SparseFileStorage)
        # attacker flips a byte inside the sparse temp file
        with open(st.storage.path, "r+b") as fh:
            fh.seek(3)
            fh.write(b"X")
        out = gw.finalize("t")
        self.assertEqual(out["status"], "hash_mismatch")
        self.assertEqual(out["expected"], thash)
        self.assertNotEqual(out["actual"], thash)
        self.assertFalse(os.path.exists(os.path.join(gw.out_dir, "t.bin")))
        # abort is recorded in the commit log
        with open(gw.commit_log_path) as fh:
            log = fh.read()
        self.assertIn("abort_commit", log)


if __name__ == "__main__":
    unittest.main()
