package telemcodec

import "fmt"

// Kind classifies a field in a telemetry frame descriptor.
type Kind int

const (
	KindUint    Kind = iota // unsigned fixed-width integer of Width bits
	KindInt                 // signed two's-complement integer of Width bits
	KindUvarint             // unsigned LEB128 varint
	KindVarint              // zigzag signed varint
	KindAlign               // zero padding to the next byte boundary
	KindStruct              // nested structure described by Sub
)

// Field describes one element of a telemetry frame.
//
// Width gives the bit width for KindUint/KindInt. If LenRef names a
// previously decoded integer field, the width is instead that field's value
// multiplied by LenMul (length multiplication), letting a frame carry
// self-describing variable-length payloads.
type Field struct {
	Name   string
	Kind   Kind
	Width  int
	LenRef string
	LenMul int
	Sub    []Field
}

// Entry is a decoded field annotated with the original bit range
// [Start, End) it was decoded from. Length multiplication, sign extension
// and alignment entries all carry their source ranges.
type Entry struct {
	Name  string
	U     uint64 // value for KindUint/KindUvarint
	S     int64  // value for KindInt/KindVarint
	Start int64  // first stream bit, inclusive
	End   int64  // last stream bit, exclusive
}

// ReadStruct decodes fields from r, appending entries to sink (which may be
// nil). If a nested KindStruct fails, both the cursor and the sink are
// rolled back to their state before the nested read began, while bytes
// already cached from the underlying source are retained.
func ReadStruct(r *BitReader, fields []Field, sink *[]Entry) error {
	vals := map[string]uint64{}
	return readFields(r, fields, sink, vals)
}

func readFields(r *BitReader, fields []Field, sink *[]Entry, vals map[string]uint64) error {
	for _, f := range fields {
		if err := readField(r, f, sink, vals); err != nil {
			return err
		}
	}
	return nil
}

func fieldWidth(f Field, vals map[string]uint64) (int, error) {
	if f.LenRef == "" {
		return f.Width, nil
	}
	prev, ok := vals[f.LenRef]
	if !ok {
		return 0, fmt.Errorf("telemcodec: length reference %q not found: %w", f.LenRef, ErrInvalid)
	}
	mul := f.LenMul
	if mul <= 0 {
		mul = 1
	}
	if prev > uint64(1<<32) || prev*uint64(mul) > 64 {
		return 0, fmt.Errorf("telemcodec: length multiplication %s*%d overflows width: %w",
			f.LenRef, mul, ErrOverflow)
	}
	return int(prev) * mul, nil
}

func readField(r *BitReader, f Field, sink *[]Entry, vals map[string]uint64) error {
	start := r.Pos()
	switch f.Kind {
	case KindUint, KindInt:
		w, err := fieldWidth(f, vals)
		if err != nil {
			return err
		}
		if f.Kind == KindUint {
			v, err := r.ReadBits(w)
			if err != nil {
				return err
			}
			appendEntry(sink, Entry{Name: f.Name, U: v, S: int64(v), Start: start, End: r.Pos()})
			vals[f.Name] = v
			return nil
		}
		v, err := r.ReadSigned(w)
		if err != nil {
			return err
		}
		appendEntry(sink, Entry{Name: f.Name, U: uint64(v), S: v, Start: start, End: r.Pos()})
		vals[f.Name] = uint64(v)
		return nil
	case KindUvarint:
		v, err := r.ReadUvarint()
		if err != nil {
			return err
		}
		appendEntry(sink, Entry{Name: f.Name, U: v, S: int64(v), Start: start, End: r.Pos()})
		vals[f.Name] = v
		return nil
	case KindVarint:
		v, err := r.ReadVarint()
		if err != nil {
			return err
		}
		appendEntry(sink, Entry{Name: f.Name, U: uint64(v), S: v, Start: start, End: r.Pos()})
		vals[f.Name] = uint64(v)
		return nil
	case KindAlign:
		s, e, err := r.Align()
		if err != nil {
			return err
		}
		appendEntry(sink, Entry{Name: f.Name, Start: s, End: e})
		return nil
	case KindStruct:
		mark := r.Mark()
		sinkLen := 0
		if sink != nil {
			sinkLen = len(*sink)
		}
		subVals := make(map[string]uint64, len(vals))
		for k, v := range vals {
			subVals[k] = v
		}
		if err := readFields(r, f.Sub, sink, subVals); err != nil {
			r.Rollback(mark)
			if sink != nil {
				*sink = (*sink)[:sinkLen]
			}
			return err
		}
		for k, v := range subVals {
			vals[k] = v
		}
		return nil
	default:
		return ErrInvalid
	}
}

func appendEntry(sink *[]Entry, e Entry) {
	if sink != nil {
		*sink = append(*sink, e)
	}
}
