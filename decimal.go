package dataeng

import (
	"fmt"
	"math/big"
	"strings"
)

// Decimal is an exact decimal value. Value is the canonical unscaled integer;
// the represented value is Value * 10^(-Scale). Bytes is a copy of the original
// physical field and Start/End are its half-open byte range in the record.
// Negative zero is normalized to zero.
type Decimal struct {
	Value *big.Int
	Scale int
	Start int
	End   int
	Bytes []byte
}

// String renders the exact value without floating point conversion. Trailing
// fractional zeroes are retained because Scale is part of the copybook.
func (d *Decimal) String() string {
	if d == nil || d.Value == nil {
		return ""
	}
	if d.Scale == 0 {
		return d.Value.String()
	}
	negative := d.Value.Sign() < 0
	digits := new(big.Int).Abs(d.Value).String()
	needed := d.Scale + 1
	if len(digits) < needed {
		digits = strings.Repeat("0", needed-len(digits)) + digits
	}
	split := len(digits) - d.Scale
	out := digits[:split] + "." + digits[split:]
	if negative {
		out = "-" + out
	}
	return out
}

func decodeDisplay(data []byte, digits int, start int, path string) (*Decimal, error) {
	if len(data) != digits {
		return nil, boundsError(path, start, digits, len(data))
	}
	var b strings.Builder
	b.Grow(digits)
	for i, c := range data {
		if c < '0' || c > '9' {
			return nil, &DecodeError{
				Code:   ErrDigit,
				Path:   path,
				Offset: start + i,
				Reason: fmt.Sprintf("display decimal byte contains 0x%02x, not an ASCII digit", c),
			}
		}
		b.WriteByte(c)
	}
	value, ok := new(big.Int).SetString(b.String(), 10)
	if !ok {
		return nil, &DecodeError{Code: ErrDigit, Path: path, Offset: start, Reason: "cannot parse display decimal"}
	}
	return &Decimal{
		Value: value,
		Scale: 0,
		Start: start,
		End:   start + digits,
		Bytes: append([]byte(nil), data...),
	}, nil
}

func decodePacked(data []byte, digits, scale, start int, path string) (*Decimal, error) {
	want := digits/2 + 1
	if len(data) != want {
		return nil, boundsError(path, start, want, len(data))
	}
	extra := 2*want - (digits + 1)
	pos := 0
	if extra == 1 {
		if nibbleAt(data, 0) != 0 {
			return nil, &DecodeError{
				Code:   ErrDigit,
				Path:   path,
				Offset: start,
				Reason: "packed decimal high padding nibble must be zero",
			}
		}
		pos = 1
	}

	var b strings.Builder
	b.Grow(digits)
	for i := 0; i < digits; i++ {
		nibblePos := pos
		nibble := nibbleAt(data, pos)
		pos++
		if nibble > 9 {
			return nil, &DecodeError{
				Code:   ErrDigit,
				Path:   path,
				Offset: start + nibblePos/2,
				Reason: fmt.Sprintf("packed decimal digit nibble is 0x%x", nibble),
			}
		}
		b.WriteByte('0' + nibble)
	}

	negative := false
	signPos := pos
	switch sign := nibbleAt(data, pos); sign {
	case 0x0c, 0x0f:
		// Positive.
	case 0x0d:
		negative = true
	default:
		return nil, &DecodeError{
			Code:   ErrSign,
			Path:   path,
			Offset: start + signPos/2,
			Reason: fmt.Sprintf("packed decimal sign nibble is 0x%x, want C, D, or F", sign),
		}
	}

	value, ok := new(big.Int).SetString(b.String(), 10)
	if !ok {
		return nil, &DecodeError{Code: ErrDigit, Path: path, Offset: start, Reason: "cannot parse packed decimal"}
	}
	if negative && value.Sign() != 0 {
		value.Neg(value)
	}
	return &Decimal{
		Value: value,
		Scale: scale,
		Start: start,
		End:   start + want,
		Bytes: append([]byte(nil), data...),
	}, nil
}

func nibbleAt(data []byte, pos int) byte {
	if pos%2 == 0 {
		return data[pos/2] >> 4
	}
	return data[pos/2] & 0x0f
}

func boundsError(path string, start, want, available int) *DecodeError {
	return &DecodeError{
		Code:   ErrBounds,
		Path:   path,
		Offset: start,
		Reason: fmt.Sprintf("field needs %d bytes but only %d are available", want, available),
	}
}
