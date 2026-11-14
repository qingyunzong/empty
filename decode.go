package dataeng

import (
	"fmt"
	"strings"
)

// Decimal is a scaled decimal value decoded from packed or zoned fields.
type Decimal struct {
	Mantissa int64 // signed value with Scale implied decimal places
	Scale    int
}

func (d Decimal) String() string {
	neg := d.Mantissa < 0
	m := d.Mantissa
	if neg {
		m = -m
	}
	digits := fmt.Sprintf("%0*d", d.Scale+1, m)
	if d.Scale > 0 {
		cut := len(digits) - d.Scale
		digits = digits[:cut] + "." + digits[cut:]
	}
	if neg {
		return "-" + digits
	}
	return digits
}

// Record is a successfully decoded fixed-width record.
type Record struct {
	Schema *Schema
	Offset int64          // absolute byte offset of the record in the stream
	Values map[string]any // string, Decimal, or nil for null fields
}

// FieldError describes a single invalid field. Fields are validated
// independently, so one bad field never hides errors in the others.
type FieldError struct {
	Field  string
	Offset int64 // absolute byte offset of the field in the stream
	Err    error
}

func (e FieldError) Error() string {
	return fmt.Sprintf("field %q at offset %d: %v", e.Field, e.Offset, e.Err)
}

// Decode validates and decodes every field of raw according to schema.
// offset is the absolute byte offset of raw in its stream. Field errors are
// collected, not fatal: the returned record contains the fields that decoded
// cleanly, and errs lists every field that failed validation.
func Decode(s *Schema, raw []byte, offset int64) (*Record, []FieldError) {
	rec := &Record{Schema: s, Offset: offset, Values: make(map[string]any, len(s.Fields))}
	var errs []FieldError
	for _, f := range s.Fields {
		frag := raw[f.Offset : f.Offset+f.Length]
		val, err := decodeField(s.CodePage, f, frag)
		if err != nil {
			errs = append(errs, FieldError{
				Field:  f.Name,
				Offset: offset + int64(f.Offset),
				Err:    err,
			})
			continue
		}
		rec.Values[f.Name] = val
	}
	return rec, errs
}

func decodeField(cp CodePage, f Field, raw []byte) (any, error) {
	switch f.Type {
	case FieldString:
		if IsBlank(raw) {
			if f.Nullable {
				return nil, nil
			}
			return nil, fmt.Errorf("all-blank value in non-nullable field")
		}
		return cp.DecodeField(raw)
	case FieldPackedDecimal:
		return decodePacked(f, raw)
	case FieldZonedDecimal:
		return decodeZoned(cp, f, raw)
	default:
		return nil, fmt.Errorf("unknown field type %d", int(f.Type))
	}
}

// decodePacked validates a COMP-3 packed decimal field: every digit nibble
// must be 0-9 and the final nibble must be a valid sign.
func decodePacked(f Field, raw []byte) (any, error) {
	if IsBlank(raw) {
		if f.Nullable {
			return nil, nil
		}
		return nil, fmt.Errorf("all-blank packed decimal in non-nullable field")
	}
	var mantissa int64
	for i, b := range raw {
		hi, lo := b>>4, b&0x0F
		last := i == len(raw)-1
		if hi > 9 {
			return nil, fmt.Errorf("invalid digit nibble 0x%X in byte %d", hi, i)
		}
		mantissa = mantissa*10 + int64(hi)
		if !last {
			if lo > 9 {
				return nil, fmt.Errorf("invalid digit nibble 0x%X in byte %d", lo, i)
			}
			mantissa = mantissa*10 + int64(lo)
			continue
		}
		switch lo {
		case 0xC, 0xF, 0xA, 0xE: // positive / unsigned
		case 0xB, 0xD: // negative
			mantissa = -mantissa
		default:
			return nil, fmt.Errorf("invalid sign nibble 0x%X", lo)
		}
	}
	return Decimal{Mantissa: mantissa, Scale: f.Scale}, nil
}

// decodeZoned validates a zoned decimal field with an EBCDIC overpunch sign:
// leading bytes must be unsigned digits 0xF0-0xF9, and the last byte carries
// the sign in its zone nibble (0xF/0xC positive, 0xD negative).
func decodeZoned(cp CodePage, f Field, raw []byte) (any, error) {
	if IsBlank(raw) {
		if f.Nullable {
			return nil, nil
		}
		return nil, fmt.Errorf("all-blank zoned decimal in non-nullable field")
	}
	if _, err := cp.table(); err != nil {
		return nil, err
	}
	var mantissa int64
	for i, b := range raw {
		digit := b & 0x0F
		if digit > 9 {
			return nil, fmt.Errorf("invalid digit 0x%X in byte %d", digit, i)
		}
		mantissa = mantissa*10 + int64(digit)
		if i < len(raw)-1 {
			if b>>4 != 0xF {
				return nil, fmt.Errorf("invalid zone nibble 0x%X in leading byte %d", b>>4, i)
			}
			continue
		}
		switch b >> 4 {
		case 0xF, 0xC: // unsigned or positive overpunch
		case 0xD: // negative overpunch
			mantissa = -mantissa
		default:
			return nil, fmt.Errorf("invalid overpunch sign zone 0x%X", b>>4)
		}
	}
	return Decimal{Mantissa: mantissa, Scale: f.Scale}, nil
}

// FormatValues renders decoded values for logging and debugging.
func (r *Record) FormatValues() string {
	var sb strings.Builder
	for i, f := range r.Schema.Fields {
		if i > 0 {
			sb.WriteString(", ")
		}
		fmt.Fprintf(&sb, "%s=%v", f.Name, r.Values[f.Name])
	}
	return sb.String()
}
