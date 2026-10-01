"""Pure-Python SHA-256 with a serializable state.

The applier checkpoints its rolling hash state on every verified instruction
boundary; hashlib objects cannot be pickled, so this module provides an
equivalent implementation whose state round-trips through bytes.  Correctness
is verified against hashlib.sha256 in the test suite.
"""

import struct

_K = (
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1,
    0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
    0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786,
    0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147,
    0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
    0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B,
    0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A,
    0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
    0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
)

_H0 = (0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
       0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19)

_MASK = 0xFFFFFFFF


def _compress(h, block):
    w = list(struct.unpack(">16I", block)) + [0] * 48
    for t in range(16, 64):
        s0 = ((w[t-15] >> 7) | (w[t-15] << 25)) & _MASK
        s0 ^= ((w[t-15] >> 18) | (w[t-15] << 14)) & _MASK
        s0 ^= w[t-15] >> 3
        s1 = ((w[t-2] >> 17) | (w[t-2] << 15)) & _MASK
        s1 ^= ((w[t-2] >> 19) | (w[t-2] << 13)) & _MASK
        s1 ^= w[t-2] >> 10
        w[t] = (w[t-16] + s0 + w[t-7] + s1) & _MASK
    a, b, c, d, e, f, g, hh = h
    for t in range(64):
        big_s1 = ((e >> 6) | (e << 26)) & _MASK
        big_s1 ^= ((e >> 11) | (e << 21)) & _MASK
        big_s1 ^= ((e >> 25) | (e << 7)) & _MASK
        ch = (e & f) ^ (~e & g & _MASK)
        t1 = (hh + big_s1 + ch + _K[t] + w[t]) & _MASK
        big_s0 = ((a >> 2) | (a << 30)) & _MASK
        big_s0 ^= ((a >> 13) | (a << 19)) & _MASK
        big_s0 ^= ((a >> 22) | (a << 10)) & _MASK
        maj = (a & b) ^ (a & c) ^ (b & c)
        t2 = (big_s0 + maj) & _MASK
        hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & _MASK, c, b, a, (t1 + t2) & _MASK
    return [(x + y) & _MASK for x, y in
            zip(h, (a, b, c, d, e, f, g, hh))]


class Sha256:
    digest_size = 32
    block_size = 64

    def __init__(self, data: bytes = b""):
        self._h = list(_H0)
        self._len = 0
        self._buf = b""
        if data:
            self.update(data)

    def update(self, data) -> "Sha256":
        data = bytes(data)
        self._len += len(data)
        data = self._buf + data
        end = len(data) - (len(data) % 64)
        for off in range(0, end, 64):
            self._h = _compress(self._h, data[off:off + 64])
        self._buf = data[end:]
        return self

    def digest(self) -> bytes:
        h = list(self._h)
        pad_len = (55 - self._len) % 64
        tail = self._buf + b"\x80" + b"\x00" * pad_len + struct.pack(">Q", self._len * 8)
        for off in range(0, len(tail), 64):
            h = _compress(h, tail[off:off + 64])
        return struct.pack(">8I", *h)

    def hexdigest(self) -> str:
        return self.digest().hex()

    def getstate(self) -> bytes:
        """Serialize the rolling state (including partial block) to bytes."""
        return (struct.pack(">8I", *self._h)
                + struct.pack(">Q", self._len)
                + bytes((len(self._buf),))
                + self._buf)

    @classmethod
    def fromstate(cls, state: bytes) -> "Sha256":
        if len(state) < 41:
            raise ValueError("truncated sha256 state")
        obj = cls()
        obj._h = list(struct.unpack(">8I", state[:32]))
        obj._len = struct.unpack(">Q", state[32:40])[0]
        buf_len = state[40]
        if buf_len >= 64 or len(state) != 41 + buf_len:
            raise ValueError("corrupt sha256 state")
        obj._buf = state[41:]
        if obj._len < buf_len or (obj._len - buf_len) % 64 != 0:
            raise ValueError("inconsistent sha256 state")
        return obj
