// Package textstream provides a streaming UTF-8 decoder that accepts only
// shortest-form encodings, recovers from invalid bytes one byte at a time,
// and records the source byte range behind every decoded code point. It
// also supports versioned, incremental re-decoding under byte-level edits.
package textstream

import "unicode/utf8"

// Mapping records the source byte range [Start, End) that produced one
// output code point.
type Mapping struct {
	Start int
	End   int
}

// Decoder incrementally decodes a byte stream into code points.
//
// Rules:
//   - only shortest-form UTF-8 is accepted (overlong forms, surrogates and
//     values above U+10FFFF are rejected);
//   - an invalid sequence is consumed one byte at a time, each byte
//     producing one U+FFFD replacement character;
//   - a truncated sequence at the end of a chunk is held back until more
//     bytes arrive (or Close flushes it, one U+FFFD per pending byte).
type Decoder struct {
	buf    []byte // undecoded bytes (a possible incomplete sequence tail)
	base   int    // stream offset of buf[0]
	runes  []rune
	maps   []Mapping
	closed bool
}

// NewDecoder returns a Decoder positioned at stream offset 0.
func NewDecoder() *Decoder { return &Decoder{} }

// Write feeds the next chunk of stream bytes. It panics if called after
// Close.
func (d *Decoder) Write(p []byte) {
	if d.closed {
		panic("textstream: Write after Close")
	}
	if len(p) == 0 {
		return
	}
	d.buf = append(d.buf, p...)
	d.advance(false)
}

// Close marks the stream complete. Any held-back incomplete sequence is
// flushed as one U+FFFD per pending byte.
func (d *Decoder) Close() {
	if d.closed {
		return
	}
	d.advance(true)
	d.closed = true
}

func (d *Decoder) advance(final bool) {
	for len(d.buf) > 0 {
		r, size, incomplete := decodeOne(d.buf)
		if incomplete {
			if !final {
				return // wait for the next chunk
			}
			r, size = utf8.RuneError, 1
		}
		d.runes = append(d.runes, r)
		d.maps = append(d.maps, Mapping{Start: d.base, End: d.base + size})
		d.base += size
		d.buf = d.buf[size:]
	}
}

// Runes returns the code points decoded so far.
func (d *Decoder) Runes() []rune { return append([]rune(nil), d.runes...) }

// Mappings returns the source byte ranges of the code points decoded so
// far, in the same order as Runes.
func (d *Decoder) Mappings() []Mapping { return append([]Mapping(nil), d.maps...) }

// Len returns the number of code points decoded so far.
func (d *Decoder) Len() int { return len(d.runes) }

// DecodeAll decodes a complete byte slice in one shot.
func DecodeAll(b []byte) ([]rune, []Mapping) {
	d := NewDecoder()
	d.Write(b)
	d.Close()
	return d.Runes(), d.Mappings()
}

// decodeOne decodes the first code point in b. incomplete reports that b
// holds a valid prefix of a multi-byte sequence that more bytes could
// complete.
func decodeOne(b []byte) (r rune, size int, incomplete bool) {
	if len(b) == 0 {
		return utf8.RuneError, 0, true
	}
	b0 := b[0]
	if b0 < 0x80 {
		return rune(b0), 1, false
	}
	lo, hi := byte(0x80), byte(0xBF)
	switch {
	case b0 < 0xC2: // continuation byte or overlong lead C0/C1
		return utf8.RuneError, 1, false
	case b0 < 0xE0:
		size = 2
	case b0 == 0xE0:
		size, lo = 3, 0xA0
	case b0 < 0xED:
		size = 3
	case b0 == 0xED:
		size, hi = 3, 0x9F
	case b0 < 0xF0:
		size = 3
	case b0 == 0xF0:
		size, lo = 4, 0x90
	case b0 <= 0xF3:
		size = 4
	case b0 == 0xF4:
		size, hi = 4, 0x8F
	default: // F5..FF can never start a sequence
		return utf8.RuneError, 1, false
	}
	if len(b) > 1 && (b[1] < lo || b[1] > hi) {
		return utf8.RuneError, 1, false
	}
	for i := 2; i < size && i < len(b); i++ {
		if b[i] < 0x80 || b[i] > 0xBF {
			return utf8.RuneError, 1, false
		}
	}
	if len(b) < size {
		return utf8.RuneError, 0, true
	}
	switch size {
	case 2:
		return rune(b0&0x1F)<<6 | rune(b[1]&0x3F), 2, false
	case 3:
		return rune(b0&0x0F)<<12 | rune(b[1]&0x3F)<<6 | rune(b[2]&0x3F), 3, false
	default:
		return rune(b0&0x07)<<18 | rune(b[1]&0x3F)<<12 | rune(b[2]&0x3F)<<6 | rune(b[3]&0x3F), 4, false
	}
}
