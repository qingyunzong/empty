package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math/bits"
	"testing"
)

func craftWire(b, S int, n uint64, classCounts []int, ordinals []uint64) []byte {
	header := make([]byte, HeaderSize)
	header[0] = byte(b)
	binary.LittleEndian.PutUint32(header[1:5], uint32(S))
	binary.LittleEndian.PutUint64(header[5:13], n)

	w := bitWriter{}
	cb := classWidth(b)
	blockCount := (n + uint64(b) - 1) / uint64(b)
	for blockIdx := uint64(0); blockIdx < blockCount; blockIdx++ {
		start := blockIdx * uint64(b)
		m := int(n - start)
		if m > b {
			m = b
		}
		c := classCounts[blockIdx]
		w.write(uint64(c), cb)
		w.write(ordinals[blockIdx], minWidth(binomial(m, c)))
	}
	return append(header, w.buf...)
}

func headerOnly(b int, S uint32, n uint64) []byte {
	out := make([]byte, HeaderSize)
	out[0] = byte(b)
	binary.LittleEndian.PutUint32(out[1:5], S)
	binary.LittleEndian.PutUint64(out[5:13], n)
	return out
}

func wireField(data []byte, b int, block uint64, n uint64) (c int, ordinal uint64, width uint, classOff uint64, next uint64) {
	payload := data[HeaderSize:]
	cb := classWidth(b)
	off := uint64(0)
	for blockIdx := uint64(0); blockIdx <= block; blockIdx++ {
		start := blockIdx * uint64(b)
		m := int(n - start)
		if m > b {
			m = b
		}
		v, err := readBits(payload, off, cb)
		if err != nil {
			panic(err)
		}
		c = int(v)
		width = minWidth(binomial(m, c))
		classOff = off
		if blockIdx == block {
			ordinal, err = readBits(payload, off+uint64(cb), width)
			if err != nil {
				panic(err)
			}
			next = off + uint64(cb) + uint64(width)
			return
		}
		off += uint64(cb) + uint64(width)
	}
	panic("unreachable")
}

func TestHeaderLayout(t *testing.T) {
	bits := []byte{1, 0, 1, 1, 0}
	data, err := Encode(bits, 5, 123)
	if err != nil {
		t.Fatal(err)
	}
	if data[0] != 5 {
		t.Fatalf("b=%d", data[0])
	}
	if got := binary.LittleEndian.Uint32(data[1:5]); got != 123 {
		t.Fatalf("S=%d", got)
	}
	if got := binary.LittleEndian.Uint64(data[5:13]); got != uint64(len(bits)) {
		t.Fatalf("N=%d", got)
	}
}

