// Package recstream decodes a stream of newline-terminated records whose
// encoding may switch between UTF-8, UTF-16LE and UTF-16BE.
//
// An encoding declaration is a byte-order mark (BOM): EF BB BF for UTF-8,
// FF FE for UTF-16LE and FE FF for UTF-16BE. A declaration is only legal at
// a record boundary: the start of the stream or immediately after a record
// terminator (U+000A in the then-current encoding). A U+FEFF decoded anywhere
// inside a record is rejected as an out-of-place declaration. Invalid byte
// sequences, truncated input and unpaired UTF-16 surrogates are reported as
// errors; the decoder never silently substitutes U+FFFD.
//
// The Decoder is fed arbitrary byte chunks with Write, so records, BOMs and
// surrogate pairs may be split across chunk boundaries. Every decoded code
// point carries the absolute byte range it occupied in the input stream.
package recstream

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"unicode/utf16"
	"unicode/utf8"
)

// Encoding identifies the byte encoding of a record.
type Encoding int

const (
	UTF8 Encoding = iota
	UTF16LE
	UTF16BE
)

func (e Encoding) String() string {
	switch e {
	case UTF8:
		return "UTF-8"
	case UTF16LE:
		return "UTF-16LE"
	case UTF16BE:
		return "UTF-16BE"
	}
	return "unknown"
}

// ErrNeedMore is returned by Decoder.Next when the buffered bytes do not yet
// determine the next event and the decoder has not been closed.
var ErrNeedMore = errors.New("recstream: need more input")

// DecodeError describes a malformed input byte sequence.
type DecodeError struct {
	Offset int64 // absolute byte offset of the offending bytes
	Reason string
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("recstream: offset %d: %s", e.Offset, e.Reason)
}

// EventKind identifies the kind of a Decoder event.
type EventKind int

const (
	// EventDeclaration reports an encoding declaration (BOM) at a record
	// boundary. Encoding holds the newly selected encoding.
	EventDeclaration EventKind = iota
	// EventRune reports one decoded code point.
	EventRune
	// EventRecordEnd reports a record terminator (U+000A).
	EventRecordEnd
)

func (k EventKind) String() string {
	switch k {
	case EventDeclaration:
		return "Declaration"
	case EventRune:
		return "Rune"
	case EventRecordEnd:
		return "RecordEnd"
	}
	return "unknown"
}

// Event is one decoded item. Start and End are absolute byte offsets in the
// input stream: Start is the offset of the first byte and End is one past the
// last byte of the declaration, code point or terminator the event describes.
// For UTF-16 supplementary characters the range spans all four bytes.
type Event struct {
	Kind     EventKind
	Encoding Encoding // encoding in effect (set for all kinds)
	Rune     rune     // decoded code point (EventRune only)
	Start    int64
	End      int64
}

// Decoder incrementally decodes a mixed-encoding record stream.
type Decoder struct {
	buf      []byte
	base     int64 // absolute offset of buf[0]
	enc      Encoding
	boundary bool // currently at a record boundary
	closed   bool
	err      error
}

// NewDecoder returns a Decoder whose initial encoding is UTF-8 unless a
// different initial encoding is supplied.
func NewDecoder(initial ...Encoding) *Decoder {
	enc := UTF8
	if len(initial) > 0 {
		enc = initial[0]
	}
	return &Decoder{enc: enc, boundary: true}
}

// Write appends the next chunk of input. Chunks may be of any size and may
// split records, BOMs, multi-byte sequences and surrogate pairs.
func (d *Decoder) Write(p []byte) { d.buf = append(d.buf, p...) }

// Close signals that no more input will be written. After Close, a truncated
// final sequence is reported as an error instead of ErrNeedMore, and Next
// returns io.EOF once all input has been consumed.
func (d *Decoder) Close() { d.closed = true }

// Encoding returns the encoding currently in effect.
func (d *Decoder) Encoding() Encoding { return d.enc }

// Next returns the next event. It returns ErrNeedMore if more input is
// required, io.EOF if the decoder is closed and all input has been consumed,
// or a *DecodeError for malformed input. A decode error is sticky: subsequent
// calls return the same error.
func (d *Decoder) Next() (Event, error) {
	if d.err != nil {
		return Event{}, d.err
	}
	ev, err := d.advance()
	if err != nil && !errors.Is(err, ErrNeedMore) && !errors.Is(err, io.EOF) {
		d.err = err
	}
	return ev, err
}

