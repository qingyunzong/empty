// Package telemetry implements a bit-level telemetry codec with
// caller-selected bit order, signed widths, varints, alignment,
// transactional cursors, and serializable pause/resume state.
package telemetry

import (
	"errors"
	"fmt"
	"io"
)

// BitOrder selects how bits are laid out within each byte of the stream.
type BitOrder int

const (
	// MSBFirst places the first bit of the stream at bit 7 of byte 0.
	MSBFirst BitOrder = iota
	// LSBFirst places the first bit of the stream at bit 0 of byte 0.
	LSBFirst
)

var (
	// ErrOverflow reports a value that does not fit the target width or
	// a varint that needs more than 64 bits.
	ErrOverflow = errors.New("telemetry: value overflows field width")
	// ErrOverlong reports a non-minimal (overlong) varint encoding.
	ErrOverlong = errors.New("telemetry: overlong varint encoding")
	// ErrOutOfRange reports a signed value outside the width's range.
	ErrOutOfRange = errors.New("telemetry: signed value out of range")
	// ErrWidth reports an invalid bit width.
	ErrWidth = errors.New("telemetry: invalid bit width")
)

func checkWidth(width int) error {
	if width < 0 || width > 64 {
		return fmt.Errorf("%w: %d", ErrWidth, width)
	}
	return nil
}

// Writer appends bits to an in-memory stream.
type Writer struct {
	order BitOrder
	buf   []byte
	nbits int
}

// NewWriter returns a Writer using the given bit order.
func NewWriter(order BitOrder) *Writer { return &Writer{order: order} }

// Pos returns the current bit cursor.
func (w *Writer) Pos() int { return w.nbits }

// WriteBit appends the low bit of b.
func (w *Writer) WriteBit(b uint64) {
	if w.nbits%8 == 0 {
		w.buf = append(w.buf, 0)
	}
	if b&1 != 0 {
		if w.order == MSBFirst {
			w.buf[w.nbits/8] |= 1 << (7 - uint(w.nbits%8))
		} else {
			w.buf[w.nbits/8] |= 1 << uint(w.nbits%8)
		}
	}
	w.nbits++
}

// WriteBits appends the low width bits of v, most significant bit first
// under MSBFirst and least significant bit first under LSBFirst. It fails
// without writing anything if v does not fit in width bits.
func (w *Writer) WriteBits(v uint64, width int) error {
	if err := checkWidth(width); err != nil {
		return err
	}
	if width < 64 && v>>uint(width) != 0 {
		return fmt.Errorf("%w: %d does not fit in %d bits", ErrOverflow, v, width)
	}
	if w.order == MSBFirst {
		for i := width - 1; i >= 0; i-- {
			w.WriteBit(v >> uint(i))
		}
	} else {
		for i := 0; i < width; i++ {
			w.WriteBit(v >> uint(i))
		}
	}
	return nil
}

// WriteSigned appends s in two's complement using width bits. It fails
// without writing anything if s is outside [-(1<<(width-1)), 1<<(width-1)-1].
func (w *Writer) WriteSigned(s int64, width int) error {
	if width < 1 || width > 64 {
		return fmt.Errorf("%w: %d", ErrWidth, width)
	}
	if width < 64 {
		min := -(int64(1) << uint(width-1))
		max := int64(1)<<uint(width-1) - 1
		if s < min || s > max {
			return fmt.Errorf("%w: %d not in [%d, %d] for %d bits", ErrOutOfRange, s, min, max, width)
		}
		return w.WriteBits(uint64(s)&(uint64(1)<<uint(width)-1), width)
	}
	return w.WriteBits(uint64(s), width)
}

// Align pads with zero bits until the cursor is a multiple of the given
// bit count and reports how many padding bits were written.
func (w *Writer) Align(multiple int) (int, error) {
	if multiple <= 0 {
		return 0, fmt.Errorf("%w: alignment %d", ErrWidth, multiple)
	}
	pad := (multiple - w.nbits%multiple) % multiple
	for i := 0; i < pad; i++ {
		w.WriteBit(0)
	}
	return pad, nil
}

// Seek truncates the stream back to bit position pos, rolling back any
// bits written after it. It panics if pos is out of range.
func (w *Writer) Seek(pos int) {
	if pos < 0 || pos > w.nbits {
		panic("telemetry: writer seek out of range")
	}
	w.nbits = pos
	w.buf = w.buf[:(pos+7)/8]
	if rem := uint(pos % 8); rem != 0 {
		if w.order == MSBFirst {
			w.buf[pos/8] &= 0xff << (8 - rem)
		} else {
			w.buf[pos/8] &= (1 << rem) - 1
		}
	}
}

