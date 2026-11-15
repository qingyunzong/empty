package dataeng

import (
	"encoding/binary"
	"math"
)

func rotl64(x uint64, r uint) uint64 { return x<<r | x>>(64-r) }

// murmur3x64_128 returns the two 64-bit halves of MurmurHash3 x64 128. ORC's
// bloom filters use a 64-bit projection of this hash for strings and binary
// values.
func murmur3x64_128(data []byte, seed uint64) (uint64, uint64) {
	const (
		c1 = uint64(0x87c37b91114253d5)
		c2 = uint64(0x4cf5ad432745937f)
	)
	h1, h2 := seed, seed
	n := len(data)
	i := 0
	for ; i+16 <= n; i += 16 {
		k1 := binary.LittleEndian.Uint64(data[i:])
		k2 := binary.LittleEndian.Uint64(data[i+8:])

		k1 *= c1
		k1 = rotl64(k1, 31)
		k1 *= c2
		h1 ^= k1

		h1 = rotl64(h1, 27)
		h1 += h2
		h1 = h1*5 + 0x52dce729

		k2 *= c2
		k2 = rotl64(k2, 33)
		k2 *= c1
		h2 ^= k2

		h2 = rotl64(h2, 31)
		h2 += h1
		h2 = h2*5 + 0x38495ab5
	}

	var k1, k2 uint64
	tail := data[i:]
	switch len(tail) {
	case 15:
		k2 ^= uint64(tail[14]) << 48
		fallthrough
	case 14:
		k2 ^= uint64(tail[13]) << 40
		fallthrough
	case 13:
		k2 ^= uint64(tail[12]) << 32
		fallthrough
	case 12:
		k2 ^= uint64(tail[11]) << 24
		fallthrough
	case 11:
		k2 ^= uint64(tail[10]) << 16
		fallthrough
	case 10:
		k2 ^= uint64(tail[9]) << 8
		fallthrough
	case 9:
		k2 ^= uint64(tail[8])
		k2 *= c2
		k2 = rotl64(k2, 33)
		k2 *= c1
		h2 ^= k2
		fallthrough
	case 8:
		k1 ^= uint64(tail[7]) << 56
		fallthrough
	case 7:
		k1 ^= uint64(tail[6]) << 48
		fallthrough
	case 6:
		k1 ^= uint64(tail[5]) << 40
		fallthrough
	case 5:
		k1 ^= uint64(tail[4]) << 32
		fallthrough
	case 4:
		k1 ^= uint64(tail[3]) << 24
		fallthrough
	case 3:
		k1 ^= uint64(tail[2]) << 16
		fallthrough
	case 2:
		k1 ^= uint64(tail[1]) << 8
		fallthrough
	case 1:
		k1 ^= uint64(tail[0])
		k1 *= c1
		k1 = rotl64(k1, 31)
		k1 *= c2
		h1 ^= k1
	}

	h1 ^= uint64(n)
	h2 ^= uint64(n)
	h1 += h2
	h2 += h1
	h1 = fmix64(h1)
	h2 = fmix64(h2)
	h1 += h2
	h2 += h1
	return h1, h2
}

func fmix64(k uint64) uint64 {
	k ^= k >> 33
	k *= 0xff51afd7ed558ccd
	k ^= k >> 33
	k *= 0xc4ceb9fe1a85ec53
	k ^= k >> 33
	return k
}

// wangHash64 is the 64-bit integer mixer used by older ORC bloom filters.
func wangHash64(key uint64) uint64 {
	key = ^key + (key << 21)
	key ^= key >> 24
	key = (key + (key << 3)) + (key << 8)
	key ^= key >> 14
	key = (key + (key << 2)) + (key << 4)
	key ^= key >> 28
	key += key << 31
	return key
}

