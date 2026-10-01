import unittest

from deltaupd import varint
from deltaupd.errors import LengthOverflowError, NonCanonicalVarintError


class VarintTest(unittest.TestCase):
    def test_roundtrip(self):
        values = [0, 1, 2, 127, 128, 129, 300, 16383, 16384,
                  2**21 - 1, 2**21, 2**32, 2**48, 2**56, 2**63 - 1]
        for value in values:
            with self.subTest(value=value):
                encoded = varint.encode(value)
                self.assertLessEqual(len(encoded), varint.MAX_BYTES)
                self.assertEqual(varint.decode(encoded), (value, len(encoded)))

    def test_known_encodings(self):
        self.assertEqual(varint.encode(0), b"\x00")
        self.assertEqual(varint.encode(127), b"\x7f")
        self.assertEqual(varint.encode(128), b"\x80\x01")
        self.assertEqual(varint.encode(300), b"\xac\x02")

    def test_encode_out_of_range(self):
        with self.assertRaises(ValueError):
            varint.encode(2**63)
        with self.assertRaises(ValueError):
            varint.encode(-1)

    def test_incomplete_returns_none(self):
        self.assertIsNone(varint.decode(b""))
        self.assertIsNone(varint.decode(b"\x80"))
        self.assertIsNone(varint.decode(b"\xff" * 8))

    def test_non_canonical_rejected(self):
        for bad in (b"\x80\x00", b"\x81\x00", b"\xff" * 8 + b"\x00"):
            with self.subTest(bad=bad):
                with self.assertRaises(NonCanonicalVarintError):
                    varint.decode(bad)

    def test_overflow_rejected(self):
        with self.assertRaises(LengthOverflowError):
            varint.decode(b"\xff" * 9 + b"\x01")
        with self.assertRaises(LengthOverflowError):
            varint.decode(b"\x80" * 10)

    def test_decode_with_offset(self):
        buf = b"\x99" + varint.encode(300) + b"\x77"
        self.assertEqual(varint.decode(buf, 1), (300, 3))


if __name__ == "__main__":
    unittest.main()