// Bytes returns the stream contents, zero-padded to a whole byte.
func (w *Writer) Bytes() []byte {
	out := make([]byte, (w.nbits+7)/8)
	copy(out, w.buf)
	return out
}

// Reader consumes bits from an in-memory buffer or a streaming source.
// Bytes pulled from the source stay cached, so rolling the cursor back
// never re-reads the source.
type Reader struct {
	order BitOrder
	src   io.Reader
	cache []byte
	nbits int
	pos   int
}

// NewReader returns a Reader over a fully buffered stream.
func NewReader(data []byte, order BitOrder) *Reader {
	return &Reader{order: order, cache: data, nbits: len(data) * 8}
}

// NewReaderBits is NewReader with an explicit bit length, allowing a
// stream whose last byte is only partially used.
func NewReaderBits(data []byte, nbits int, order BitOrder) *Reader {
	if nbits > len(data)*8 {
		panic("telemetry: bit length exceeds data")
	}
	return &Reader{order: order, cache: data, nbits: nbits}
}

// NewStreamReader returns a Reader that pulls bytes from src on demand.
func NewStreamReader(src io.Reader, order BitOrder) *Reader {
	return &Reader{order: order, src: src}
}

// Pos returns the current bit cursor.
func (r *Reader) Pos() int { return r.pos }

// CachedBits reports how many bits have been pulled into the cache from
// the external source. Rollback never shrinks this.
func (r *Reader) CachedBits() int { return r.nbits }

// Seek moves the cursor to bit position pos. Cached bytes are retained.
// It panics if pos is negative or beyond the cached bits.
func (r *Reader) Seek(pos int) {
	if pos < 0 || pos > r.nbits {
		panic("telemetry: reader seek out of range")
	}
	r.pos = pos
}

func (r *Reader) ensure(n int) error {
	for r.nbits-r.pos < n {
		if r.src == nil {
			return io.ErrUnexpectedEOF
		}
		var chunk [256]byte
		nr, err := r.src.Read(chunk[:])
		r.cache = append(r.cache, chunk[:nr]...)
		r.nbits += nr * 8
		if err != nil {
			if err == io.EOF {
				return io.ErrUnexpectedEOF
			}
			return err
		}
		if nr == 0 && err == nil {
			return io.ErrNoProgress
		}
	}
	return nil
}

// ReadBit consumes one bit.
func (r *Reader) ReadBit() (uint64, error) {
	if err := r.ensure(1); err != nil {
		return 0, err
	}
	b := r.cache[r.pos/8]
	var v uint64
	if r.order == MSBFirst {
		v = uint64(b>>(7-uint(r.pos%8))) & 1
	} else {
		v = uint64(b>>uint(r.pos%8)) & 1
	}
	r.pos++
	return v, nil
}

// ReadBits consumes width bits. On failure the cursor is not advanced.
func (r *Reader) ReadBits(width int) (uint64, error) {
	if err := checkWidth(width); err != nil {
		return 0, err
	}
	if err := r.ensure(width); err != nil {
		return 0, err
	}
	var v uint64
	if r.order == MSBFirst {
		for i := 0; i < width; i++ {
			b, _ := r.ReadBit()
			v = v<<1 | b
		}
	} else {
		for i := 0; i < width; i++ {
			b, _ := r.ReadBit()
			v |= b << uint(i)
		}
	}
	return v, nil
}

// ReadSigned consumes width bits and sign-extends them to int64.
// On failure the cursor is not advanced.
func (r *Reader) ReadSigned(width int) (int64, error) {
	if width < 1 || width > 64 {
		return 0, fmt.Errorf("%w: %d", ErrWidth, width)
	}
	u, err := r.ReadBits(width)
	if err != nil {
		return 0, err
	}
	return SignExtend(u, width), nil
}

// SignExtend interprets the low width bits of u as two's complement.
func SignExtend(u uint64, width int) int64 {
	if width >= 64 {
		return int64(u)
	}
	if u>>(uint(width)-1) != 0 {
		return int64(u | ^(uint64(1)<<uint(width) - 1))
	}
	return int64(u)
}

// Align skips zero or more bits until the cursor is a multiple of the
// given bit count and reports how many bits were skipped.
func (r *Reader) Align(multiple int) (int, error) {
	if multiple <= 0 {
		return 0, fmt.Errorf("%w: alignment %d", ErrWidth, multiple)
	}
	pad := (multiple - r.pos%multiple) % multiple
	if err := r.ensure(pad); err != nil {
		return 0, err
	}
	r.pos += pad
	return pad, nil
}
