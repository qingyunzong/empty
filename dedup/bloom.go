package dedup

import (
	"encoding/binary"
	"hash/fnv"
	"math"
)

// bloomFilter is a deterministic Bloom filter. Hash positions depend only on
// the key and the filter parameters, never on process-local state, so a
// filter restored from a checkpoint exhibits exactly the same false-positive
// behaviour as the original.
type bloomFilter struct {
	words []uint64
	m     uint64 // number of bits
	k     uint64 // number of hash functions
}

func newBloomFilter(expected int, fpRate float64) *bloomFilter {
	n := uint64(expected)
	if n == 0 {
		n = 1
	}
	m := uint64(math.Ceil(-float64(n) * math.Log(fpRate) / (math.Ln2 * math.Ln2)))
	if m < 64 {
		m = 64
	}
	k := uint64(math.Round(float64(m) / float64(n) * math.Ln2))
	if k < 1 {
		k = 1
	}
	if k > 64 {
		k = 64
	}
	return &bloomFilter{
		words: make([]uint64, (m+63)/64),
		m:     m,
		k:     k,
	}
}

// hashPair derives two independent 64-bit hashes of key using FNV-1a with a
// fixed domain-separation suffix. Double hashing (h1 + i*h2) yields the k
// probe positions.
func hashPair(key string) (uint64, uint64) {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	h1 := h.Sum64()
	_, _ = h.Write([]byte{0x9e, 0x37, 0x79, 0xb9})
	h2 := h.Sum64() | 1 // must be non-zero and odd for good probing
	return h1, h2
}

func (b *bloomFilter) add(key string) {
	h1, h2 := hashPair(key)
	for i := uint64(0); i < b.k; i++ {
		pos := (h1 + i*h2) % b.m
		b.words[pos/64] |= 1 << (pos % 64)
	}
}

// mayContain reports whether key was probably added. It never returns false
// for a key that was added (no false negatives).
func (b *bloomFilter) mayContain(key string) bool {
	h1, h2 := hashPair(key)
	for i := uint64(0); i < b.k; i++ {
		pos := (h1 + i*h2) % b.m
		if b.words[pos/64]&(1<<(pos%64)) == 0 {
			return false
		}
	}
	return true
}

func (b *bloomFilter) appendTo(buf []byte) []byte {
	buf = binary.AppendUvarint(buf, uint64(len(b.words)))
	for _, w := range b.words {
		var tmp [8]byte
		binary.LittleEndian.PutUint64(tmp[:], w)
		buf = append(buf, tmp[:]...)
	}
	return buf
}

func bloomFilterFromBytes(data []byte, off *int, m, k uint64) (*bloomFilter, error) {
	n, err := binary.ReadUvarint(byteReader{data, off})
	if err != nil {
		return nil, err
	}
	if want := (m + 63) / 64; n != want {
		return nil, errCorruptCheckpoint
	}
	words := make([]uint64, n)
	for i := range words {
		if *off+8 > len(data) {
			return nil, errCorruptCheckpoint
		}
		words[i] = binary.LittleEndian.Uint64(data[*off:])
		*off += 8
	}
	return &bloomFilter{words: words, m: m, k: k}, nil
}

// byteReader adapts a byte slice with a cursor to io.ByteReader.
type byteReader struct {
	data []byte
	off  *int
}

func (r byteReader) ReadByte() (byte, error) {
	if *r.off >= len(r.data) {
		return 0, errCorruptCheckpoint
	}
	b := r.data[*r.off]
	*r.off++
	return b, nil
}
