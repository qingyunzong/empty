package telemetry

import (
	"fmt"
	"io"
	"math"
)

// Span is a half-open bit range [Start, End) attributed to a named field.
type Span struct {
	Name       string
	Start, End int
}

// InterpretSpans is a deliberately independent descriptor interpreter
// used to cross-check the primary decoder: it shares no code with
// Reader/Decode and recomputes every field's in-place bit range straight
// from the descriptor and the raw bytes.
func InterpretSpans(data []byte, nbits int, order BitOrder, fields []Field) ([]Span, error) {
	it := &interp{data: data, nbits: nbits, order: order, vals: map[string]uint64{}}
	var out []Span
	if err := it.walk(fields, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

type interp struct {
	data  []byte
	nbits int
	order BitOrder
	pos   int
	vals  map[string]uint64
}

func (it *interp) bit() (uint64, error) {
	if it.pos >= it.nbits {
		return 0, io.ErrUnexpectedEOF
	}
	b := it.data[it.pos/8]
	var v uint64
	if it.order == MSBFirst {
		v = uint64(b>>(7-uint(it.pos%8))) & 1
	} else {
		v = uint64(b>>uint(it.pos%8)) & 1
	}
	it.pos++
	return v, nil
}

func (it *interp) bits(width int) (uint64, error) {
	if width < 0 || width > 64 {
		return 0, ErrWidth
	}
	if it.nbits-it.pos < width {
		return 0, io.ErrUnexpectedEOF
	}
	var v uint64
	if it.order == MSBFirst {
		for i := 0; i < width; i++ {
			b, _ := it.bit()
			v = v<<1 | b
		}
	} else {
		for i := 0; i < width; i++ {
			b, _ := it.bit()
			v |= b << uint(i)
		}
	}
	return v, nil
}

func (it *interp) varint() (uint64, error) {
	var v uint64
	for i := 0; i < varintGroups; i++ {
		if it.nbits-it.pos < 8 {
			return 0, io.ErrUnexpectedEOF
		}
		g, _ := it.bits(7)
		c, _ := it.bit()
		if i == varintGroups-1 {
			if c != 0 || g > 1 {
				return 0, ErrOverflow
			}
			if g == 0 {
				return 0, ErrOverlong
			}
			return v | g<<63, nil
		}
		v |= g << uint(7*i)
		if c == 0 {
			if i > 0 && g == 0 {
				return 0, ErrOverlong
			}
			return v, nil
		}
	}
	panic("telemetry: unreachable")
}

func (it *interp) length(f Field) (int, error) {
	if f.LenRef == "" {
		return f.Width, nil
	}
	ref, ok := it.vals[f.LenRef]
	if !ok {
		return 0, fmt.Errorf("telemetry: unknown length ref %q", f.LenRef)
	}
	mul := f.LenMul
	if mul == 0 {
		mul = 1
	}
	if mul < 0 || ref > math.MaxInt32 || int(ref)*mul > math.MaxInt32 {
		return 0, ErrOverflow
	}
	return int(ref) * mul, nil
}

func (it *interp) walk(fields []Field, name string, out *[]Span) error {
	idx := len(*out)
	*out = append(*out, Span{Name: name, Start: it.pos})
	for _, f := range fields {
		if err := it.field(f, out); err != nil {
			return err
		}
	}
	(*out)[idx].End = it.pos
	return nil
}

func (it *interp) field(f Field, out *[]Span) error {
	start := it.pos
	switch f.Kind {
	case KindStruct:
		return it.walk(f.Fields, f.Name, out)
	case KindUInt, KindSInt:
		w, err := it.length(f)
		if err != nil {
			return err
		}
		v, err := it.bits(w)
		if err != nil {
			return err
		}
		it.vals[f.Name] = v
	case KindVarint, KindSVarint:
		v, err := it.varint()
		if err != nil {
			return err
		}
		it.vals[f.Name] = v
	case KindBytes:
		n, err := it.length(f)
		if err != nil {
			return err
		}
		if n > (it.nbits-it.pos)/8 {
			return io.ErrUnexpectedEOF
		}
		it.pos += n * 8
	case KindAlign:
		if f.Width <= 0 {
			return ErrWidth
		}
		pad := (f.Width - it.pos%f.Width) % f.Width
		if it.nbits-it.pos < pad {
			return io.ErrUnexpectedEOF
		}
		it.pos += pad
	default:
		return fmt.Errorf("telemetry: unknown field kind %d", f.Kind)
	}
	*out = append(*out, Span{Name: f.Name, Start: start, End: it.pos})
	return nil
}
