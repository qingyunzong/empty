package telemcodec

import (
	"errors"
	"math"
	"testing"
)

func TestUvarintRoundTrip(t *testing.T) {
	vals := []uint64{0, 1, 2, 127, 128, 129, 300, 16383, 16384,
		1 << 21, 1<<28 - 1, 1 << 28, 1 << 35, 1 << 49, 1 << 56, 1 << 63,
		math.MaxUint64 - 1, math.MaxUint64}
	for _, order := range orders {
		for _, v := range vals {
			wr := NewBitWriter(order)
			if err := wr.WriteUvarint(v); err != nil {
				t.Fatalf("order=%d v=%d: %v", order, v, err)
			}
			r := NewBitReaderBytes(wr.Bytes(), order)
			got, err := r.ReadUvarint()
			if err != nil || got != v {
				t.Fatalf("order=%d v=%d got=%d err=%v", order, v, got, err)
			}
			if r.Pos() != wr.BitLen() {
				t.Fatalf("order=%d v=%d pos=%d want %d", order, v, r.Pos(), wr.BitLen())
			}
		}
	}
}

func TestVarintRoundTrip(t *testing.T) {
	vals := []int64{0, 1, -1, 2, -2, 63, -64, 64, -65, 300, -300,
		1 << 30, -(1 << 30), math.MaxInt64, math.MinInt64}
	for _, order := range orders {
		for _, v := range vals {
			wr := NewBitWriter(order)
			if err := wr.WriteVarint(v); err != nil {
				t.Fatalf("order=%d v=%d: %v", order, v, err)
			}
			r := NewBitReaderBytes(wr.Bytes(), order)
			got, err := r.ReadVarint()
			if err != nil || got != v {
				t.Fatalf("order=%d v=%d got=%d err=%v", order, v, got, err)
			}
		}
	}
}

// Overlong and overflowing encodings must be rejected and must leave the
// transaction cursor untouched.
func TestUvarintRejectsOverlongAndOverflow(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want error
	}{
		{"nonminimal zero", []byte{0x80, 0x00}, ErrOverlong},
		{"nonminimal one", []byte{0x81, 0x00}, ErrOverlong},
		{"nonminimal three bytes", []byte{0x80, 0x80, 0x00}, ErrOverlong},
		{"eleven bytes", []byte{0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01}, ErrOverflow},
		{"tenth byte too large", []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02}, ErrOverflow},
		{"truncated continuation", []byte{0x80}, ErrTruncated},
		{"empty", []byte{}, ErrTruncated},
	}
	for _, order := range orders {
		for _, tc := range cases {
			r := NewBitReaderBytes(tc.data, order)
			if _, err := r.ReadUvarint(); !errors.Is(err, tc.want) {
				t.Fatalf("order=%d %s: err=%v want %v", order, tc.name, err, tc.want)
			}
			if r.Pos() != 0 {
				t.Fatalf("order=%d %s: cursor advanced to %d", order, tc.name, r.Pos())
			}
		}
	}
}

// MaxUint64 is the largest legal encoding: ten bytes, last byte 0x01.
func TestUvarintMaxUint64Encoding(t *testing.T) {
	data := []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01}
	for _, order := range orders {
		r := NewBitReaderBytes(data, order)
		v, err := r.ReadUvarint()
		if err != nil || v != math.MaxUint64 {
			t.Fatalf("order=%d v=%d err=%v", order, v, err)
		}
		if r.Pos() != 80 {
			t.Fatalf("order=%d pos=%d", order, r.Pos())
		}
	}
}

// After a failed varint read the cursor stays put, so raising the bit
// limit lets the very same stream be decoded successfully.
func TestUvarintErrorRecovery(t *testing.T) {
	for _, order := range orders {
		wr := NewBitWriter(order)
		if err := wr.WriteUvarint(300); err != nil { // 0xac 0x02
			t.Fatal(err)
		}
		data := wr.Bytes()
		r := NewBitReaderBytes(data, order)
		r.SetBitLimit(8) // only the continuation byte visible
		if _, err := r.ReadUvarint(); !errors.Is(err, ErrTruncated) {
			t.Fatalf("order=%d err=%v", order, err)
		}
		if r.Pos() != 0 {
			t.Fatalf("order=%d cursor advanced", order)
		}
		r.SetBitLimit(16)
		v, err := r.ReadUvarint()
		if err != nil || v != 300 {
			t.Fatalf("order=%d recovery v=%d err=%v", order, v, err)
		}
	}
}
