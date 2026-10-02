import json
import os
import tempfile
import unittest

from reassembler import Fragment, Gateway, GatewayConfig
from reassembler.fragments import sha256_hex


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


class RecoveryCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def gateway(self):
        return Gateway(GatewayConfig(workdir=self.tmp))


class TestCheckpointRecovery(RecoveryCase):
    def test_recovery_restores_inflight_transfer(self):
        gw = self.gateway()
        data = b"hello world"
        thash = sha256_hex(data)
        gw.submit(frag("t", "a", 0, data[:5], total=11, thash=thash))
        gw.submit(frag("t", "b", 8, data[8:]))
        # simulate crash: brand new gateway over the same workdir
        gw2 = self.gateway()
        report = gw2.recover()
        self.assertEqual(report["restored"], ["t:0"])
        st = gw2.get("t")
        self.assertIsNotNone(st)
        self.assertEqual(st.gaps(), [(5, 8)])
        self.assertEqual(st.total_hash, thash)
        # finish after recovery and publish
        r = gw2.submit(frag("t", "c", 5, data[5:8]))
        self.assertTrue(r.complete)
        out = gw2.finalize("t")
        self.assertEqual(out["status"], "published")
        with open(out["path"], "rb") as fh:
            self.assertEqual(fh.read(), data)

    def test_duplicate_recovery_is_idempotent(self):
        gw = self.gateway()
        gw.submit(frag("t", "a", 0, b"ab", total=4))
        gw2 = self.gateway()
        first = gw2.recover()
        second = gw2.recover()
        self.assertEqual(first["restored"], ["t:0"])
        self.assertEqual(second["restored"], [])
        st = gw2.get("t")
        self.assertEqual(len(st.fragments), 1)
        self.assertEqual(st.gaps(), [(2, 4)])

    def test_recovery_never_publishes_holey_file(self):
        gw = self.gateway()
        gw.submit(frag("t", "a", 0, b"ab", total=4))
        gw2 = self.gateway()
        gw2.recover()
        out = gw2.finalize("t")
        self.assertEqual(out["status"], "incomplete")
        self.assertEqual(out["gaps"], [(2, 4)])
        self.assertFalse(os.path.exists(os.path.join(gw2.out_dir, "t.bin")))

    def test_crash_between_begin_and_end_commit(self):
        gw = self.gateway()
        data = b"payload"
        gw.submit(frag("t", "a", 0, data, total=len(data)))
        # forge a crashed commit: begin without end, orphan tmp left behind
        tmp = os.path.join(gw.out_dir, ".t-0-crashed.tmp")
        with open(tmp, "wb") as fh:
            fh.write(b"partial")
        gw._log(
            {
                "event": "begin_commit",
                "transfer_id": "t",
                "epoch": 0,
                "target": os.path.join(gw.out_dir, "t.bin"),
                "tmp": tmp,
                "total_hash": sha256_hex(data),
            }
        )
        gw2 = self.gateway()
        report = gw2.recover()
        self.assertEqual(report["orphaned_tmp_removed"], [tmp])
        self.assertFalse(os.path.exists(tmp))
        # nothing was published
        self.assertFalse(os.path.exists(os.path.join(gw2.out_dir, "t.bin")))

    def test_completed_commit_survives_recovery(self):
        gw = self.gateway()
        data = b"full file"
        gw.submit(frag("t", "a", 0, data, total=len(data)))
        out = gw.finalize("t")
        self.assertEqual(out["status"], "published")
        gw2 = self.gateway()
        report = gw2.recover()
        self.assertEqual(report["orphaned_tmp_removed"], [])
        # published file intact, not re-published or removed
        with open(out["path"], "rb") as fh:
            self.assertEqual(fh.read(), data)

    def test_checkpoint_reflects_retraction(self):
        gw = self.gateway()
        gw.submit(frag("t", "a", 0, b"aaaa", total=6))
        gw.submit(frag("t", "b", 4, b"bb"))
        gw.retract("t", 0, "b")
        gw2 = self.gateway()
        gw2.recover()
        st = gw2.get("t")
        self.assertEqual(st.gaps(), [(4, 6)])
        self.assertNotIn("b", st.fragments)

    def test_corrupt_checkpoint_raises_not_publishes(self):
        gw = self.gateway()
        gw.submit(frag("t", "a", 0, b"ab", total=2))
        path = gw._checkpoint_path("t", 0)
        with open(path) as fh:
            doc = json.load(fh)
        doc["fragments"][0]["data_b64"] = "AA=="
        doc["fragments"][0]["offset"] = 5  # out of bounds for total=2
        with open(path, "w") as fh:
            json.dump(doc, fh)
        gw2 = self.gateway()
        with self.assertRaises(ValueError):
            gw2.recover()
        self.assertFalse(os.path.exists(os.path.join(gw2.out_dir, "t.bin")))


if __name__ == "__main__":
    unittest.main()
