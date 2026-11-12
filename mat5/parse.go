// Package mat5 parses a closed subset of MAT-Level-5 matrix data elements.
//
// The input is the byte stream remaining after the MAT-file header has been
// removed. A fixed byte order is supplied by the caller; no per-stream endian
// sniffing is performed. The package only understands the element types
// int8(1), int32(5), uint32(6), float64(9), matrix(14) and zlib(15), with the
// compact small-element encoding described in the package README.
package mat5

import (
	"encoding/binary"
	"fmt"
)

// Element type tags understood by the closed subset.
const (
	TypeInt8    uint32 = 1
	TypeInt32   uint32 = 5
	TypeUInt32  uint32 = 6
	TypeFloat64 uint32 = 9
	TypeMatrix  uint32 = 14
	TypeZlib    uint32 = 15
)

const (
	flagComplex uint32 = 0x800
	classMask   uint32 = 0xff
)

type rawElem struct {
	typ     uint32
	payload []byte
	span    Range // header + payload + padding in the enclosing stream
	small   bool
}

type cursor struct {
	buf   []byte
	pos   uint64
	order binary.ByteOrder
	bo    Endian
}

// locator maps offsets in the stream currently being read to physical input
// offsets, and records inflated logical offsets where applicable.
type locator struct {
	base        uint64
	inflated    bool
	logicalBase uint64
}

func (l locator) physical(off, end uint64) Range {
	return Range{Start: l.base + off, End: l.base + end}
}

func (l locator) source(off, end uint64) Source {
	src := Source{Physical: l.physical(off, end)}
	if l.inflated {
		src.Inflated = true
		src.Logical = Range{Start: l.logicalBase + off, End: l.logicalBase + end}
	}
	return src
}

type parser struct {
	data     []byte
	order    binary.ByteOrder
	endian   Endian
	lim      Limits
	inflated uint64
	nodes    uint64
	numCells uint64
}

// Parse validates the whole stream and, only on full success, returns an
// immutable variable table.
func Parse(data []byte, endian Endian, lim Limits) (*Table, error) {
	if lim.MaxInflatedBytes == 0 || lim.MaxMatrixNodes == 0 ||
		lim.MaxNumericCells == 0 || lim.MaxDepth <= 0 {
		return nil, fmt.Errorf("%w: every limit must be greater than zero", ErrLimits)
	}
	var order binary.ByteOrder = binary.LittleEndian
	if endian == BigEndian {
		order = binary.BigEndian
	}
	p := &parser{data: data, order: order, endian: endian, lim: lim}

	c := &cursor{buf: data, bo: endian, order: order}
	t := &Table{}
	seen := map[string]struct{}{}

	for c.pos < uint64(len(c.buf)) {
		first, ok := c.peekUint32()
		if !ok {
			return nil, ErrTruncated
		}
		if !isNormalType(first) {
			// A small element is never legal at the top level.
			st, _, err := decodeSmallTag(first, endian)
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("%w: small element type %d at top level", ErrBadType, st)
		}

		if first == TypeZlib {
			elem, err := c.readTopLevelCompressed()
			if err != nil {
				return nil, err
			}
			inflated, err := p.inflate(elem.payload)
			if err != nil {
				return nil, err
			}
			ic := &cursor{buf: inflated, bo: endian, order: order}
			iloc := locator{inflated: true}
			mhead, err := ic.read()
			if err != nil {
				return nil, err
			}
			if mhead.typ == TypeZlib {
				return nil, fmt.Errorf("%w: nested compressed elements are not allowed", ErrBadType)
			}
			if mhead.typ != TypeMatrix || mhead.small {
				return nil, fmt.Errorf("%w: zlib payload must contain exactly one matrix element", ErrBadType)
			}
			val, _, err := p.parseMatrixPayload(mhead, ic, iloc, 1, 0)
			if err != nil {
				return nil, err
			}
			if ic.pos != uint64(len(inflated)) {
				return nil, fmt.Errorf("%w: %d trailing byte(s) after matrix inside zlib",
					ErrBadElement, uint64(len(inflated))-ic.pos)
			}
			name := matrixName(val)
			if err := checkTopLevelName(name, seen); err != nil {
				return nil, err
			}
			rewriteInflatedSources(val, elem.span)
			t.vars = append(t.vars, Variable{Name: name, Value: val})
			continue
		}

		if first != TypeMatrix {
			return nil, fmt.Errorf("%w: top-level element type %d (only matrix or zlib)",
				ErrBadType, first)
		}
		elem, err := c.read()
		if err != nil {
			return nil, err
		}
		mloc := locator{base: elem.span.Start}
		mc := &cursor{buf: elem.payload, bo: endian, order: order}
		val, consumed, err := p.parseMatrixPayload(elem, mc, mloc, 1, 0)
		if err != nil {
			return nil, err
		}
		if consumed != uint64(len(elem.payload)) {
			return nil, fmt.Errorf("%w: %d trailing byte(s) in matrix payload",
				ErrBadElement, uint64(len(elem.payload))-consumed)
		}
		name := matrixName(val)
		if err := checkTopLevelName(name, seen); err != nil {
			return nil, err
		}
		t.vars = append(t.vars, Variable{Name: name, Value: val})
	}

	return t, nil
}

func matrixName(v Value) string {
	switch m := v.(type) {
	case *DoubleMatrix:
		return m.name
	case *Int32Matrix:
		return m.name
	case *CellMatrix:
		return m.name
	}
	return ""
}

// rewriteInflatedSources redirects every node of an inflated tree to the
// compressed element's physical range while preserving each node's logical
// inflated range as computed during the parse.
func rewriteInflatedSources(v Value, physical Range) {
	switch m := v.(type) {
	case *DoubleMatrix:
		m.src = Source{Physical: physical, Inflated: true, Logical: m.src.Logical}
	case *Int32Matrix:
		m.src = Source{Physical: physical, Inflated: true, Logical: m.src.Logical}
	case *CellMatrix:
		m.src = Source{Physical: physical, Inflated: true, Logical: m.src.Logical}
		for _, child := range m.children {
			rewriteInflatedSources(child, physical)
		}
	}
}
