package telemetry

import (
	"errors"
	"io"
	"math"
	"testing"
)

var varintValues = []uint64{
	0, 1, 2, 0x7f, 0x80, 0x81, 300, 0x3fff, 0x4000,
	1 << 21, 1<<21 - 1, 1 << 32, 1<<35 + 7, 1 << 63,
	math.MaxUint64 - 1, math.MaxUint64,
}

// TestVarintRoundTrip round-trips varints in both bit orders, including
// at an unaligned bit offset.
func TestVarintRoundTrip(t *testing.T) {
	for _, o := range orders {
		for _, offset := range []int{0, 3} {
			for _, v := range varintValues {
				wr := NewWriter(o.order)
				for i := 0; i < offset; i++ {
					wr.WriteBit(1)
				}
				if err := wr.WriteVarint(v); err != nil {
					t.Fatalf("%s off=%d v=%d: %v", o.name, offset, v, err)
				}
				r := NewReaderBits(wr.Bytes(), wr.Pos(), o.order)
				for i := 0; i < offset; i++ {
					if _, err := r.ReadBit(); err != nil {
						t.Fatalf("%s off=%d v=%d: %v", o.name, offset, v, err)
					}
				}
				got, err := r.ReadVarint()
				if err != nil {
					t.Fatalf("%s off=%d v=%d: %v", o.name, offset, v, err)
				}
				if got != v {
					t.Fatalf("%s off=%d: wrote %d, read %d", o.name, offset, v, got)
				}
				if r.Pos() != wr.Pos() {
					t.Fatalf("%s off=%d v=%d: pos=%d want %d", o.name, offset, v, r.Pos(), wr.Pos())
				}
			}
		}
	}
}

// TestVarintSignedRoundTrip round-trips zigzag varints.
func TestVarintSignedRoundTrip(t *testing.T) {
	vals := []int64{0, 1, -1, 2, -2, 63, -64, 300, -300,
		1 << 40, -(1 << 40), math.MaxInt64, math.MinInt64}
	for _, o := range orders {
		for _, v := range vals {
			wr := NewWriter(o.order)
			if err := wr.WriteVarintSigned(v); err != nil {
				t.Fatalf("%s v=%d: %v", o.name, v, err)
			}
			r := NewReaderBits(wr.Bytes(), wr.Pos(), o.order)
			got, err := r.ReadVarintSigned()
			if err != nil {
				t.Fatalf("%s v=%d: %v", o.name, v, err)
			}
			if got != v {
				t.Fatalf("%s: wrote %d, read %d", o.name, v, got)
			}
		}
	}
}

// writeRawVarintGroups emits groups of (7 payload bits, continuation bit)
// directly, allowing deliberately malformed encodings.
func writeRawVarintGroups(w *Writer, groups ...[2]uint64) {
	for _, g := range groups {
		w.WriteBits(g[0], 7)
		w.WriteBit(g[1])
	}
}

// TestVarintOverlongRejected checks that non-minimal encodings are
// rejected without advancing the cursor, and that reading recovers.
func TestVarintOverlongRejected(t *testing.T) {
	for _, o := range orders {
		cases := []struct {
			name   string
			groups [][2]uint64
		}{
			{"zero in two groups", [][2]uint64{{0, 1}, {0, 0}}},
			{"five in two groups", [][2]uint64{{5, 1}, {0, 0}}},
			{"300 in three groups", [][2]uint64{{44, 1}, {2, 1}, {0, 0}}},
			{"zero in ten groups", [][2]uint64{{0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 0}}},
		}
		for _, c := range cases {
			wr := NewWriter(o.order)
			writeRawVarintGroups(wr, c.groups...)
			if err := wr.WriteVarint(300); err != nil { // recovery sentinel
				t.Fatal(err)
			}
			r := NewReaderBits(wr.Bytes(), wr.Pos(), o.order)
			if _, err := r.ReadVarint(); !errors.Is(err, ErrOverlong) {
				t.Fatalf("%s %s: want ErrOverlong, got %v", o.name, c.name, err)
			}
			if r.Pos() != 0 {
				t.Fatalf("%s %s: cursor advanced to %d on rejection", o.name, c.name, r.Pos())
			}
			// Error recovery: skip the bad encoding, read the good one.
			r.Seek(len(c.groups) * 8)
			got, err := r.ReadVarint()
			if err != nil || got != 300 {
				t.Fatalf("%s %s: recovery read = %d, %v", o.name, c.name, got, err)
			}
		}
	}
}

// TestVarintOverflowRejected checks that encodings exceeding 64 bits are
// rejected without advancing the cursor.
func TestVarintOverflowRejected(t *testing.T) {
	for _, o := range orders {
		cases := []struct {
			name   string
			groups [][2]uint64
		}{
			{"eleventh group", [][2]uint64{{1, 1}, {1, 1}, {1, 1}, {1, 1}, {1, 1}, {1, 1}, {1, 1}, {1, 1}, {1, 1}, {1, 1}, {0, 0}}},
			{"tenth group too large", [][2]uint64{{0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {0x7f, 1}, {2, 0}}},
			{"continuation past tenth", [][2]uint64{{0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 1}, {1, 1}}},
		}
		for _, c := range cases {
			wr := NewWriter(o.order)
			writeRawVarintGroups(wr, c.groups...)
			if err := wr.WriteVarint(42); err != nil {
				t.Fatal(err)
			}
			r := NewReaderBits(wr.Bytes(), wr.Pos(), o.order)
			if _, err := r.ReadVarint(); !errors.Is(err, ErrOverflow) {
				t.Fatalf("%s %s: want ErrOverflow, got %v", o.name, c.name, err)
			}
			if r.Pos() != 0 {
				t.Fatalf("%s %s: cursor advanced to %d on rejection", o.name, c.name, r.Pos())
			}
			r.Seek(len(c.groups) * 8)
			got, err := r.ReadVarint()
			if err != nil || got != 42 {
				t.Fatalf("%s %s: recovery read = %d, %v", o.name, c.name, got, err)
			}
		}
	}
}

// TestVarintEOFRecovery checks that a varint truncated mid-stream leaves
// the cursor unmoved, and the same reader succeeds once more bytes are
// cached.
func TestVarintEOFRecovery(t *testing.T) {
	for _, o := range orders {
		wr := NewWriter(o.order)
		if err := wr.WriteVarint(1 << 40); err != nil { // 7 groups = 56 bits
			t.Fatal(err)
		}
		full := wr.Bytes()
		r := NewReaderBits(full[:3], 24, o.order) // only first 3 bytes
		if _, err := r.ReadVarint(); !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("%s: want EOF, got %v", o.name, err)
		}
		if r.Pos() != 0 {
			t.Fatalf("%s: cursor advanced to %d on EOF", o.name, r.Pos())
		}
		r = NewReaderBits(full, wr.Pos(), o.order)
		got, err := r.ReadVarint()
		if err != nil || got != 1<<40 {
			t.Fatalf("%s: got %d, %v", o.name, got, err)
		}
	}
}
