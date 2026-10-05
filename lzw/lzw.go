// Package lzw implements LZW compression and decompression using the GIF
// variant of the format: LSB-first bit packing, 8-bit literal codes, a
// clear code, an EOF code, and code widths growing from 9 to 12 bits as
// the dictionary fills. The bit format is compatible with the standard
// library's compress/lzw package, which the tests use as an independent
// encoder/decoder for cross-verification.
package lzw

import (
	"errors"
	"hash"
)

const (
	// LitWidth is the width in bits of a literal code.
	LitWidth = 8
	// ClearCode resets the dictionary and the code width.
	ClearCode = 1 << LitWidth
	// EOFCode terminates the stream.
	EOFCode = ClearCode + 1

	maxWidth    = 12
	maxCode     = 1<<maxWidth - 1
	invalidCode = 0xffff

	firstDictCode = EOFCode + 1
)

var (
	// ErrMissingEOF reports a stream that ends before the EOF code.
	ErrMissingEOF = errors.New("lzw: stream ended before EOF code")
	// ErrInvalidCode reports a code that the decoder cannot have defined yet.
	ErrInvalidCode = errors.New("lzw: invalid code")
	// ErrTrailingBits reports non-padding bits or bytes after the EOF code.
	ErrTrailingBits = errors.New("lzw: trailing bits after EOF code")
	// ErrCheckpoint reports a checkpoint that does not match the stream.
	ErrCheckpoint = errors.New("lzw: checkpoint does not match stream state")
)

type decoder struct {
	data     []byte
	bitPos   uint64
	width    uint
	hi       uint16
	overflow uint16
	last     uint16

	suffix [1 << maxWidth]uint8
	prefix [1 << maxWidth]uint16
	tmp    [1 << maxWidth]byte

	codeIndex int
	outLen    int

	srcHasher hash.Hash
	srcFed    int

	lastCodeRead uint16
	selfRef      bool
	clears       int
	maxHi        uint16
}

func newDecoder(data []byte) *decoder {
	return &decoder{
		data:     data,
		width:    LitWidth + 1,
		hi:       EOFCode,
		overflow: 1 << (LitWidth + 1),
		last:     invalidCode,
	}
}

func (d *decoder) readCode() (uint16, bool) {
	if d.bitPos+uint64(d.width) > uint64(len(d.data))*8 {
		return 0, false
	}
	bytePos := d.bitPos / 8
	off := uint(d.bitPos % 8)
	nbytes := (off + d.width + 7) / 8
	var v uint32
	for i := uint(0); i < nbytes; i++ {
		v |= uint32(d.data[bytePos+uint64(i)]) << (8 * i)
	}
	code := uint16(v>>off) & (1<<d.width - 1)
	d.bitPos += uint64(d.width)
	return code, true
}

// step reads and processes a single code. Output bytes are appended to
// *out unless out is nil, and are always counted in d.outLen. It returns
// done=true once the EOF code has been consumed.
func (d *decoder) step(out *[]byte) (bool, error) {
	code, ok := d.readCode()
	if !ok {
		return false, ErrMissingEOF
	}
	d.lastCodeRead = code
	d.codeIndex++
	emit := func(b byte) {
		d.outLen++
		if out != nil {
			*out = append(*out, b)
		}
	}
	switch {
	case code < ClearCode:
		emit(byte(code))
		if d.last != invalidCode {
			d.suffix[d.hi] = byte(code)
			d.prefix[d.hi] = d.last
		}
	case code == ClearCode:
		d.width = LitWidth + 1
		d.hi = EOFCode
		d.overflow = 1 << (LitWidth + 1)
		d.last = invalidCode
		d.clears++
		return false, nil
	case code == EOFCode:
		return true, nil
	case code <= d.hi:
		c := code
		if code == d.hi {
			if d.last == invalidCode {
				return false, ErrInvalidCode
			}
			d.selfRef = true
			c = d.last
		}
		n := 0
		walk := c
		for walk >= ClearCode {
			d.tmp[n] = d.suffix[walk]
			n++
			walk = d.prefix[walk]
			if n == len(d.tmp) {
				return false, ErrInvalidCode
			}
		}
		head := byte(walk)
		emit(head)
		for i := n - 1; i >= 0; i-- {
			emit(d.tmp[i])
		}
		if code == d.hi {
			emit(head)
		}
		if d.last != invalidCode {
			d.suffix[d.hi] = head
			d.prefix[d.hi] = d.last
		}
	default:
		return false, ErrInvalidCode
	}
	d.last, d.hi = code, d.hi+1
	if d.hi > d.maxHi {
		d.maxHi = d.hi
	}
	if d.hi >= d.overflow {
		if d.width == maxWidth {
			d.last = invalidCode
			d.hi--
		} else {
			d.width++
			d.overflow = 1 << d.width
		}
	}
	return false, nil
}

func (d *decoder) checkTrailing() error {
	rem := uint64(len(d.data))*8 - d.bitPos
	if rem >= 8 {
		return ErrTrailingBits
	}
	if rem > 0 && d.data[d.bitPos/8]>>(d.bitPos%8) != 0 {
		return ErrTrailingBits
	}
	return nil
}

// Decode decompresses a complete LZW stream. It reports ErrMissingEOF,
// ErrInvalidCode or ErrTrailingBits on malformed input.
func Decode(data []byte) ([]byte, error) {
	d := newDecoder(data)
	var out []byte
	for {
		done, err := d.step(&out)
		if err != nil {
			return nil, err
		}
		if done {
			if err := d.checkTrailing(); err != nil {
				return nil, err
			}
			return out, nil
		}
	}
}