func TestKnownWireBytes(t *testing.T) {
	// b=3,N=4, bits 1011:
	// block 0: c=2 (2 bits: 10), ordinal 1 of C(3,2)=3 (2 bits: 01)
	// block 1: m=1,c=1 (2 bits: 01), w=0
	// payload bits 100101, low padding 00 => 0x94.
	data, err := Encode([]byte{1, 0, 1, 1}, 3, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := append(headerOnly(3, 1, 4), 0x94)
	if !bytes.Equal(data, want) {
		t.Fatalf("wire=% x want=% x", data, want)
	}
}

func TestWireOrdinalMatchesIndependentEnumeration(t *testing.T) {
	const m = 5
	const c = 2
	limit := uint64(1) << m
	for pattern := uint64(0); pattern < limit; pattern++ {
		if bits.OnesCount64(pattern) != c {
			continue
		}
		var independent uint64
		for v := uint64(0); v < pattern; v++ {
			if bits.OnesCount64(v) == c {
				independent++
			}
		}
		bitsIn := make([]byte, m)
		for j := 0; j < m; j++ {
			bitsIn[j] = byte((pattern >> uint(m-1-j)) & 1)
		}
		data, err := Encode(bitsIn, m, 1)
		if err != nil {
			t.Fatal(err)
		}
		classCount, ordinal, _, _, _ := wireField(data, m, 0, m)
		if classCount != c {
			t.Fatalf("class=%d want %d", classCount, c)
		}
		if ordinal != independent {
			t.Fatalf("pattern %05b wire ordinal=%d want %d", pattern, ordinal, independent)
		}
	}
}

func TestNZeroHeaderOnly(t *testing.T) {
	data, err := Encode(nil, 7, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != HeaderSize {
		t.Fatalf("N=0 encoding length %d", len(data))
	}
	ix, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	if ix.Len() != 0 || ix.TotalOnes() != 0 || ix.TotalZeros() != 0 {
		t.Fatalf("unexpected empty index metadata")
	}
	if _, err := ix.Access(0); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Access(0) on empty index: %v", err)
	}
	if _, err := ix.Rank1(1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Rank1(1) on empty index: %v", err)
	}
	if rank, err := ix.Rank1(0); err != nil || rank != 0 {
		t.Fatalf("Rank1(0)=(%d,%v)", rank, err)
	}
	if rank, err := ix.Rank0(0); err != nil || rank != 0 {
		t.Fatalf("Rank0(0)=(%d,%v)", rank, err)
	}
	if pos, found, err := ix.Select1(0); err != nil || found || pos != 0 {
		t.Fatalf("Select1(0)=(%d,%v,%v)", pos, found, err)
	}
	if pos, found, err := ix.Select0(0); err != nil || found || pos != 0 {
		t.Fatalf("Select0(0)=(%d,%v,%v)", pos, found, err)
	}
	if _, _, err := ix.Select1(-1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Select1(-1): %v", err)
	}

	if _, err := Open(append(append([]byte(nil), data...), 0)); !errors.Is(err, ErrTrailingData) {
		t.Fatalf("N=0 with payload: %v", err)
	}
}

func TestInvalidHeader(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		err  error
	}{
		{"short header", make([]byte, HeaderSize-1), ErrTruncated},
		{"b=0", headerOnly(0, 1, 1), ErrMalformedHeader},
		{"b=64", headerOnly(64, 1, 1), ErrMalformedHeader},
		{"S=0", headerOnly(1, 0, 1), ErrMalformedHeader},
		{"S=4097", headerOnly(1, 4097, 1), ErrMalformedHeader},
		{"N too large", headerOnly(1, 1, MaxLength+1), ErrMalformedHeader},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Open(tc.data); !errors.Is(err, tc.err) {
				t.Fatalf("Open error=%v want %v", err, tc.err)
			}
		})
	}
}

func TestInvalidClassAndOrdinal(t *testing.T) {
	// m=2, c=3 is impossible.
	badClass := craftWire(2, 7, 2, []int{3}, []uint64{0})
	if _, err := Open(badClass); !errors.Is(err, ErrMalformedPayload) {
		t.Fatalf("c>m accepted: %v", err)
	}

	// m=5, c=2 has C=10.  Ordinal 9 is C-1 and valid; ordinal 10 is invalid.
	valid := craftWire(5, 3, 5, []int{2}, []uint64{9})
	ix, err := Open(valid)
	if err != nil {
		t.Fatalf("valid ordinal C-1 rejected: %v", err)
	}
	for i, want := range []uint8{1, 1, 0, 0, 0} {
		got, err := ix.Access(uint64(i))
		if err != nil || got != want {
			t.Fatalf("Access(%d)=(%d,%v) want %d", i, got, err, want)
		}
	}
	if _, err := ix.Access(5); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Access beyond N: %v", err)
	}
	if _, err := ix.Rank1(6); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Rank1 beyond N: %v", err)
	}
	if _, _, err := ix.Select0(-1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Select0(-1): %v", err)
	}

	invalid := craftWire(5, 3, 5, []int{2}, []uint64{10})
	if _, err := Open(invalid); !errors.Is(err, ErrMalformedPayload) {
		t.Fatalf("ordinal=C accepted: %v", err)
	}
}

func TestLargestOrdinalAtMaximumBlockWidth(t *testing.T) {
	const m = 63
	const c = 31
	combinations := binomial(m, c)
	if width := minWidth(combinations); width < 32 {
		t.Fatalf("unexpectedly small max-width ordinal width %d", width)
	}

	// The numerically largest 63-bit word with 31 ones has ones in the
	// leading 31 positions.
	bitsIn := make([]byte, m)
	for i := 0; i < c; i++ {
		bitsIn[i] = 1
	}
	data, err := Encode(bitsIn, m, 1)
	if err != nil {
		t.Fatal(err)
	}
	classCount, ordinal, width, _, _ := wireField(data, m, 0, m)
	if classCount != c || width != minWidth(combinations) || ordinal != combinations-1 {
		t.Fatalf("class=%d w=%d ordinal=%d want c=%d w=%d ord=%d",
			classCount, width, ordinal, c, minWidth(combinations), combinations-1)
	}
	ix, err := Open(data)
	if err != nil {
		t.Fatalf("C-1 at b=63 rejected: %v", err)
	}
	if _, err := ix.Access(0); err != nil {
		t.Fatal(err)
	}

	invalid := craftWire(m, 1, m, []int{c}, []uint64{combinations})
	if _, err := Open(invalid); !errors.Is(err, ErrMalformedPayload) {
		t.Fatalf("ordinal=C(63,31) accepted: %v", err)
	}
}

