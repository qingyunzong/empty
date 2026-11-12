package dataeng

import (
	"fmt"
	"math/big"
)

// DecodeOptions controls record decoding.
//
// MaxLeaves limits the number of leaf occurrences decoded across the whole
// record. A value less than or equal to zero means no limit.
type DecodeOptions struct {
	MaxLeaves int
}

// Record is a fully decoded record. Fields are root-level occurrences in
// physical order. Size is the consumed record length and Leaves is the number
// of expanded leaf occurrences.
type Record struct {
	Fields []*Field
	Leaves int
	Size   int
}

// Field is one decoded occurrence. For groups, Children holds the decoded
// child occurrences. For numeric leaves Value is set. For RawBytes leaves Raw
// is set. Start and End are the half-open physical byte range of this occurrence
// (and for a short selected overlay branch, End is the branch's actual end, not
// the overlay's full reserved span).
type Field struct {
	Path       string
	Kind       Kind
	Start      int
	End        int
	Occurrence int
	Value      *Decimal
	Raw        []byte
	Children   []*Field
}

// Find returns all occurrences with the given field path in traversal order.
func (r *Record) Find(path string) []*Field {
	if r == nil {
		return nil
	}
	var out []*Field
	var walk func([]*Field)
	walk = func(fields []*Field) {
		for _, f := range fields {
			if f.Path == path {
				out = append(out, f)
			}
			walk(f.Children)
		}
	}
	walk(r.Fields)
	return out
}

// First returns the first occurrence with the given path, or nil.
func (r *Record) First(path string) *Field {
	fields := r.Find(path)
	if len(fields) == 0 {
		return nil
	}
	return fields[0]
}

// Decode decodes data using the compiled layout. At most one DecodeOptions
// value is used. The record must consume exactly len(data); decoded records are
// all-or-nothing.
func (l *Layout) Decode(data []byte, options ...DecodeOptions) (*Record, error) {
	if l == nil {
		return nil, &DecodeError{Code: ErrRecordSize, Path: "<layout>", Reason: "nil layout"}
	}
	var opts DecodeOptions
	if len(options) > 0 {
		opts = options[0]
	}
	d := &decoder{
		layout:     l,
		data:       data,
		maxLeaves:  opts.MaxLeaves,
		rootValues: map[string]*Field{},
		record:     &Record{},
	}
	if err := d.decodeRoot(); err != nil {
		return nil, err
	}
	if d.offset != len(data) {
		return nil, d.recordSizeError()
	}
	d.record.Size = len(data)
	d.record.Leaves = d.leaves
	return d.record, nil
}

type decoder struct {
	layout     *Layout
	data       []byte
	maxLeaves  int
	leaves     int
	offset     int
	rootValues map[string]*Field
	record     *Record
}

func (d *decoder) decodeRoot() error {
	nodes := d.layout.root.children
	for i := 0; i < len(nodes); {
		n := nodes[i]
		if n.ast.Overlay != "" {
			name := n.ast.Overlay
			j := i + 1
			for j < len(nodes) && nodes[j].ast.Overlay == name {
				j++
			}
			if err := d.decodeOverlay(d.layout.overlays[name]); err != nil {
				return err
			}
			i = j
			continue
		}

		fields, err := d.decodeNode(n)
		if err != nil {
			return err
		}
		d.record.Fields = append(d.record.Fields, fields...)
		if n.ast.Occurs == nil && len(fields) == 1 {
			d.rootValues[n.ast.Path] = fields[0]
		}
		i++
	}
	return nil
}

func (d *decoder) decodeOverlay(ov *layoutOverlay) error {
	control := d.rootValues[ov.control.ast.Path]
	if control == nil || control.Value == nil || control.Value.Value == nil {
		return &DecodeError{
			Code:   ErrBranch,
			Path:   ov.control.ast.Path,
			Offset: 0,
			Reason: "overlay control value was not decoded",
		}
	}

	value := control.Value.Value
	if !value.IsUint64() {
		return &DecodeError{
			Code:   ErrBranch,
			Path:   control.Path,
			Offset: control.Start,
			Reason: fmt.Sprintf("overlay %q control value %s has no matching branch", ov.name, value.String()),
		}
	}
	path, ok := ov.values[value.Uint64()]
	if !ok {
		return &DecodeError{
			Code:   ErrBranch,
			Path:   control.Path,
			Offset: control.Start,
			Reason: fmt.Sprintf("overlay %q control value %s has no matching branch", ov.name, value.String()),
		}
	}
	branch := ov.branchByKey[path]
	start := d.offset
	if ov.span > int64(len(d.data)-start) {
		return &DecodeError{
			Code:   ErrBounds,
			Path:   path,
			Offset: start,
			Reason: fmt.Sprintf("overlay %q reserves %d bytes but the record ends early", ov.name, ov.span),
		}
	}
	end64 := int64(start) + ov.span

	fields, err := d.decodeNode(branch)
	if err != nil {
		return err
	}
	d.record.Fields = append(d.record.Fields, fields...)
	d.offset = int(end64)
	return nil
}

