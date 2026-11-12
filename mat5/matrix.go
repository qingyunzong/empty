package mat5

import (
	"fmt"
	"math"
)

// parseMatrix reads one complete matrix element from c and returns the typed
// value. The element must fully consume a matrix payload; callers verify that
// separately after the call.
func (p *parser) parseMatrix(c *cursor, loc locator, depth int) (Value, error) {
	if depth > p.lim.MaxDepth {
		return nil, fmt.Errorf("%w: depth %d exceeds %d", ErrLimits, depth, p.lim.MaxDepth)
	}
	start := c.pos
	head, err := c.read()
	if err != nil {
		return nil, err
	}
	if head.typ != TypeMatrix {
		return nil, fmt.Errorf("%w: expected matrix element, got type %d", ErrBadType, head.typ)
	}
	if head.small {
		return nil, fmt.Errorf("%w: matrix cannot be a small element", ErrBadElement)
	}
	v, _, err := p.parseMatrixPayload(head, c, loc, depth, start)
	return v, err
}

// parseMatrixPayload validates the sub-element sequence inside one matrix
// payload. head is the enclosing matrix element already consumed from c.
func (p *parser) parseMatrixPayload(head *rawElem, c *cursor, loc locator,
	depth int, start uint64) (Value, uint64, error) {

	p.nodes++
	if p.nodes > p.lim.MaxMatrixNodes {
		return nil, 0, fmt.Errorf("%w: matrix node count exceeds %d", ErrLimits, p.lim.MaxMatrixNodes)
	}

	body := &cursor{buf: head.payload, bo: c.bo, order: p.order}

	// 1) Array flags: exactly an 8-byte normal type-6 element.
	flags, err := body.read()
	if err != nil {
		return nil, 0, err
	}
	if flags.small || flags.typ != TypeUInt32 || len(flags.payload) != 8 {
		return nil, 0, fmt.Errorf("%w: array flags must be an 8-byte type-6 element", ErrBadElement)
	}
	word0 := p.order.Uint32(flags.payload[0:4])
	word1 := p.order.Uint32(flags.payload[4:8])
	if word1 != 0 {
		return nil, 0, fmt.Errorf("%w: second flags word must be zero", ErrBadElement)
	}
	class := word0 & classMask
	complex := word0&flagComplex != 0
	if word0&^(classMask|flagComplex) != 0 {
		return nil, 0, fmt.Errorf("%w: reserved flags bits set: %#x", ErrBadElement, word0)
	}
	switch class {
	case 1, 6, 12:
	default:
		return nil, 0, fmt.Errorf("%w: class %d not in {1 cell,6 double,12 int32}", ErrClass, class)
	}
	if complex && class != 6 {
		return nil, 0, fmt.Errorf("%w: complex flag only valid for double class", ErrClass)
	}

	// 2) Dimension vector: type 5, at least two non-negative int32 entries.
	dimElem, err := body.read()
	if err != nil {
		return nil, 0, err
	}
	if dimElem.typ != TypeInt32 {
		return nil, 0, fmt.Errorf("%w: dimensions must be a type-5 element, got %d", ErrBadElement, dimElem.typ)
	}
	if len(dimElem.payload) < 8 || len(dimElem.payload)%4 != 0 {
		return nil, 0, fmt.Errorf("%w: dimension vector needs at least two int32 entries", ErrBadElement)
	}
	dims := make([]int32, len(dimElem.payload)/4)
	for i := range dims {
		v := int32(p.order.Uint32(dimElem.payload[i*4:]))
		if v < 0 {
			return nil, 0, fmt.Errorf("%w: negative dimension %d", ErrBadElement, v)
		}
		dims[i] = v
	}

	// 3) Name: type 1 bytes. Top-level names are validated after a full parse;
	// cell children must carry an empty name.
	nameElem, err := body.read()
	if err != nil {
		return nil, 0, err
	}
	if nameElem.typ != TypeInt8 {
		return nil, 0, fmt.Errorf("%w: name must be a type-1 element, got %d", ErrBadElement, nameElem.typ)
	}
	name := string(nameElem.payload)
	if depth > 1 && len(name) != 0 {
		return nil, 0, fmt.Errorf("%w: cell child name must be empty, got %q", ErrName, name)
	}

	count, err := dimProduct(dims)
	if err != nil {
		return nil, 0, err
	}

	matrixEnd := start + 8 + uint64(len(head.payload)) +
		(8-(uint64(len(head.payload))%8))%8
	src := loc.source(start, matrixEnd)

	switch class {
	case 6:
		v, err := p.parseDouble(body, depth, dims, name, count, complex, src)
		return v, body.pos, err
	case 12:
		v, err := p.parseInt32(body, depth, dims, name, count, src)
		return v, body.pos, err
	default:
		v, err := p.parseCell(body, loc, depth, dims, name, count, src)
		return v, body.pos, err
	}
}

// dimProduct computes the element count column-major style. A zero dimension
// wins immediately (the product is zero) without rejecting intermediate
// products; otherwise every multiplication is checked for overflow.
func dimProduct(dims []int32) (uint64, error) {
	for _, d := range dims {
		if d == 0 {
			return 0, nil
		}
	}
	var product uint64 = 1
	for _, d := range dims {
		v := uint64(d)
		if v > math.MaxUint64/product {
			return 0, fmt.Errorf("%w: dimension product overflows uint64", ErrLimits)
		}
		product *= v
	}
	return product, nil
}