func TestZeroWidthBlocksAndTamperedPadding(t *testing.T) {
	for _, bit := range []byte{0, 1} {
		data, err := Encode([]byte{bit}, 63, 1)
		if err != nil {
			t.Fatal(err)
		}
		// b=63 => 6 class bits; C(1,0)=C(1,1)=1 so w=0.
		if len(data) != HeaderSize+1 {
			t.Fatalf("unexpected payload length %d", len(data)-HeaderSize)
		}
		tampered := append([]byte(nil), data...)
		// First padding bit after six payload bits (position 6 in the byte).
		tampered[HeaderSize] |= byte(1 << (7 - (classWidth(63) % 8)))
		if _, err := Open(tampered); !errors.Is(err, ErrBadPadding) {
			t.Fatalf("bit=%d padding accepted: %v", bit, err)
		}
	}
}

func TestTruncationNearZeroWidthBlocks(t *testing.T) {
	// 63 zero bits is one complete all-zero block: 6 class bits, w=0.
	zeros, err := Encode(make([]byte, 63), 63, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(zeros[:HeaderSize]); !errors.Is(err, ErrTruncated) {
		t.Fatalf("missing all-zero class accepted: %v", err)
	}

	// Two all-one blocks: the second class field is genuinely absent.
	ones := make([]byte, 126)
	for i := range ones {
		ones[i] = 1
	}
	allOnes, err := Encode(ones, 63, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(allOnes) != HeaderSize+2 {
		t.Fatalf("unexpected all-one payload length %d", len(allOnes)-HeaderSize)
	}
	if _, err := Open(allOnes[:HeaderSize+1]); !errors.Is(err, ErrTruncated) {
		t.Fatalf("missing second all-one class accepted: %v", err)
	}

	// A w=0 single block whose class survives is complete; removing its
	// class byte is not.
	if _, err := Open(zeros[:HeaderSize+0]); err == nil {
		t.Fatalf("empty payload with N=63 accepted")
	}
}

func TestTrailingBytes(t *testing.T) {
	data, err := Encode([]byte{1}, 4, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(append(append([]byte(nil), data...), 0)); !errors.Is(err, ErrTrailingData) {
		t.Fatalf("trailing zero byte accepted: %v", err)
	}
	if _, err := Open(append(append([]byte(nil), data...), 0xff)); !errors.Is(err, ErrTrailingData) {
		t.Fatalf("trailing nonzero byte accepted: %v", err)
	}
}

func TestLastBlockShortAndFullClass(t *testing.T) {
	bits := makePattern(28, func(i int) byte {
		if i >= 26 {
			return 1
		}
		return byte((i / 3) & 1)
	})
	ix, err := New(bits, 13, 2)
	if err != nil {
		t.Fatal(err)
	}
	// Last block is m=2 and c=m=2, so its ordinal width is zero.
	c, ordinal, width, classOff, next := wireFieldMust(t, bits, 13, 2, 2, 28)
	if c != 2 || width != 0 || ordinal != 0 {
		t.Fatalf("last block c=%d w=%d ord=%d", c, width, ordinal)
	}
	if next != classOff+uint64(classWidth(13)) {
		t.Fatalf("last block consumed ordinal bits")
	}
	if ix.TotalOnes() != referenceRank1(bits, len(bits)) {
		t.Fatalf("total ones mismatch")
	}
	for _, i := range []uint64{26, 27} {
		got, err := ix.Access(i)
		if err != nil || got != 1 {
			t.Fatalf("Access(%d)=(%d,%v)", i, got, err)
		}
	}

	// The same shape with c=0 in the short final block.
	zeroTail := makePattern(28, func(i int) byte {
		if i < 26 {
			return 1
		}
		return 0
	})
	ix, err = New(zeroTail, 13, 2)
	if err != nil {
		t.Fatal(err)
	}
	c, _, width, _, _ = wireFieldMust(t, zeroTail, 13, 2, 2, 28)
	if c != 0 || width != 0 {
		t.Fatalf("zero tail c=%d w=%d", c, width)
	}
	if _, err := ix.Access(26); err != nil {
		t.Fatal(err)
	}
}

func wireFieldMust(t *testing.T, bits []byte, b, S int, block uint64, n uint64) (int, uint64, uint, uint64, uint64) {
	t.Helper()
	data, err := Encode(bits, b, S)
	if err != nil {
		t.Fatal(err)
	}
	return wireField(data, b, block, n)
}

func TestHeaderLengthAndBlockCount(t *testing.T) {
	bits := make([]byte, 100)
	data, err := Encode(bits, 7, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data[:HeaderSize], headerOnly(7, 10, 100)) {
		t.Fatalf("header mismatch")
	}
	ix, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	if ix.BlockCount() != 15 || ix.CheckpointCount() != 2 {
		t.Fatalf("blocks=%d checkpoints=%d", ix.BlockCount(), ix.CheckpointCount())
	}
}

func TestEncodeRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		bits []byte
		b, S int
	}{
		{"b=0", nil, 0, 1},
		{"b=64", nil, 64, 1},
		{"S=0", nil, 1, 0},
		{"S=4097", nil, 1, 4097},
		{"non-bit", []byte{2}, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Encode(tc.bits, tc.b, tc.S); err == nil {
				t.Fatal("Encode accepted invalid input")
			}
		})
	}
}

