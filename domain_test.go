package dataeng

import (
	"testing"
)

func mustDomain(t *testing.T, bits int) Domain {
	t.Helper()
	d, err := NewDomain(bits)
	if err != nil {
		t.Fatalf("NewDomain(%d): %v", bits, err)
	}
	return d
}

func TestMortonLowBitInterleave(t *testing.T) {
	d := mustDomain(t, 4)
	code, err := d.Encode(0b1010, 0b0101)
	if err != nil {
		t.Fatal(err)
	}
	if code != 0b01100110 {
		t.Fatalf("Encode(10,5) = %d (%04b), want 102 (01100110)", code, code)
	}
	x, y, err := d.Decode(code)
	if err != nil {
		t.Fatal(err)
	}
	if x != 0b1010 || y != 0b0101 {
		t.Fatalf("Decode(%d) = (%d,%d), want (10,5)", code, x, y)
	}
}

func TestEncodeDecodeAllSmallDomains(t *testing.T) {
	for bits := 1; bits <= 8; bits++ {
		d := mustDomain(t, bits)
		for y := uint32(0); y < d.Size(); y++ {
			for x := uint32(0); x < d.Size(); x++ {
				code, err := d.Encode(x, y)
				if err != nil {
					t.Fatalf("b=%d Encode(%d,%d): %v", bits, x, y, err)
				}
				gx, gy, err := d.Decode(code)
				if err != nil {
					t.Fatalf("b=%d Decode(%d): %v", bits, code, err)
				}
				if gx != x || gy != y {
					t.Fatalf("b=%d round trip (%d,%d) -> %d -> (%d,%d)",
						bits, x, y, code, gx, gy)
				}
			}
		}
	}
}

func TestValidation(t *testing.T) {
	if _, err := NewDomain(0); err == nil {
		t.Fatal("NewDomain(0) accepted")
	}
	if _, err := NewDomain(MaxBits + 1); err == nil {
		t.Fatal("NewDomain(13) accepted")
	}
	d := mustDomain(t, 3)
	if _, err := d.Encode(8, 0); err == nil {
		t.Fatal("Encode outside domain accepted")
	}
	if _, _, err := d.Decode(64); err == nil {
		t.Fatal("Decode outside domain accepted")
	}
	if err := d.ValidateRect(Rect{MinX: 2, MaxX: 1}); err == nil {
		t.Fatal("reversed rectangle accepted")
	}
	if err := d.ValidateRect(Rect{MinX: 0, MaxX: 8}); err == nil {
		t.Fatal("rectangle outside domain accepted")
	}
	if _, err := d.Query(Rect{MinX: 0, MaxX: 0}, -1); err == nil {
		t.Fatal("negative budget accepted")
	}
}
