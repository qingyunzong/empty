package dataeng

import (
	"fmt"
	"math"
)

const (
	magicTerminator    byte = 252
	magicLiteral       byte = 253
	magicSpaces        byte = 254
	magicMissing       byte = 255
	systemMissingBits       = SystemMissingBits
	maxBytesFieldWidth      = 1048576
)

type fieldPlan struct {
	name      string
	kind      FieldKind
	width     int
	slots     int
	projected bool
	projPos   int
}

type decConfig struct {
	fields     []fieldPlan
	projection []int
	order      ByteOrder
	bias       int
	maxRows    uint64
}

type decoderState uint8

const (
	stateHeader decoderState = iota
	stateCodes
	stateLiteral
	stateDone
)

type rowState struct {
	fieldIdx int
	slotIdx  int
	values   []*Value
}

// Decoder is an incremental decoder for the closed S8 data region described
// by Config. It keeps only the eight-byte group header, one pending literal
// slot, and the projected values of the current partial row.
type Decoder struct {
	cfg decConfig

	state    decoderState
	header   [8]byte
	headerN  int
	groupOff int64
	codeIdx  int
	pos      int64

	literal      [8]byte
	literalN     int
	literalGroup int64
	literalCode  int
	literalOff   int64

	row   rowState
	rows  uint64
	done  bool
	final bool
}

// NewDecoder validates cfg and constructs a decoder. Declarations that cannot
// be accepted are rejected before any data is read.
func NewDecoder(cfg Config) (*Decoder, error) {
	if len(cfg.Fields) == 0 {
		return nil, fmt.Errorf("%w: at least one field is required", ErrInvalidConfig)
	}
	if cfg.NumericEndian != LittleEndian && cfg.NumericEndian != BigEndian {
		return nil, fmt.Errorf("%w: unknown numeric endian %d", ErrInvalidConfig, cfg.NumericEndian)
	}
	if cfg.Bias < -32768 || cfg.Bias > 32767 {
		return nil, fmt.Errorf("%w: bias %d outside -32768..32767", ErrInvalidConfig, cfg.Bias)
	}
	if cfg.RowByteBudget < 0 {
		return nil, fmt.Errorf("%w: negative row byte budget %d", ErrInvalidConfig, cfg.RowByteBudget)
	}

	plans := make([]fieldPlan, len(cfg.Fields))
	nameToIndex := make(map[string]int, len(cfg.Fields))
	for i, f := range cfg.Fields {
		if _, ok := nameToIndex[f.Name]; ok {
			return nil, fmt.Errorf("%w: duplicate field name %q", ErrInvalidConfig, f.Name)
		}
		nameToIndex[f.Name] = i

		p := fieldPlan{name: f.Name, kind: f.Kind}
		switch f.Kind {
		case Numeric:
			p.slots = 1
		case Bytes:
			if f.Width < 1 || f.Width > maxBytesFieldWidth {
				return nil, fmt.Errorf("%w: bytes field %q width %d outside 1..%d",
					ErrInvalidConfig, f.Name, f.Width, maxBytesFieldWidth)
			}
			if f.Width > cfg.RowByteBudget {
				return nil, fmt.Errorf("%w: bytes field %q width %d exceeds row budget %d",
					ErrInvalidConfig, f.Name, f.Width, cfg.RowByteBudget)
			}
			p.width = f.Width
			p.slots = (f.Width + 7) / 8
		default:
			return nil, fmt.Errorf("%w: field %q has unknown kind %d", ErrInvalidConfig, f.Name, f.Kind)
		}
		plans[i] = p
	}

	projection := make([]int, 0, len(plans))
	if len(cfg.Projection) == 0 {
		for i := range plans {
			plans[i].projected = true
			plans[i].projPos = i
			projection = append(projection, i)
		}
	} else {
		seen := make(map[int]bool, len(cfg.Projection))
		for _, name := range cfg.Projection {
			idx, ok := nameToIndex[name]
			if !ok {
				return nil, fmt.Errorf("%w: projected field %q does not exist", ErrInvalidConfig, name)
			}
			if seen[idx] {
				return nil, fmt.Errorf("%w: projected field %q is repeated", ErrInvalidConfig, name)
			}
			seen[idx] = true
			plans[idx].projected = true
			plans[idx].projPos = len(projection)
			projection = append(projection, idx)
		}
	}

	d := &Decoder{
		cfg: decConfig{
			fields:     plans,
			projection: projection,
			order:      cfg.NumericEndian,
			bias:       cfg.Bias,
			maxRows:    cfg.MaxRows,
		},
		state: stateHeader,
	}
	d.row.values = make([]*Value, len(projection))
	return d, nil
}