func TestOpenCopiesSnapshot(t *testing.T) {
	bits := makePattern(80, func(i int) byte { return byte((i*5 + 1) & 1) })
	data, err := Encode(bits, 8, 3)
	if err != nil {
		t.Fatal(err)
	}
	ix, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	before, err := ix.Access(42)
	if err != nil {
		t.Fatal(err)
	}
	for i := HeaderSize; i < len(data); i++ {
		data[i] ^= 0xff
	}
	after, err := ix.Access(42)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("index changed after source mutation: %d -> %d", before, after)
	}
	if rank, err := ix.Rank1(80); err != nil || rank != ix.TotalOnes() {
		t.Fatalf("Rank1(80)=(%d,%v), total=%d", rank, err, ix.TotalOnes())
	}
}

func TestCheckpointDirectoryLayout(t *testing.T) {
	bits := makePattern(37, func(i int) byte { return byte((i*i + 3*i + 1) & 1) })
	const b = 5
	const S = 3
	data, err := Encode(bits, b, S)
	if err != nil {
		t.Fatal(err)
	}
	ix, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	blockCount := ix.BlockCount()
	wantCheckpoints := (blockCount + S - 1) / S
	if uint64(ix.CheckpointCount()) != wantCheckpoints {
		t.Fatalf("checkpoints=%d want %d", ix.CheckpointCount(), wantCheckpoints)
	}
	for i := 0; i < ix.CheckpointCount(); i++ {
		cp, ok := ix.CheckpointAt(i)
		if !ok {
			t.Fatalf("missing checkpoint %d", i)
		}
		wantBlock := uint64(i * S)
		if cp.Block != wantBlock || cp.LogicalStart != wantBlock*uint64(b) {
			t.Fatalf("checkpoint %d block=%d start=%d", i, cp.Block, cp.LogicalStart)
		}
		if cp.OnesBefore != referenceRank1(bits, int(cp.LogicalStart)) {
			t.Fatalf("checkpoint %d onesBefore=%d want %d", i,
				cp.OnesBefore, referenceRank1(bits, int(cp.LogicalStart)))
		}
		_, _, _, classOff, _ := wireField(data, b, cp.Block, uint64(len(bits)))
		if cp.PayloadBitOffset != classOff {
			t.Fatalf("checkpoint %d offset=%d want %d", i, cp.PayloadBitOffset, classOff)
		}
	}
	if _, ok := ix.CheckpointAt(-1); ok {
		t.Fatal("negative checkpoint index accepted")
	}
	if _, ok := ix.CheckpointAt(ix.CheckpointCount()); ok {
		t.Fatal("past-end checkpoint index accepted")
	}
}
