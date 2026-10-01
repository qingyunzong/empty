import hashlib
import os
import unittest

from deltaupd.sha256 import Sha256


class Sha256Test(unittest.TestCase):
    def test_matches_hashlib(self):
        lengths = list(range(0, 200)) + [255, 256, 511, 512, 1000, 4096]
        for n in lengths:
            data = os.urandom(n)
            with self.subTest(n=n):
                self.assertEqual(Sha256(data).hexdigest(),
                                 hashlib.sha256(data).hexdigest())

    def test_incremental_matches_one_shot(self):
        data = os.urandom(1000)
        for cut in range(0, len(data) + 1, 7):
            h = Sha256()
            h.update(data[:cut])
            h.update(data[cut:])
            with self.subTest(cut=cut):
                self.assertEqual(h.hexdigest(), hashlib.sha256(data).hexdigest())

    def test_state_roundtrip(self):
        data = os.urandom(300)
        for cut in range(0, 200):
            h = Sha256(data[:cut])
            restored = Sha256.fromstate(h.getstate())
            h.update(data[cut:])
            restored.update(data[cut:])
            with self.subTest(cut=cut):
                self.assertEqual(h.hexdigest(), restored.hexdigest())
                self.assertEqual(h.hexdigest(), hashlib.sha256(data).hexdigest())

    def test_state_roundtrip_through_hex(self):
        h = Sha256(b"checkpoint me")
        restored = Sha256.fromstate(bytes.fromhex(h.getstate().hex()))
        self.assertEqual(h.digest(), restored.digest())

    def test_fromstate_rejects_garbage(self):
        with self.assertRaises(ValueError):
            Sha256.fromstate(b"\x00" * 10)
        with self.assertRaises(ValueError):
            Sha256.fromstate(b"\x00" * 40 + b"\x40" + b"\x00" * 64)


if __name__ == "__main__":
    unittest.main()