// DecodeAll is a convenience wrapper for callers that already hold the whole
// closed data region. It returns the rows completed before any error and
// requires a successful Finish for a nil error.
func DecodeAll(data []byte, cfg Config) ([]Row, error) {
	d, err := NewDecoder(cfg)
	if err != nil {
		return nil, err
	}
	rows, pushErr := d.Push(data)
	if pushErr != nil {
		return rows, pushErr
	}
	if err := d.Finish(); err != nil {
		return rows, err
	}
	return rows, nil
}

// Push feeds an arbitrary prefix or continuation of the physical byte stream.
// It returns only rows that were completed and validated during this call.
// A partial row is never returned. Any error is permanent; rows returned
// alongside the error remain valid.
func (d *Decoder) Push(p []byte) ([]Row, error) {
	if d.final || d.done {
		return nil, ErrState
	}

	var out []Row
	i := 0
	for i < len(p) {
		switch d.state {
		case stateHeader:
			n := 8 - d.headerN
			if remaining := len(p) - i; n > remaining {
				n = remaining
			}
			copy(d.header[d.headerN:d.headerN+n], p[i:i+n])
			d.headerN += n
			d.pos += int64(n)
			i += n
			if d.headerN < 8 {
				continue
			}
			d.groupOff = d.pos - 8
			d.codeIdx = 0
			d.state = stateCodes
			if err := d.processCodes(&out); err != nil {
				return out, d.fail(err)
			}

		case stateCodes:
			if err := d.processCodes(&out); err != nil {
				return out, d.fail(err)
			}

		case stateLiteral:
			n := 8 - d.literalN
			if remaining := len(p) - i; n > remaining {
				n = remaining
			}
			copy(d.literal[d.literalN:d.literalN+n], p[i:i+n])
			d.literalN += n
			d.pos += int64(n)
			i += n
			if d.literalN < 8 {
				continue
			}
			if err := d.applyLiteral(&out); err != nil {
				return out, d.fail(err)
			}
			d.codeIdx = d.literalCode + 1
			d.state = stateCodes
			if err := d.processCodes(&out); err != nil {
				return out, d.fail(err)
			}

		case stateDone:
			return out, d.fail(fmt.Errorf("%w: byte at offset %d", ErrExtraData, d.pos))
		}
	}
	return out, nil
}

// Finish declares physical EOF. It reports success only if opcode 252 was seen
// and the terminating group consumed all of its literal slots and no trailing
// bytes. Finish is idempotent only in the sense that a second call reports
// ErrState; callers must not call it twice.
func (d *Decoder) Finish() error {
	if d.final || d.done {
		return ErrState
	}
	if !d.terminated() {
		return d.fail(fmt.Errorf("%w: no terminator", ErrTruncated))
	}
	if d.state != stateDone {
		return d.fail(fmt.Errorf("%w: pending input at EOF", ErrTruncated))
	}
	d.final = true
	return nil
}

// Complete reports whether Finish has succeeded.
func (d *Decoder) Complete() bool {
	return d.final
}

// RowsDecoded reports the number of rows successfully returned so far.
func (d *Decoder) RowsDecoded() uint64 {
	return d.rows
}

func (d *Decoder) terminated() bool {
	return d.state == stateDone
}

func (d *Decoder) fail(err error) error {
	if err == nil {
		return nil
	}
	d.done = true
	return err
}

func (d *Decoder) processCodes(out *[]Row) error {
	for d.codeIdx < 8 {
		code := d.header[d.codeIdx]

		switch {
		case code == 0:
			d.codeIdx++
			continue

		case code == magicTerminator:
			if d.row.fieldIdx != 0 || d.row.slotIdx != 0 {
				return fmt.Errorf("%w: group %d code %d", ErrRowBoundary, d.groupOff, d.codeIdx)
			}
			for j := d.codeIdx + 1; j < 8; j++ {
				if d.header[j] != 0 {
					return fmt.Errorf("%w: group %d code %d follows terminator",
						ErrTerminatorHeader, d.groupOff, j)
				}
			}
			d.codeIdx = 8
			d.state = stateDone
			return nil

		case code == magicLiteral:
			d.literalGroup = d.groupOff
			d.literalCode = d.codeIdx
			d.literalOff = d.pos
			d.literalN = 0
			d.state = stateLiteral
			return nil

		case code == magicSpaces:
			var raw [8]byte
			for i := range raw {
				raw[i] = ' '
			}
			src := Source{GroupOffset: d.groupOff, CodeIndex: d.codeIdx,
				LiteralOffset: NoLiteralOffset}
			if err := d.applyBytes(raw, src, out); err != nil {
				return err
			}
			d.codeIdx++

		case code == magicMissing:
			src := Source{GroupOffset: d.groupOff, CodeIndex: d.codeIdx,
				LiteralOffset: NoLiteralOffset}
			if err := d.applyNumeric(systemMissingBits, true, src, out); err != nil {
				return err
			}
			d.codeIdx++

		default: // 1..251
			src := Source{GroupOffset: d.groupOff, CodeIndex: d.codeIdx,
				LiteralOffset: NoLiteralOffset}
			value := int(code) - d.cfg.bias
			bits := math.Float64bits(float64(value))
			if err := d.applyNumeric(bits, false, src, out); err != nil {
				return err
			}
			d.codeIdx++
		}
	}

	d.state = stateHeader
	d.headerN = 0
	return nil
}

