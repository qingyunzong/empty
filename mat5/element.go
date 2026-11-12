package mat5

import (
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"math"
)

// read consumes one normal or small element, honoring normal-element padding.
// Small elements always occupy exactly eight bytes and must not be advanced
// using the payload-length field of a normal header.
func (c *cursor) read() (*rawElem, error) {
	start := c.pos
	if uint64(len(c.buf))-start < 8 {
		return nil, ErrTruncated
	}
	tag := c.order.Uint32(c.buf[start : start+4])
	if !isNormalType(tag) {
		st, n, err := decodeSmallTag(tag, c.bo)
		if err != nil {
			return nil, err
		}
		payload := make([]byte, n)
		copy(payload, c.buf[start+4:start+4+uint64(n)])
		c.pos = start + 8 // compact small element: header and data in eight bytes
		return &rawElem{
			typ:     st,
			payload: payload,
			span:    Range{Start: start, End: start + 8},
			small:   true,
		}, nil
	}

	payloadBytes := c.order.Uint32(c.buf[start+4 : start+8])
	pb := uint64(payloadBytes)
	end := start + 8 + pb
	if end > uint64(len(c.buf)) {
		return nil, ErrTruncated
	}
	pad := (8 - (pb % 8)) % 8
	paddedEnd := end + pad
	if paddedEnd > uint64(len(c.buf)) {
		return nil, ErrTruncated
	}
	// Padding content is intentionally ignored.
	c.pos = paddedEnd
	return &rawElem{
		typ:     tag,
		payload: c.buf[start+8 : end],
		span:    Range{Start: start, End: paddedEnd},
	}, nil
}

// readTopLevelCompressed reads a type-15 element whose payload is not padded to
// an eight-byte boundary and returns the exact declared compressed bytes so
// that the next variable can begin on a non-eight-byte-aligned offset.
func (c *cursor) readTopLevelCompressed() (*rawElem, error) {
	start := c.pos
	if uint64(len(c.buf))-start < 8 {
		return nil, ErrTruncated
	}
	tag := c.order.Uint32(c.buf[start : start+4])
	if tag != TypeZlib {
		return nil, fmt.Errorf("%w: expected zlib tag, got %d", ErrBadType, tag)
	}
	payloadBytes := c.order.Uint32(c.buf[start+4 : start+8])
	end := start + 8 + uint64(payloadBytes)
	if end > uint64(len(c.buf)) {
		return nil, ErrTruncated
	}
	elem := &rawElem{
		typ:     TypeZlib,
		payload: c.buf[start+8 : end],
		span:    Range{Start: start, End: end},
	}
	c.pos = end // deliberately no padding after a compressed top-level element
	return elem, nil
}

func (c *cursor) peekUint32() (uint32, bool) {
	if c.pos+4 > uint64(len(c.buf)) {
		return 0, false
	}
	return c.order.Uint32(c.buf[c.pos : c.pos+4]), true
}

func isNormalType(t uint32) bool {
	switch t {
	case TypeInt8, TypeInt32, TypeUInt32, TypeFloat64, TypeMatrix, TypeZlib:
		return true
	default:
		return false
	}
}

// decodeSmallTag interprets the first four bytes of a compact element as
// uint16 type, uint16 n. n must be 1..4 and type must be one of 1/5/6/9.
func decodeSmallTag(first uint32, endian Endian) (typ uint32, n uint16, err error) {
	var typeWord, sizeWord uint16
	if endian == LittleEndian {
		typeWord = uint16(first)
		sizeWord = uint16(first >> 16)
	} else {
		typeWord = uint16(first >> 16)
		sizeWord = uint16(first)
	}
	typ = uint32(typeWord)
	n = sizeWord
	if n < 1 || n > 4 {
		return 0, 0, fmt.Errorf("%w: small element size %d not in 1..4", ErrBadElement, n)
	}
	switch typ {
	case TypeInt8, TypeInt32, TypeUInt32, TypeFloat64:
	default:
		return 0, 0, fmt.Errorf("%w: small element type %d", ErrBadType, typ)
	}
	return typ, n, nil
}

type countingReader struct {
	buf []byte
	pos int
}

func (r *countingReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.buf) {
		return 0, io.EOF
	}
	// Read one byte at a time so the consumed count never includes bytes
	// buffered ahead of the actual end of the zlib stream.
	n := 1
	r.pos += n
	p[0] = r.buf[r.pos-1]
	return n, nil
}

// cappedBuffer appends bytes while enforcing the inflated-byte budget before
// each write, so untrusted length fields can never drive unbounded allocation.
type cappedBuffer struct {
	buf      []byte
	limit    uint64
	inflated uint64
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if uint64(len(p)) > math.MaxUint64-b.inflated ||
		b.inflated+uint64(len(p)) > b.limit {
		return 0, fmt.Errorf("%w: inflated bytes exceed %d", ErrLimits, b.limit)
	}
	b.buf = append(b.buf, p...)
	b.inflated += uint64(len(p))
	return len(p), nil
}

// inflate fully decompresses one declared zlib payload. It rejects truncated
// or corrupt streams (checking the zlib checksum and trailer), enforces the
// inflated-byte budget, and requires every declared compressed byte to be
// consumed. A second concatenated zlib stream therefore fails rather than
// being silently accepted.
func (p *parser) inflate(payload []byte) ([]byte, error) {
	remaining := p.lim.MaxInflatedBytes - p.inflated
	if remaining == 0 && len(payload) > 0 {
		return nil, fmt.Errorf("%w: inflated bytes exceed %d", ErrLimits, p.lim.MaxInflatedBytes)
	}
	cr := &countingReader{buf: payload}
	zr, err := zlib.NewReader(cr)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInflate, err)
	}
	out := &cappedBuffer{limit: remaining}
	if _, err := io.Copy(out, zr); err != nil {
		_ = zr.Close()
		if errors.Is(err, ErrLimits) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", ErrInflate, err)
	}
	// Close verifies the Adler-32 checksum and end-of-stream marker.
	if err := zr.Close(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInflate, err)
	}
	if cr.pos != len(payload) {
		return nil, fmt.Errorf("%w: %d compressed byte(s) unconsumed (concatenated stream?)",
			ErrInflate, len(payload)-cr.pos)
	}
	p.inflated += out.inflated
	return out.buf, nil
}