func (p *parser) reserveNumeric(count uint64) error {
	if count > p.lim.MaxNumericCells-p.numCells {
		return fmt.Errorf("%w: numeric cell count exceeds %d", ErrLimits, p.lim.MaxNumericCells)
	}
	p.numCells += count
	return nil
}

func exactPayload(e *rawElem, want uint64) error {
	if uint64(len(e.payload)) != want {
		return fmt.Errorf("%w: type-%d payload is %d bytes, want %d",
			ErrBadElement, e.typ, len(e.payload), want)
	}
	return nil
}

func (p *parser) parseDouble(body *cursor, depth int, dims []int32,
	name string, count uint64, complex bool, src Source) (Value, error) {

	if err := p.reserveNumeric(count); err != nil {
		return nil, err
	}
	if count > math.MaxUint64/8 {
		return nil, fmt.Errorf("%w: double payload size overflows", ErrBadElement)
	}
	realBytes := count * 8
	realElem, err := body.read()
	if err != nil {
		return nil, err
	}
	if realElem.typ != TypeFloat64 {
		return nil, fmt.Errorf("%w: double requires type-9 real part, got %d", ErrClass, realElem.typ)
	}
	if err := exactPayload(realElem, realBytes); err != nil {
		return nil, err
	}
	real := make([]uint64, count)
	for i := range real {
		real[i] = p.order.Uint64(realElem.payload[i*8:])
	}
	m := &DoubleMatrix{name: name, dims: dims, real: real, src: src}

	if complex {
		imagElem, err := body.read()
		if err != nil {
			return nil, err
		}
		if imagElem.typ != TypeFloat64 {
			return nil, fmt.Errorf("%w: complex double requires type-9 imaginary part, got %d",
				ErrClass, imagElem.typ)
		}
		if err := exactPayload(imagElem, realBytes); err != nil {
			return nil, err
		}
		imag := make([]uint64, count)
		for i := range imag {
			imag[i] = p.order.Uint64(imagElem.payload[i*8:])
		}
		m.imag = imag
	}

	if body.pos != uint64(len(body.buf)) {
		return nil, fmt.Errorf("%w: %d extra byte(s) in double matrix",
			ErrBadElement, uint64(len(body.buf))-body.pos)
	}
	return m, nil
}

func (p *parser) parseInt32(body *cursor, depth int, dims []int32,
	name string, count uint64, src Source) (Value, error) {

	if err := p.reserveNumeric(count); err != nil {
		return nil, err
	}
	if count > math.MaxUint64/4 {
		return nil, fmt.Errorf("%w: int32 payload size overflows", ErrBadElement)
	}
	dataBytes := count * 4
	dataElem, err := body.read()
	if err != nil {
		return nil, err
	}
	if dataElem.typ != TypeInt32 {
		return nil, fmt.Errorf("%w: int32 requires a type-5 data element, got %d", ErrClass, dataElem.typ)
	}
	if err := exactPayload(dataElem, dataBytes); err != nil {
		return nil, err
	}
	values := make([]int32, count)
	for i := range values {
		values[i] = int32(p.order.Uint32(dataElem.payload[i*4:]))
	}

	if body.pos != uint64(len(body.buf)) {
		return nil, fmt.Errorf("%w: %d extra byte(s) in int32 matrix",
			ErrBadElement, uint64(len(body.buf))-body.pos)
	}
	return &Int32Matrix{name: name, dims: dims, values: values, src: src}, nil
}

func (p *parser) parseCell(body *cursor, loc locator, depth int, dims []int32,
	name string, count uint64, src Source) (Value, error) {

	var children []Value
	for i := uint64(0); i < count; i++ {
		if body.pos >= uint64(len(body.buf)) {
			return nil, fmt.Errorf("%w: cell expects %d children, got %d",
				ErrTruncated, count, i)
		}
		// Nested zlib inside a matrix body is not part of the subset.
		if peek, ok := body.peekUint32(); ok && peek == TypeZlib {
			return nil, fmt.Errorf("%w: nested compressed elements are not allowed", ErrBadType)
		}
		child, err := p.parseMatrix(body, loc, depth+1)
		if err != nil {
			return nil, err
		}
		children = append(children, child)
	}
	if body.pos != uint64(len(body.buf)) {
		return nil, fmt.Errorf("%w: %d extra byte(s) in cell matrix",
			ErrBadElement, uint64(len(body.buf))-body.pos)
	}
	return &CellMatrix{name: name, dims: dims, children: children, src: src}, nil
}

// checkTopLevelName enforces non-empty strict ASCII alphanumeric/underscore
// names starting with a letter, and uniqueness across the whole stream.
func checkTopLevelName(name string, seen map[string]struct{}) error {
	if len(name) == 0 {
		return fmt.Errorf("%w: top-level variable name is empty", ErrName)
	}
	first := name[0]
	if !isASCIILetter(first) {
		return fmt.Errorf("%w: name %q must start with a letter", ErrName, name)
	}
	for i := 0; i < len(name); i++ {
		ch := name[i]
		if !isASCIILetter(ch) && !isASCIIDigit(ch) && ch != '_' {
			return fmt.Errorf("%w: name %q contains non-ASCII-alphanumeric byte %#x",
				ErrName, name, ch)
		}
	}
	if _, dup := seen[name]; dup {
		return fmt.Errorf("%w: duplicate variable name %q", ErrName, name)
	}
	seen[name] = struct{}{}
	return nil
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isASCIIDigit(b byte) bool {
	return b >= '0' && b <= '9'
}
