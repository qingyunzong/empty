package dataeng

import "fmt"

// MaxBits is the largest supported coordinate width.
const MaxBits = 12

// Domain is a b-bit coordinate space [0, 2^b-1] x [0, 2^b-1].
//
// A Domain's zero value is invalid; construct one with NewDomain.
type Domain struct {
	Bits uint8
}

// NewDomain validates a coordinate width and returns its domain.
func NewDomain(bits int) (Domain, error) {
	if bits < 1 || bits > MaxBits {
		return Domain{}, fmt.Errorf(
			"dataeng: coordinate width %d is outside [1,%d]", bits, MaxBits)
	}
	return Domain{Bits: uint8(bits)}, nil
}

// Valid reports whether d describes a supported domain.
func (d Domain) Valid() bool {
	return d.Bits >= 1 && d.Bits <= MaxBits
}

// Size returns 2^b, the number of coordinate values on each axis.
func (d Domain) Size() uint32 {
	if !d.Valid() {
		return 0
	}
	return uint32(1) << d.Bits
}

// CodeCount returns 4^b, the number of Morton codes in the domain.
func (d Domain) CodeCount() uint32 {
	if !d.Valid() {
		return 0
	}
	return uint32(1) << (2 * d.Bits)
}

// Rect is a closed axis-aligned rectangle in cell coordinates.
// All four bounds are inclusive.
type Rect struct {
	MinX uint32
	MinY uint32
	MaxX uint32
	MaxY uint32
}

// Width returns the number of coordinate columns in r.
func (r Rect) Width() uint32 {
	return r.MaxX - r.MinX + 1
}

// Height returns the number of coordinate rows in r.
func (r Rect) Height() uint32 {
	return r.MaxY - r.MinY + 1
}

// ValidateRect checks that r is a non-empty closed rectangle inside d.
func (d Domain) ValidateRect(r Rect) error {
	if !d.Valid() {
		return fmt.Errorf("dataeng: invalid domain width %d", d.Bits)
	}
	if r.MinX > r.MaxX || r.MinY > r.MaxY {
		return fmt.Errorf(
			"dataeng: empty rectangle x=[%d,%d] y=[%d,%d]",
			r.MinX, r.MaxX, r.MinY, r.MaxY)
	}
	size := d.Size()
	if r.MaxX >= size || r.MaxY >= size {
		return fmt.Errorf(
			"dataeng: rectangle x=[%d,%d] y=[%d,%d] leaves domain [0,%d]",
			r.MinX, r.MaxX, r.MinY, r.MaxY, size-1)
	}
	return nil
}

// Encode returns the Morton code of (x, y).
//
// Bit i of x occupies code bit 2i and bit i of y occupies code bit 2i+1,
// so the least significant pair is (x0, y0) and the most significant pair
// is (x[b-1], y[b-1]).
func (d Domain) Encode(x, y uint32) (uint32, error) {
	if !d.Valid() {
		return 0, fmt.Errorf("dataeng: invalid domain width %d", d.Bits)
	}
	size := d.Size()
	if x >= size || y >= size {
		return 0, fmt.Errorf(
			"dataeng: point (%d,%d) outside domain [0,%d]",
			x, y, size-1)
	}
	return interleave(x, y, d.Bits), nil
}

// Decode returns the cell coordinates of a Morton code.
func (d Domain) Decode(code uint32) (uint32, uint32, error) {
	if !d.Valid() {
		return 0, 0, fmt.Errorf("dataeng: invalid domain width %d", d.Bits)
	}
	if code >= d.CodeCount() {
		return 0, 0, fmt.Errorf(
			"dataeng: code %d outside domain [0,%d]",
			code, d.CodeCount()-1)
	}
	x, y := deinterleave(code, d.Bits)
	return x, y, nil
}

// ContainsCode reports whether the code's cell lies inside r.
func (d Domain) ContainsCode(r Rect, code uint32) bool {
	x, y, err := d.Decode(code)
	if err != nil {
		return false
	}
	return x >= r.MinX && x <= r.MaxX && y >= r.MinY && y <= r.MaxY
}

func interleave(x, y uint32, bits uint8) uint32 {
	var code uint32
	for i := uint8(0); i < bits; i++ {
		code |= (x >> i & 1) << (2 * i)
		code |= (y >> i & 1) << (2*i + 1)
	}
	return code
}

func deinterleave(code uint32, bits uint8) (uint32, uint32) {
	var x, y uint32
	for i := uint8(0); i < bits; i++ {
		x |= (code >> (2 * i) & 1) << i
		y |= (code >> (2*i + 1) & 1) << i
	}
	return x, y
}