func (d *decoder) decodeNode(n *layoutNode) ([]*Field, error) {
	count, err := d.occurrenceCount(n)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, nil
	}
	fields := make([]*Field, 0, count)
	for i := 0; i < count; i++ {
		field, err := d.decodeOne(n, i)
		if err != nil {
			return nil, err
		}
		fields = append(fields, field)
	}
	return fields, nil
}

func (d *decoder) occurrenceCount(n *layoutNode) (int, error) {
	if n.occurs == nil {
		return 1, nil
	}
	if !n.occurs.variable {
		return n.occurs.max, nil
	}
	control := d.rootValues[n.occurs.control.ast.Path]
	if control == nil || control.Value == nil || control.Value.Value == nil {
		return 0, &DecodeError{
			Code:   ErrCount,
			Path:   n.ast.Path,
			Offset: d.offset,
			Reason: fmt.Sprintf("DEPENDING ON field %q was not decoded", n.occurs.control.ast.Path),
		}
	}
	value := control.Value.Value
	max := big.NewInt(int64(n.occurs.max))
	if value.Sign() < 0 || value.Cmp(max) > 0 {
		return 0, &DecodeError{
			Code:   ErrCount,
			Path:   n.ast.Path,
			Offset: d.offset,
			Reason: fmt.Sprintf("DEPENDING ON value %s is outside the range 0..%d", value.String(), n.occurs.max),
		}
	}
	return int(value.Int64()), nil
}

func (d *decoder) decodeOne(n *layoutNode, occurrence int) (*Field, error) {
	start := d.offset
	if n.ast.Kind != Group {
		return d.decodeLeaf(n, occurrence)
	}

	field := &Field{
		Path:       n.ast.Path,
		Kind:       Group,
		Start:      start,
		Occurrence: occurrence,
	}
	for _, child := range n.children {
		fields, err := d.decodeNode(child)
		if err != nil {
			return nil, err
		}
		field.Children = append(field.Children, fields...)
	}
	field.End = d.offset
	return field, nil
}

func (d *decoder) decodeLeaf(n *layoutNode, occurrence int) (*Field, error) {
	size := leafSize(n.ast)
	start := d.offset
	if size > len(d.data)-start {
		return nil, boundsError(n.ast.Path, start, size, len(d.data)-start)
	}
	if d.maxLeaves > 0 && d.leaves >= d.maxLeaves {
		return nil, &DecodeError{
			Code:   ErrLeafLimit,
			Path:   n.ast.Path,
			Offset: start,
			Reason: fmt.Sprintf("expanded leaf limit %d would be exceeded", d.maxLeaves),
		}
	}
	d.leaves++

	field := &Field{
		Path:       n.ast.Path,
		Kind:       n.ast.Kind,
		Start:      start,
		End:        start + size,
		Occurrence: occurrence,
	}
	raw := d.data[start : start+size]
	switch n.ast.Kind {
	case UnsignedDisplay:
		value, err := decodeDisplay(raw, n.ast.Digits, start, n.ast.Path)
		if err != nil {
			return nil, err
		}
		field.Value = value
	case SignedPacked:
		value, err := decodePacked(raw, n.ast.Digits, n.ast.Scale, start, n.ast.Path)
		if err != nil {
			return nil, err
		}
		field.Value = value
	case RawBytes:
		field.Raw = append([]byte(nil), raw...)
	default:
		return nil, &DecodeError{Code: ErrRecordSize, Path: n.ast.Path, Offset: start, Reason: "unexpected leaf kind"}
	}
	d.offset = start + size
	return field, nil
}

func (d *decoder) recordSizeError() *DecodeError {
	path := d.layout.ast.Root.Path
	if path == "" {
		path = "<record>"
	}
	return &DecodeError{
		Code:   ErrRecordSize,
		Path:   path,
		Offset: d.offset,
		Reason: fmt.Sprintf("record has %d bytes but layout consumed %d", len(d.data), d.offset),
	}
}

func leafSize(n *Node) int {
	switch n.Kind {
	case UnsignedDisplay:
		return n.Digits
	case SignedPacked:
		return n.Digits/2 + 1
	case RawBytes:
		return n.Bytes
	default:
		return 0
	}
}
