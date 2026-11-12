// Package s8ref is a deliberately one-shot, non-incremental reference
// interpreter for the closed S8 data region. It is used only to cross-check
// the streaming decoder in tests.
package s8ref

import (
	"fmt"
	"math"

	de "example.org/dataeng/q0320"
)

const (
	terminator    byte = 252
	literal       byte = 253
	spaces        byte = 254
	missing       byte = 255
	systemMissing      = de.SystemMissingBits
)

type plan struct {
	name  string
	kind  de.FieldKind
	width int
	slots int
}

type ref struct {
	cfg        de.Config
	plans      []plan
	projection []int
	fieldIdx   int
	slotIdx    int
	values     []*de.Value
	rows       []de.Row
}

// Decode interprets the entire data slice in one pass. complete is true only
// when a terminator was found, its literal slots were consumed, and no bytes
// followed. Rows decoded before an error are returned with the error.
func Decode(data []byte, cfg de.Config) (rows []de.Row, complete bool, err error) {
	plans, projection, err := normalize(cfg)
	if err != nil {
		return nil, false, err
	}
	r := &ref{
		cfg:        cfg,
		plans:      plans,
		projection: projection,
		values:     make([]*de.Value, len(plans)),
	}

	pos := 0
	for {
		if pos >= len(data) {
			return r.rows, false, fmt.Errorf("%w: EOF at offset %d", de.ErrTruncated, pos)
		}
		if len(data)-pos < 8 {
			return r.rows, false, fmt.Errorf("%w: partial header at offset %d", de.ErrTruncated, pos)
		}

		groupOffset := pos
		header := data[pos : pos+8]
		pos += 8
		literalPos := pos
		terminated := false

		for codeIdx := 0; codeIdx < 8; codeIdx++ {
			code := header[codeIdx]
			switch {
			case code == 0:
				continue

			case code == terminator:
				if r.fieldIdx != 0 || r.slotIdx != 0 {
					return r.rows, false, fmt.Errorf("%w: group %d code %d",
						de.ErrRowBoundary, groupOffset, codeIdx)
				}
				for j := codeIdx + 1; j < 8; j++ {
					if header[j] != 0 {
						return r.rows, false, fmt.Errorf("%w: group %d code %d follows terminator",
							de.ErrTerminatorHeader, groupOffset, j)
					}
				}
				terminated = true
				codeIdx = 8

			case code == literal:
				if literalPos+8 > len(data) {
					return r.rows, false, fmt.Errorf("%w: partial literal at offset %d",
						de.ErrTruncated, literalPos)
				}
				var raw [8]byte
				copy(raw[:], data[literalPos:literalPos+8])
				src := de.Source{
					GroupOffset:   int64(groupOffset),
					CodeIndex:     codeIdx,
					LiteralOffset: int64(literalPos),
					LiteralLength: 8,
				}
				literalPos += 8
				if err := r.applyLiteral(raw, src); err != nil {
					return r.rows, false, err
				}

			case code == spaces:
				var raw [8]byte
				for i := range raw {
					raw[i] = ' '
				}
				src := de.Source{GroupOffset: int64(groupOffset), CodeIndex: codeIdx,
					LiteralOffset: de.NoLiteralOffset}
				if err := r.applyBytes(raw, src); err != nil {
					return r.rows, false, err
				}

			case code == missing:
				src := de.Source{GroupOffset: int64(groupOffset), CodeIndex: codeIdx,
					LiteralOffset: de.NoLiteralOffset}
				if err := r.applyNumeric(systemMissing, true, src); err != nil {
					return r.rows, false, err
				}

			default: // 1..251
				value := int(code) - cfg.Bias
				src := de.Source{GroupOffset: int64(groupOffset), CodeIndex: codeIdx,
					LiteralOffset: de.NoLiteralOffset}
				if err := r.applyNumeric(math.Float64bits(float64(value)), false, src); err != nil {
					return r.rows, false, err
				}
			}
		}

		pos = literalPos
		if terminated {
			if pos != len(data) {
				return r.rows, false, fmt.Errorf("%w: byte at offset %d", de.ErrExtraData, pos)
			}
			return r.rows, true, nil
		}
		if pos == len(data) {
			return r.rows, false, fmt.Errorf("%w: EOF at offset %d", de.ErrTruncated, pos)
		}
	}
}

func (r *ref) applyLiteral(raw [8]byte, src de.Source) error {
	field := &r.plans[r.fieldIdx]
	switch field.kind {
	case de.Numeric:
		var bits uint64
		if r.cfg.NumericEndian == de.BigEndian {
			bits = uint64(raw[0])<<56 | uint64(raw[1])<<48 | uint64(raw[2])<<40 |
				uint64(raw[3])<<32 | uint64(raw[4])<<24 | uint64(raw[5])<<16 |
				uint64(raw[6])<<8 | uint64(raw[7])
		} else {
			bits = uint64(raw[7])<<56 | uint64(raw[6])<<48 | uint64(raw[5])<<40 |
				uint64(raw[4])<<32 | uint64(raw[3])<<24 | uint64(raw[2])<<16 |
				uint64(raw[1])<<8 | uint64(raw[0])
		}
		return r.applyNumeric(bits, bits == systemMissing, src)
	case de.Bytes:
		return r.applyBytes(raw, src)
	}
	return fmt.Errorf("%w: field %q", de.ErrTypeMismatch, field.name)
}

