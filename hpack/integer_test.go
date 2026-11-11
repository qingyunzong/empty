package hpack

import (
	"errors"
	"testing"
)

func TestPrefixIntegerMultiByteAndOverflow(t *testing.T) {
	d := newTestDecoder(t, 4096)

	// A 5-bit table-size prefix set to its mask (31) plus a continuation that
	// reaches 5000, above the 4096 connection limit: 31 + 4969, where
	// 4969 = 127 + 127*128 + 7*16384 -> encoded 0x3f 0xff 0xff 0x87 0x00.
	block := tableSizeUpdate(5000)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	// It exceeds the connection limit (4096), so it must be a compression
	// error rather than an unbounded integer accumulation.
	if _, err := d.Write(block); err == nil || !errors.Is(err, ErrCompression) {
		t.Fatalf("large size update err = %v, want compression error", err)
	}
	if !d.Failed() {
		t.Fatal("decoder must fail after out-of-limit size update")
	}
}

func TestPrefixIntegerOverflowPoisons(t *testing.T) {
	d := newTestDecoder(t, 4096)

	// Indexed header prefix 0x7f followed by enough continuation bytes to drive
	// the accumulator past maxInteger (1<<32 - 1).
	block := []byte{0xff}
	for i := 0; i < 8; i++ {
		block = append(block, 0x80)
	}
	block = append(block, 0x01)

	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Write(block); err == nil || !errors.Is(err, ErrCompression) {
		t.Fatalf("overflow err = %v, want compression error", err)
	}
	if !d.Failed() {
		t.Fatal("decoder must fail after prefix-integer overflow")
	}
}

func TestPrefixIntegerExactBoundaries(t *testing.T) {
	// Exercise both the single-byte fast path (value < mask) and the
	// continuation path across several prefix widths, including continuation
	// bytes split across writes.
	for _, tc := range []struct {
		n     uint8
		width uint
	}{{7, 7}, {6, 6}, {5, 5}, {4, 4}} {
		for _, value := range []int{0, 1, (1 << tc.width) - 2, (1 << tc.width) - 1, (1 << tc.width), 200, 1000} {
			encoded := encodeInt(nil, 0, tc.width, value)
			d := newTestDecoder(t, 4096)
			d.buf = encoded
			got, err := d.readInt(tc.n)
			if err != nil {
				t.Fatalf("width %d value %d: %v", tc.width, value, err)
			}
			if got != value || d.off != len(encoded) {
				t.Fatalf("width %d value %d: got %d off %d", tc.width, value, got, d.off)
			}
		}
	}
}
