package telemetry

import (
	"errors"
	"io"
	"testing"
)

var orders = []struct {
	name  string
	order BitOrder
}{
	{"msb", MSBFirst},
	{"lsb", LSBFirst},
}

func dedupU(in []uint64) []uint64 {
	seen := map[uint64]bool{}
	var out []uint64
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func dedupS(in []int64) []int64 {
	seen := map[int64]bool{}
	var out []int64
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func unsignedEdges(w int) []uint64 {
	mask := uint64(1)<<uint(w) - 1
	return dedupU([]uint64{
		0, 1, mask, mask - 1,
		uint64(1) << uint(w-1), uint64(1)<<uint(w-1) - 1,
		0xAAAAAAAAAAAAAAAA & mask, 0x5555555555555555 & mask,
		mask / 3,
	})
}

func signedEdges(w int) []int64 {
	min := -(int64(1) << uint(w-1))
	max := int64(1)<<uint(w-1) - 1
	var out []int64
	for _, v := range dedupS([]int64{0, 1, -1, 2, -2, min, max, min + 1, max - 1, min / 2, max / 2}) {
		if v >= min && v <= max {
			out = append(out, v)
		}
	}
	return out
}

// TestUnsignedRoundTrip1To17 enumerates widths 1..17 and edge values for
// each width, checking encode/decode round-trips in both bit orders.
func TestUnsignedRoundTrip1To17(t *testing.T) {
	for _, o := range orders {
		for w := 1; w <= 17; w++ {
			for _, v := range unsignedEdges(w) {
				wr := NewWriter(o.order)
				if err := wr.WriteBits(v, w); err != nil {
					t.Fatalf("%s w=%d v=%d: write: %v", o.name, w, v, err)
				}
				if wr.Pos() != w {
					t.Fatalf("%s w=%d v=%d: pos=%d", o.name, w, v, wr.Pos())
				}
				r := NewReaderBits(wr.Bytes(), w, o.order)
				got, err := r.ReadBits(w)
				if err != nil {
					t.Fatalf("%s w=%d v=%d: read: %v", o.name, w, v, err)
				}
				if got != v {
					t.Fatalf("%s w=%d: wrote %d, read %d", o.name, w, v, got)
				}
				if r.Pos() != w {
					t.Fatalf("%s w=%d: reader pos=%d", o.name, w, r.Pos())
				}
			}
		}
	}
}

// TestUnsignedTruncation1To17 checks that every truncation point — values
// needing one more bit than the field provides — is rejected without
// advancing the writer cursor.
func TestUnsignedTruncation1To17(t *testing.T) {
	for _, o := range orders {
		for w := 1; w <= 17; w++ {
			for _, v := range []uint64{uint64(1) << uint(w), uint64(1)<<uint(w) + 1, ^uint64(0)} {
				wr := NewWriter(o.order)
				err := wr.WriteBits(v, w)
				if !errors.Is(err, ErrOverflow) {
					t.Fatalf("%s w=%d v=%d: want ErrOverflow, got %v", o.name, w, v, err)
				}
				if wr.Pos() != 0 {
					t.Fatalf("%s w=%d v=%d: cursor advanced to %d on rejection", o.name, w, v, wr.Pos())
				}
				// Error recovery: the writer stays usable after rejection.
				if err := wr.WriteBits(v&((uint64(1)<<uint(w))-1), w); err != nil {
					t.Fatalf("%s w=%d: write after rejection: %v", o.name, w, err)
				}
			}
		}
	}
}

// TestSignedRoundTrip1To17 enumerates signed widths 1..17 and edge values,
// checking two's complement round-trips and sign extension.
func TestSignedRoundTrip1To17(t *testing.T) {
	for _, o := range orders {
		for w := 1; w <= 17; w++ {
			for _, v := range signedEdges(w) {
				wr := NewWriter(o.order)
				if err := wr.WriteSigned(v, w); err != nil {
					t.Fatalf("%s w=%d v=%d: write: %v", o.name, w, v, err)
				}
				r := NewReaderBits(wr.Bytes(), w, o.order)
				got, err := r.ReadSigned(w)
				if err != nil {
					t.Fatalf("%s w=%d v=%d: read: %v", o.name, w, v, err)
				}
				if got != v {
					t.Fatalf("%s w=%d: wrote %d, read %d", o.name, w, v, got)
				}
			}
		}
	}
}

// TestSignedOutOfRange1To17 checks rejection one step past each signed
// range boundary, with the cursor left unmoved.
func TestSignedOutOfRange1To17(t *testing.T) {
	for _, o := range orders {
		for w := 1; w <= 17; w++ {
			min := -(int64(1) << uint(w-1))
			max := int64(1)<<uint(w-1) - 1
			for _, v := range []int64{min - 1, max + 1} {
				wr := NewWriter(o.order)
				err := wr.WriteSigned(v, w)
				if !errors.Is(err, ErrOutOfRange) {
					t.Fatalf("%s w=%d v=%d: want ErrOutOfRange, got %v", o.name, w, v, err)
				}
				if wr.Pos() != 0 {
					t.Fatalf("%s w=%d v=%d: cursor advanced to %d on rejection", o.name, w, v, wr.Pos())
				}
			}
		}
	}
}

// TestMixedWidthStream writes widths 1..17 back to back so fields land on
// every possible bit offset, then reads them all back.
func TestMixedWidthStream(t *testing.T) {
	for _, o := range orders {
		wr := NewWriter(o.order)
		var want []uint64
		for w := 1; w <= 17; w++ {
			v := (0x12345 * uint64(w)) & (uint64(1)<<uint(w) - 1)
			if err := wr.WriteBits(v, w); err != nil {
				t.Fatalf("%s w=%d: %v", o.name, w, err)
			}
			want = append(want, v)
		}
		total := wr.Pos()
		r := NewReaderBits(wr.Bytes(), total, o.order)
		for i, w := 0, 1; w <= 17; i, w = i+1, w+1 {
			got, err := r.ReadBits(w)
			if err != nil {
				t.Fatalf("%s w=%d: %v", o.name, w, err)
			}
			if got != want[i] {
				t.Fatalf("%s w=%d: wrote %d, read %d", o.name, w, want[i], got)
			}
		}
		if r.Pos() != total {
			t.Fatalf("%s: pos=%d want %d", o.name, r.Pos(), total)
		}
	}
}

// TestReadTruncationRollsBack checks that a read hitting end of stream
// leaves the cursor where it started.
func TestReadTruncationRollsBack(t *testing.T) {
	for _, o := range orders {
		for w := 1; w <= 17; w++ {
			r := NewReaderBits([]byte{0xff, 0xff, 0xff}, 24, o.order)
			if _, err := r.ReadBits(24 - w); err != nil {
				t.Fatalf("%s w=%d: %v", o.name, w, err)
			}
			mark := r.Pos()
			if _, err := r.ReadBits(w + 1); !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("%s w=%d: expected EOF error, got %v", o.name, w, err)
			}
			if r.Pos() != mark {
				t.Fatalf("%s w=%d: cursor moved from %d to %d on failed read", o.name, w, mark, r.Pos())
			}
		}
	}
}

// TestAlignByteBoundary checks byte alignment from every bit offset.
func TestAlignByteBoundary(t *testing.T) {
	for _, o := range orders {
		for pre := 0; pre < 8; pre++ {
			wr := NewWriter(o.order)
			for i := 0; i < pre; i++ {
				wr.WriteBit(1)
			}
			pad, err := wr.Align(8)
			if err != nil {
				t.Fatalf("%s pre=%d: %v", o.name, pre, err)
			}
			if want := (8 - pre) % 8; pad != want {
				t.Fatalf("%s pre=%d: pad=%d want %d", o.name, pre, pad, want)
			}
			if wr.Pos()%8 != 0 {
				t.Fatalf("%s pre=%d: pos=%d not byte aligned", o.name, pre, wr.Pos())
			}
			if err := wr.WriteBits(0xA5, 8); err != nil {
				t.Fatalf("%s pre=%d: %v", o.name, pre, err)
			}
			r := NewReaderBits(wr.Bytes(), wr.Pos(), o.order)
			for i := 0; i < pre; i++ {
				if b, _ := r.ReadBit(); b != 1 {
					t.Fatalf("%s pre=%d: prefix bit %d lost", o.name, pre, i)
				}
			}
			if p, _ := r.Align(8); p != pad {
				t.Fatalf("%s pre=%d: reader pad=%d want %d", o.name, pre, p, pad)
			}
			if v, _ := r.ReadBits(8); v != 0xA5 {
				t.Fatalf("%s pre=%d: read %#x want 0xa5", o.name, pre, v)
			}
		}
	}
}