func (r *ref) applyNumeric(bits uint64, isMissing bool, src de.Source) error {
	if err := r.checkNewRow(); err != nil {
		return err
	}
	field := &r.plans[r.fieldIdx]
	if field.kind != de.Numeric {
		return fmt.Errorf("%w: field %q is bytes", de.ErrTypeMismatch, field.name)
	}
	r.values[r.fieldIdx] = &de.Value{
		Field:   field.name,
		Kind:    de.Numeric,
		Missing: isMissing,
		Bits:    bits,
		Source:  src,
	}
	return r.advance()
}

func (r *ref) applyBytes(raw [8]byte, src de.Source) error {
	if err := r.checkNewRow(); err != nil {
		return err
	}
	field := &r.plans[r.fieldIdx]
	if field.kind != de.Bytes {
		return fmt.Errorf("%w: field %q is numeric", de.ErrTypeMismatch, field.name)
	}

	last := r.slotIdx == field.slots-1
	n := 8
	if last {
		n = field.width - (field.slots-1)*8
		if n < 8 {
			for i := n; i < 8; i++ {
				if raw[i] != ' ' {
					return fmt.Errorf("%w: field %q byte %d is 0x%02x",
						de.ErrBadPadding, field.name, i, raw[i])
				}
			}
		}
	}

	value := r.values[r.fieldIdx]
	if value == nil {
		value = &de.Value{Field: field.name, Kind: de.Bytes, Source: src}
		r.values[r.fieldIdx] = value
	}
	chunk := clone(raw[:n])
	value.Data = append(value.Data, chunk...)
	value.Fragments = append(value.Fragments, de.Fragment{
		Data:   clone(chunk),
		Source: src,
	})
	return r.advance()
}

func (r *ref) advance() error {
	field := &r.plans[r.fieldIdx]
	r.slotIdx++
	if r.slotIdx >= field.slots {
		r.fieldIdx++
		r.slotIdx = 0
		if r.fieldIdx == len(r.plans) {
			return r.completeRow()
		}
	}
	return nil
}

func (r *ref) checkNewRow() error {
	if r.fieldIdx == 0 && r.slotIdx == 0 && uint64(len(r.rows)) >= r.cfg.MaxRows {
		return fmt.Errorf("%w: %d rows already delivered", de.ErrRowLimit, len(r.rows))
	}
	return nil
}

func (r *ref) completeRow() error {
	if uint64(len(r.rows)) >= r.cfg.MaxRows {
		return fmt.Errorf("%w: %d rows already delivered", de.ErrRowLimit, len(r.rows))
	}
	row := de.Row{Values: make([]de.Value, len(r.projection))}
	for i, fieldIdx := range r.projection {
		v := r.values[fieldIdx]
		if v == nil {
			return fmt.Errorf("%w: internal missing value", de.ErrInvalidConfig)
		}
		row.Values[i] = *v
	}
	r.rows = append(r.rows, row)
	r.fieldIdx = 0
	r.slotIdx = 0
	for i := range r.values {
		r.values[i] = nil
	}
	return nil
}

func normalize(cfg de.Config) ([]plan, []int, error) {
	if len(cfg.Fields) == 0 {
		return nil, nil, fmt.Errorf("%w: at least one field is required", de.ErrInvalidConfig)
	}
	if cfg.NumericEndian != de.LittleEndian && cfg.NumericEndian != de.BigEndian {
		return nil, nil, fmt.Errorf("%w: unknown numeric endian", de.ErrInvalidConfig)
	}
	if cfg.Bias < -32768 || cfg.Bias > 32767 {
		return nil, nil, fmt.Errorf("%w: bias outside -32768..32767", de.ErrInvalidConfig)
	}
	if cfg.RowByteBudget < 0 {
		return nil, nil, fmt.Errorf("%w: negative row byte budget", de.ErrInvalidConfig)
	}

	plans := make([]plan, len(cfg.Fields))
	names := make(map[string]int, len(cfg.Fields))
	for i, f := range cfg.Fields {
		if _, ok := names[f.Name]; ok {
			return nil, nil, fmt.Errorf("%w: duplicate field name %q", de.ErrInvalidConfig, f.Name)
		}
		names[f.Name] = i
		p := plan{name: f.Name, kind: f.Kind}
		switch f.Kind {
		case de.Numeric:
			p.slots = 1
		case de.Bytes:
			if f.Width < 1 || f.Width > 1048576 || f.Width > cfg.RowByteBudget {
				return nil, nil, fmt.Errorf("%w: invalid bytes field %q", de.ErrInvalidConfig, f.Name)
			}
			p.width = f.Width
			p.slots = (f.Width + 7) / 8
		default:
			return nil, nil, fmt.Errorf("%w: invalid field kind", de.ErrInvalidConfig)
		}
		plans[i] = p
	}

	if len(cfg.Projection) == 0 {
		projection := make([]int, len(plans))
		for i := range projection {
			projection[i] = i
		}
		return plans, projection, nil
	}

	projection := make([]int, 0, len(cfg.Projection))
	seen := make(map[int]bool, len(cfg.Projection))
	for _, name := range cfg.Projection {
		idx, ok := names[name]
		if !ok {
			return nil, nil, fmt.Errorf("%w: project unknown field %q", de.ErrInvalidConfig, name)
		}
		if seen[idx] {
			return nil, nil, fmt.Errorf("%w: project repeated field %q", de.ErrInvalidConfig, name)
		}
		seen[idx] = true
		projection = append(projection, idx)
	}
	return plans, projection, nil
}

func clone(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	return append([]byte(nil), b...)
}