func (b *BloomFilter) words() [][]uint64 {
	var out [][]uint64
	if len(b.Bitset) > 0 {
		out = append(out, b.Bitset)
	}
	if len(b.UTF8Bitset) > 0 && len(b.UTF8Bitset)%8 == 0 {
		le := make([]uint64, len(b.UTF8Bitset)/8)
		be := make([]uint64, len(b.UTF8Bitset)/8)
		for i := range le {
			le[i] = binary.LittleEndian.Uint64(b.UTF8Bitset[i*8:])
			be[i] = binary.BigEndian.Uint64(b.UTF8Bitset[i*8:])
		}
		// The Java writer historically serialized utf8bitset through a
		// ByteBuffer. Accept both byte orders; testing both can only add false
		// positives, never remove a present value.
		out = append(out, le, be)
	}
	return out
}

// Trusted reports whether the filter has enough structure to be used for
// pruning. A malformed filter must be treated as may-match.
func (b *BloomFilter) Trusted() bool {
	if b == nil || b.NumHashFunctions == 0 || b.NumHashFunctions > 128 {
		return false
	}
	if len(b.Bitset) > 0 {
		return true
	}
	return len(b.UTF8Bitset) > 0 && len(b.UTF8Bitset)%8 == 0
}

func (b *BloomFilter) containsHash(hash uint64) bool {
	sets := b.words()
	if len(sets) == 0 {
		return true
	}
	h1 := int32(uint32(hash))
	h2 := int32(uint32(hash >> 32))
	for _, bits := range sets {
		bitsLen := uint32(len(bits) * 64)
		if bitsLen == 0 {
			continue
		}
		ok := true
		for k := uint32(1); k <= b.NumHashFunctions; k++ {
			combined := int32(int64(h1) + int64(k)*int64(h2))
			if combined < 0 {
				combined = ^combined
			}
			pos := uint32(combined) % bitsLen
			if bits[pos>>6]&(uint64(1)<<(pos&63)) == 0 {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func (b *BloomFilter) containsAnyHash(hashes ...uint64) bool {
	for _, h := range hashes {
		if b.containsHash(h) {
			return true
		}
	}
	return false
}

// MightContainLong checks the integer/double/timestamp representations used by
// ORC. Both the Thomas Wang and Murmur3 projections are accepted so that old
// and new writers remain safe.
func (b *BloomFilter) MightContainLong(v int64) bool {
	if !b.Trusted() {
		return true
	}
	u := uint64(v)
	h1, h2 := murmur3x64_128(binaryLittleEndianBytes8(u), 0)
	return b.containsAnyHash(wangHash64(u), h1, h2)
}

func (b *BloomFilter) MightContainDouble(v float64) bool {
	return b.MightContainLong(int64(mathFloat64bits(v)))
}

func (b *BloomFilter) MightContainString(v string) bool {
	if !b.Trusted() {
		return true
	}
	utf8 := []byte(v)
	h1, h2 := murmur3x64_128(utf8, 0)
	hashes := []uint64{h1, h2}

	// The original ORC bloom filter hashed Java's UTF-16 code units for some
	// writer versions.
	utf16le := make([]byte, 0, len(v)*2)
	utf16be := make([]byte, 0, len(v)*2)
	for _, r := range v {
		if r <= 0xffff {
			utf16le = append(utf16le, byte(r), byte(r>>8))
			utf16be = append(utf16be, byte(r>>8), byte(r))
		} else {
			r -= 0x10000
			hi := 0xd800 + (r >> 10)
			lo := 0xdc00 + (r & 0x3ff)
			utf16le = append(utf16le, byte(hi), byte(hi>>8), byte(lo), byte(lo>>8))
			utf16be = append(utf16be, byte(hi>>8), byte(hi), byte(lo>>8), byte(lo))
		}
	}
	a, c := murmur3x64_128(utf16le, 0)
	hashes = append(hashes, a, c)
	a, c = murmur3x64_128(utf16be, 0)
	hashes = append(hashes, a, c)
	return b.containsAnyHash(hashes...)
}

func (b *BloomFilter) MightContainBytes(v []byte) bool {
	if !b.Trusted() {
		return true
	}
	h1, h2 := murmur3x64_128(v, 0)
	return b.containsAnyHash(h1, h2)
}

func binaryLittleEndianBytes8(v uint64) []byte {
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], v)
	return buf[:]
}

func mathFloat64bits(v float64) uint64 {
	// Kept in a tiny helper so bloom.go does not need math in its import list.
	return math.Float64bits(v)
}