func (d *Decoder) applyLiteral(out *[]Row) error {
	src := Source{
		GroupOffset:   d.literalGroup,
		CodeIndex:     d.literalCode,
		LiteralOffset: d.literalOff,
		LiteralLength: 8,
	}
	field := &d.cfg.fields[d.row.fieldIdx]

	switch field.kind {
	case Numeric:
		var bits uint64
		if d.cfg.order == BigEndian {
			bits = uint64(d.literal[0])<<56 | uint64(d.literal[1])<<48 |
				uint64(d.literal[2])<<40 | uint64(d.literal[3])<<32 |
				uint64(d.literal[4])<<24 | uint64(d.literal[5])<<16 |
				uint64(d.literal[6])<<8 | uint64(d.literal[7])
		} else {
			bits = uint64(d.literal[7])<<56 | uint64(d.literal[6])<<48 |
				uint64(d.literal[5])<<40 | uint64(d.literal[4])<<32 |
				uint64(d.literal[3])<<24 | uint64(d.literal[2])<<16 |
				uint64(d.literal[1])<<8 | uint64(d.literal[0])
		}
		return d.applyNumeric(bits, bits == systemMissingBits, src, out)

	case Bytes:
		return d.applyBytes(d.literal, src, out)
	}
	return fmt.Errorf("%w: field %q", ErrTypeMismatch, field.name)
}

func (d *Decoder) applyNumeric(bits uint64, missing bool, src Source, out *[]Row) error {
	if err := d.checkNewRow(); err != nil {
		return err
	}
	field := &d.cfg.fields[d.row.fieldIdx]
	if field.kind != Numeric {
		return fmt.Errorf("%w: field %q is bytes", ErrTypeMismatch, field.name)
	}
	if field.projected {
		d.row.values[field.projPos] = &Value{
			Field:   field.name,
			Kind:    Numeric,
			Missing: missing,
			Bits:    bits,
			Source:  src,
		}
	}
	return d.advanceSlot(out)
}

func (d *Decoder) applyBytes(raw [8]byte, src Source, out *[]Row) error {
	if err := d.checkNewRow(); err != nil {
		return err
	}
	field := &d.cfg.fields[d.row.fieldIdx]
	if field.kind != Bytes {
		return fmt.Errorf("%w: field %q is numeric", ErrTypeMismatch, field.name)
	}

	last := d.row.slotIdx == field.slots-1
	n := 8
	if last {
		n = field.width - (field.slots-1)*8
		if n < 8 {
			for i := n; i < 8; i++ {
				if raw[i] != ' ' {
					return fmt.Errorf("%w: field %q byte %d is 0x%02x",
						ErrBadPadding, field.name, i, raw[i])
				}
			}
		}
	}

	if field.projected {
		v := d.row.values[field.projPos]
		if v == nil {
			v = &Value{Field: field.name, Kind: Bytes, Source: src}
			d.row.values[field.projPos] = v
		}
		chunk := cloneBytes(raw[:n])
		v.Data = append(v.Data, chunk...)
		v.Fragments = append(v.Fragments, Fragment{Data: cloneBytes(chunk), Source: src})
	}
	return d.advanceSlot(out)
}

func (d *Decoder) checkNewRow() error {
	if d.row.fieldIdx == 0 && d.row.slotIdx == 0 && d.rows >= d.cfg.maxRows {
		return fmt.Errorf("%w: %d rows already delivered", ErrRowLimit, d.rows)
	}
	return nil
}

func (d *Decoder) advanceSlot(out *[]Row) error {
	field := &d.cfg.fields[d.row.fieldIdx]
	d.row.slotIdx++
	if d.row.slotIdx >= field.slots {
		d.row.fieldIdx++
		d.row.slotIdx = 0
		if d.row.fieldIdx == len(d.cfg.fields) {
			return d.completeRow(out)
		}
	}
	return nil
}

func (d *Decoder) completeRow(out *[]Row) error {
	if d.rows >= d.cfg.maxRows {
		return fmt.Errorf("%w: %d rows already delivered", ErrRowLimit, d.rows)
	}

	row := Row{Values: make([]Value, len(d.cfg.projection))}
	for i := range d.cfg.projection {
		v := d.row.values[i]
		if v == nil {
			return fmt.Errorf("%w: internal missing projected value", ErrInvalidConfig)
		}
		row.Values[i] = *v
	}
	*out = append(*out, row)
	d.rows++

	d.row.fieldIdx = 0
	d.row.slotIdx = 0
	for i := range d.row.values {
		d.row.values[i] = nil
	}
	return nil
}

func cloneBytes(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	return append([]byte(nil), b...)
}
