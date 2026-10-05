// Package streamtext implements a streaming UTF-8 decoder that accepts
// code points only in their shortest form, replaces invalid bytes one at
// a time with U+FFFD, and records the source byte range of every decoded
// code point. It also provides a versioned document with incremental
// re-decoding across byte edits.
package streamtext

import "unicode/utf8"

// Replacement is the code point emitted for each invalid byte.
const Replacement = utf8.RuneError

// Span is a half-open byte range [Start, End) in the source stream.
type Span struct {
	Start int
	End   int
}

// seqLen returns the expected length in bytes of the shortest-form UTF-8
// sequence led by b, or 0 if b cannot start a valid sequence.
func seqLen(b byte) int {
	switch {
	case b < 0x80:
		return 1
	case b >= 0xC2 && b <= 0xDF:
		return 2
	case b >= 0xE0 && b <= 0xEF:
		return 3
	case b >= 0xF0 && b <= 0xF4:
		return 4
	default:
		return 0
	}
}

// contOK reports whether c is a legal continuation byte at position pos
// (1-based) of a sequence led by lead, enforcing shortest-form ranges.
func contOK(lead, c byte, pos int) bool {
	lo, hi := byte(0x80), byte(0xBF)
	if pos == 1 {
		switch lead {
		case 0xE0:
			lo = 0xA0
		case 0xED:
			hi = 0x9F
		case 0xF0:
			lo = 0x90
		case 0xF4:
			hi = 0x8F
		}
	}
	return c >= lo && c <= hi
}

// step decodes the sequence starting at data[i]. If the bytes present are a
// valid prefix of a sequence but more bytes are needed, it reports
// incomplete. An invalid sequence consumes exactly one byte and yields
// Replacement.
func step(data []byte, i int) (r rune, size int, incomplete bool) {
	b := data[i]
	n := seqLen(b)
	if n == 0 {
		return Replacement, 1, false
	}
	if n == 1 {
		return rune(b), 1, false
	}
	avail := len(data) - i
	check := avail
	if check > n {
		check = n
	}
	for j := 1; j < check; j++ {
		if !contOK(b, data[i+j], j) {
			return Replacement, 1, false
		}
	}
	if avail < n {
		return 0, 0, true
	}
	switch n {
	case 2:
		r = rune(b&0x1F)<<6 | rune(data[i+1]&0x3F)
	case 3:
		r = rune(b&0x0F)<<12 | rune(data[i+1]&0x3F)<<6 | rune(data[i+2]&0x3F)
	case 4:
		r = rune(b&0x07)<<18 | rune(data[i+1]&0x3F)<<12 | rune(data[i+2]&0x3F)<<6 | rune(data[i+3]&0x3F)
	}
	return r, n, false
}

// Decoder is a streaming UTF-8 decoder. Bytes are fed with Write; a
// trailing incomplete sequence is held until the next Write or Flush.
// Offsets reported in spans are absolute stream positions.
type Decoder struct {
	pending []byte
	off     int // absolute offset of pending[0], or of the next byte if no pending
}

// NewDecoder returns a Decoder starting at stream offset 0.
func NewDecoder() *Decoder { return NewDecoderAt(0) }

// NewDecoderAt returns a Decoder whose first byte sits at absolute
// stream offset off.
func NewDecoderAt(off int) *Decoder { return &Decoder{off: off} }

// Pending reports whether the decoder holds an incomplete trailing sequence.
func (d *Decoder) Pending() bool { return len(d.pending) > 0 }

// Write feeds the next chunk of the stream and returns the code points
// completed by it together with their absolute source byte spans.
func (d *Decoder) Write(chunk []byte) (runes []rune, spans []Span) {
	if len(chunk) == 0 {
		return nil, nil
	}
	buf := make([]byte, 0, len(d.pending)+len(chunk))
	buf = append(buf, d.pending...)
	buf = append(buf, chunk...)
	base := d.off
	d.pending = d.pending[:0]
	i := 0
	for i < len(buf) {
		r, size, incomplete := step(buf, i)
		if incomplete {
			d.pending = append(d.pending, buf[i:]...)
			break
		}
		runes = append(runes, r)
		spans = append(spans, Span{Start: base + i, End: base + i + size})
		i += size
	}
	d.off = base + i
	return runes, spans
}

// Flush terminates the stream, decoding any held incomplete bytes under
// the usual rule: each invalid byte yields one Replacement.
func (d *Decoder) Flush() (runes []rune, spans []Span) {
	buf := d.pending
	d.pending = nil
	base := d.off
	d.off = base + len(buf)
	for i := 0; i < len(buf); {
		r, size, incomplete := step(buf, i)
		if incomplete {
			r, size = Replacement, 1
		}
		runes = append(runes, r)
		spans = append(spans, Span{Start: base + i, End: base + i + size})
		i += size
	}
	return runes, spans
}

// Decode decodes a complete byte string in one shot, returning the code
// points and their source byte spans.
func Decode(data []byte) (runes []rune, spans []Span) {
	d := NewDecoder()
	runes, spans = d.Write(data)
	r2, s2 := d.Flush()
	return append(runes, r2...), append(spans, s2...)
}
