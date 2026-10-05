package telemcodec

import (
	"errors"
	"testing"
)

var orders = []BitOrder{MSBFirst, LSBFirst}

func unsignedSamples(w int) []uint64 {
	max := mask64(w)
	vals := []uint64{0, 1, max, max - 1, max >> 1}
	var alt uint64
	for i := 0; i < w; i++ {
		if i%2 == 0 {
			alt |= 1 << uint(i)
		}
	}
	return append(vals, alt, alt^max)
}

// Enumerate widths 1..17, round-trip sample values, and probe every
// truncation point to verify the cursor never advances on failure and that
// reads recover once more bits become available.
func TestUnsignedRoundTripAndTruncation(t *testing.T) {
	for _, order := range orders {
		for w := 1; w <= 17; w++ {
			for _, v := range unsignedSamples(w) {
				wr := NewBitWriter(order)
				if err := wr.WriteBits(v, w); err != nil {
					t.Fatalf("order=%d w=%d v=%#x write: %v", order, w, v, err)
				}
				data := wr.Bytes()

				// Full round-trip.
				r := NewBitReaderBytes(data, order)
				got, err := r.ReadBits(w)
				if err != nil || got != v {
					t.Fatalf("order=%d w=%d v=%#x roundtrip got=%#x err=%v", order, w, v, got, err)
				}
				if r.Pos() != int64(w) {
					t.Fatalf("order=%d w=%d pos=%d", order, w, r.Pos())
				}

				// Every truncation point: read must fail without moving
				// the cursor, then recover when the limit is raised.
				for trunc := int64(0); trunc < int64(w); trunc++ {
					tr := NewBitReaderBytes(data, order)
					tr.SetBitLimit(trunc)
					if _, err := tr.ReadBits(w); !errors.Is(err, ErrTruncated) {
						t.Fatalf("order=%d w=%d trunc=%d err=%v", order, w, trunc, err)
					}
					if tr.Pos() != 0 {
						t.Fatalf("order=%d w=%d trunc=%d cursor advanced to %d", order, w, trunc, tr.Pos())
					}
					tr.SetBitLimit(int64(w))
					got, err := tr.ReadBits(w)
					if err != nil || got != v {
						t.Fatalf("order=%d w=%d trunc=%d recovery got=%#x err=%v", order, w, trunc, got, err)
					}
				}
			}
		}
	}
}

func signedSamples(w int) []int64 {
	min := -(int64(1) << uint(w-1))
	max := (int64(1) << uint(w-1)) - 1
	var out []int64
	for _, v := range []int64{min, min + 1, -1, 0, 1, max - 1, max, min / 2, max / 2} {
		if v >= min && v <= max {
			out = append(out, v)
		}
	}
	return out
}

func TestSignedRoundTripOverflowAndTruncation(t *testing.T) {
	for _, order := range orders {
		for w := 1; w <= 17; w++ {
			for _, v := range signedSamples(w) {
				wr := NewBitWriter(order)
				if err := wr.WriteSigned(v, w); err != nil {
					t.Fatalf("order=%d w=%d v=%d write: %v", order, w, v, err)
				}
				r := NewBitReaderBytes(wr.Bytes(), order)
				got, err := r.ReadSigned(w)
				if err != nil || got != v {
					t.Fatalf("order=%d w=%d v=%d roundtrip got=%d err=%v", order, w, v, got, err)
				}
			}
			// Overflow: one past each end must be rejected without writing.
			min := -(int64(1) << uint(w-1))
			max := (int64(1) << uint(w-1)) - 1
			for _, bad := range []int64{min - 1, max + 1} {
				wr := NewBitWriter(order)
				if err := wr.WriteSigned(bad, w); !errors.Is(err, ErrOverflow) {
					t.Fatalf("order=%d w=%d v=%d err=%v", order, w, bad, err)
				}
				if wr.Pos() != 0 {
					t.Fatalf("order=%d w=%d v=%d writer cursor advanced", order, w, bad)
				}
			}
			// Truncated signed read must not advance the cursor.
			wr := NewBitWriter(order)
			if err := wr.WriteSigned(-1, w); err != nil {
				t.Fatal(err)
			}
			for trunc := int64(0); trunc < int64(w); trunc++ {
				tr := NewBitReaderBytes(wr.Bytes(), order)
				tr.SetBitLimit(trunc)
				if _, err := tr.ReadSigned(w); !errors.Is(err, ErrTruncated) {
					t.Fatalf("order=%d w=%d trunc=%d err=%v", order, w, trunc, err)
				}
				if tr.Pos() != 0 {
					t.Fatalf("order=%d w=%d trunc=%d cursor advanced", order, w, trunc)
				}
			}
		}
	}
}

func TestWriteBitsOverflowRejected(t *testing.T) {
	for _, order := range orders {
		wr := NewBitWriter(order)
		if err := wr.WriteBits(0, 5); err != nil {
			t.Fatal(err)
		}
		pos := wr.Pos()
		if err := wr.WriteBits(1<<5, 5); !errors.Is(err, ErrOverflow) {
			t.Fatalf("order=%d err=%v", order, err)
		}
		if wr.Pos() != pos {
			t.Fatalf("order=%d cursor moved on overflow", order)
		}
		if err := wr.WriteBits(1, 0); !errors.Is(err, ErrOverflow) {
			t.Fatalf("order=%d zero-width nonzero err=%v", order, err)
		}
		if err := wr.WriteBits(65, 65); !errors.Is(err, ErrInvalid) {
			t.Fatalf("order=%d width>64 err=%v", order, err)
		}
	}
}

func TestAlignPaddingAndRange(t *testing.T) {
	for _, order := range orders {
		wr := NewBitWriter(order)
		if err := wr.WriteBits(0x1f, 5); err != nil {
			t.Fatal(err)
		}
		if pad := wr.Align(); pad != 3 {
			t.Fatalf("order=%d pad=%d", order, pad)
		}
		if err := wr.WriteBits(0xab, 8); err != nil {
			t.Fatal(err)
		}
		r := NewBitReaderBytes(wr.Bytes(), order)
		if _, err := r.ReadBits(5); err != nil {
			t.Fatal(err)
		}
		start, end, err := r.Align()
		if err != nil {
			t.Fatal(err)
		}
		if start != 5 || end != 8 {
			t.Fatalf("order=%d align range [%d,%d)", order, start, end)
		}
		v, err := r.ReadBits(8)
		if err != nil || v != 0xab {
			t.Fatalf("order=%d v=%#x err=%v", order, v, err)
		}
	}
}
