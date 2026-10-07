import unittest

from deltaup.errors import LengthOverflowError
from deltaup.varint import MAX_VALUE, decode_prefix, encode


class VarintTest(unittest.TestCase):
    def test_roundtrip_boundaries(self):
        values = [0, 1, 127, 128, 255, 300, 2**16, 2**32, 2**56, MAX_VALUE]
        for value in values:
            with self.subTest(value=value):
                blob = encode(value)
                self.assertEqual(decode_prefix(blob), (value, len(blob)))

    def test_single_byte_zero(self):
        self.assertEqual(encode(0), b"\x00")

    def test_max_value_length(self):
        self.assertEqual(len(encode(MAX_VALUE)), 9)

    def test_encode_out_of_range(self):
        with self.assertRaises(LengthOverflowError):
            encode(MAX_VALUE + 1)
        with self.assertRaises(LengthOverflowError):
            encode(-1)

    def test_incomplete_returns_none(self):
        blob = encode(2**40)
        for cut in range(len(blob)):
            self.assertIsNone(decode_prefix(blob[:cut]))

    def test_non_canonical_rejected(self):
        with self.assertRaises(LengthOverflowError):
            decode_prefix(b"\x80\x00")  # 0 padded to two bytes
        with self.assertRaises(LengthOverflowError):
            decode_prefix(b"\x81\x00")  # 1 padded to two bytes

    def test_overlong_rejected(self):
        with self.assertRaises(LengthOverflowError):
            decode_prefix(b"\xff" * 9 + b"\x01")

    def test_offset_start(self):
        data = b"\xaa\xbb" + encode(300) + b"\xcc"
        self.assertEqual(decode_prefix(data, 2), (300, 2))


if __name__ == "__main__":
    unittest.main()