func (d *Decoder) advance() (Event, error) {
	if len(d.buf) == 0 {
		if d.closed {
			return Event{}, io.EOF
		}
		return Event{}, ErrNeedMore
	}
	if d.boundary {
		enc, size, isDecl, decided := detectDeclaration(d.buf, d.closed)
		if !decided {
			return Event{}, ErrNeedMore
		}
		if isDecl {
			start := d.base
			d.consume(size)
			d.enc = enc
			return Event{Kind: EventDeclaration, Encoding: enc, Start: start, End: d.base}, nil
		}
	}
	r, size, err := d.decodeRune()
	if err != nil {
		return Event{}, err
	}
	start := d.base
	if r == 0xFEFF {
		// A declaration is only legal at a record boundary, and at a
		// boundary it is intercepted above, so a decoded U+FEFF here is
		// an out-of-place declaration inside a record.
		return Event{}, &DecodeError{Offset: start, Reason: "encoding declaration not at record boundary"}
	}
	d.consume(size)
	if r == '\n' {
		d.boundary = true
		return Event{Kind: EventRecordEnd, Encoding: d.enc, Start: start, End: d.base}, nil
	}
	d.boundary = false
	return Event{Kind: EventRune, Encoding: d.enc, Rune: r, Start: start, End: d.base}, nil
}

func (d *Decoder) consume(n int) {
	d.buf = d.buf[n:]
	d.base += int64(n)
}

// detectDeclaration reports whether buf starts with a BOM. decided is false
// when more bytes are needed to tell. When closed is true, an ambiguous short
// prefix is decided as "not a declaration" so the bytes are decoded (and
// rejected if malformed) as ordinary data.
func detectDeclaration(buf []byte, closed bool) (enc Encoding, size int, isDecl, decided bool) {
	needMore := func() (Encoding, int, bool, bool) {
		if closed {
			return 0, 0, false, true
		}
		return 0, 0, false, false
	}
	switch buf[0] {
	case 0xEF:
		if len(buf) < 2 {
			return needMore()
		}
		if buf[1] != 0xBB {
			return 0, 0, false, true
		}
		if len(buf) < 3 {
			return needMore()
		}
		if buf[2] != 0xBF {
			return 0, 0, false, true
		}
		return UTF8, 3, true, true
	case 0xFF:
		if len(buf) < 2 {
			return needMore()
		}
		if buf[1] != 0xFE {
			return 0, 0, false, true
		}
		return UTF16LE, 2, true, true
	case 0xFE:
		if len(buf) < 2 {
			return needMore()
		}
		if buf[1] != 0xFF {
			return 0, 0, false, true
		}
		return UTF16BE, 2, true, true
	}
	return 0, 0, false, true
}

func (d *Decoder) decodeRune() (rune, int, error) {
	if d.enc == UTF8 {
		if !utf8.FullRune(d.buf) {
			if d.closed {
				return 0, 0, &DecodeError{Offset: d.base, Reason: "truncated UTF-8 sequence"}
			}
			return 0, 0, ErrNeedMore
		}
		r, size := utf8.DecodeRune(d.buf)
		if r == utf8.RuneError && size == 1 {
			// Invalid byte, overlong form or a UTF-8 encoded surrogate.
			// A legitimately encoded U+FFFD has size 3 and is accepted.
			return 0, 0, &DecodeError{Offset: d.base, Reason: "invalid UTF-8 byte sequence"}
		}
		return r, size, nil
	}
	if len(d.buf) < 2 {
		if d.closed {
			return 0, 0, &DecodeError{Offset: d.base, Reason: "truncated UTF-16 code unit"}
		}
		return 0, 0, ErrNeedMore
	}
	u1 := d.unit(d.buf)
	switch {
	case u1 >= 0xDC00 && u1 <= 0xDFFF:
		return 0, 0, &DecodeError{Offset: d.base, Reason: "unpaired low surrogate"}
	case u1 >= 0xD800 && u1 <= 0xDBFF:
		if len(d.buf) < 4 {
			if d.closed {
				return 0, 0, &DecodeError{Offset: d.base, Reason: "truncated surrogate pair"}
			}
			return 0, 0, ErrNeedMore
		}
		u2 := d.unit(d.buf[2:])
		if u2 < 0xDC00 || u2 > 0xDFFF {
			return 0, 0, &DecodeError{Offset: d.base, Reason: "high surrogate not followed by low surrogate"}
		}
		return utf16.DecodeRune(rune(u1), rune(u2)), 4, nil
	}
	return rune(u1), 2, nil
}

func (d *Decoder) unit(b []byte) uint16 {
	if d.enc == UTF16LE {
		return binary.LittleEndian.Uint16(b)
	}
	return binary.BigEndian.Uint16(b)
}
