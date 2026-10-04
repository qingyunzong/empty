// Package recstream reads a stream of text records whose encoding may be
// declared per record. A record is a sequence of code points terminated by
// U+001E (RECORD SEPARATOR); the final record may end at EOF instead.
//
// An encoding declaration is a BOM at the very start of a record:
//
//	EF BB BF  UTF-8
//	FF FE     UTF-16LE
//	FE FF     UTF-16BE
//
// Declarations are only recognized at record boundaries. A BOM code point
// (U+FEFF) decoded inside record content is rejected as a mid-record
// encoding change. Records without a declaration use the encoding of the
// previous record (UTF-8 for the first). Every decoded code point retains
// the byte range it occupied in the original input. Malformed input —
// invalid UTF-8, unpaired UTF-16 surrogates, truncated code units — is
// reported as an error rather than silently replaced.
package recstream

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"unicode/utf16"
	"unicode/utf8"
)

// Encoding is a declared text encoding.
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

// Sentinel errors returned by Reader.Next.
var (
	// ErrMidRecordDeclaration is returned when a BOM (U+FEFF) appears
	// inside record content instead of at a record boundary.
	ErrMidRecordDeclaration = errors.New("recstream: encoding declaration inside record")
	// ErrUnpairedSurrogate is returned for a UTF-16 surrogate code unit
	// that is not part of a valid surrogate pair.
	ErrUnpairedSurrogate = errors.New("recstream: unpaired UTF-16 surrogate")
	// ErrInvalidUTF8 is returned for bytes that are not valid UTF-8.
	ErrInvalidUTF8 = errors.New("recstream: invalid UTF-8")
	// ErrTruncated is returned when the stream ends in the middle of a
	// multi-byte code point.
	ErrTruncated = errors.New("recstream: truncated code point")
)

// recordSeparator terminates a record.
const recordSeparator = '\u001E'

// bomRune is the byte order mark; valid only as a record-start declaration.
const bomRune = '\uFEFF'

// ByteRange is a half-open byte range [Start, End) in the original stream.
type ByteRange struct {
	Start int64
	End   int64
}

// CodePoint is a decoded rune together with its original byte range.
type CodePoint struct {
	Rune rune
	ByteRange
}

// Record is one decoded record.
type Record struct {
	// Encoding is the encoding in effect for this record.
	Encoding Encoding
	// Decl is the byte range of the encoding declaration (BOM).
	// HasDecl reports whether a declaration was present.
	Decl    ByteRange
	HasDecl bool
	// Points are the decoded content code points, excluding the
	// declaration and the record separator.
	Points []CodePoint
}

// String returns the record content as a string.
func (r *Record) String() string {
	runes := make([]rune, len(r.Points))
	for i, p := range r.Points {
		runes[i] = p.Rune
	}
	return string(runes)
}

// Reader decodes records from an underlying byte stream. It buffers
// internally, so the chunk sizes of the underlying reader do not affect
// the decoded result.
type Reader struct {
	br  *bufio.Reader
	pos int64 // absolute offset of the next unread byte
	enc Encoding
	err error // sticky terminal error
}

// NewReader returns a Reader decoding records from r.
func NewReader(r io.Reader) *Reader {
	return &Reader{br: bufio.NewReader(r), enc: UTF8}
}

// Next decodes and returns the next record. It returns io.EOF when the
// stream is exhausted at a record boundary. Any other error is terminal:
// subsequent calls return the same error.
func (r *Reader) Next() (*Record, error) {
	if r.err != nil {
		return nil, r.err
	}
	rec, err := r.next()
	if err != nil {
		r.err = err
	}
	return rec, err
}

func (r *Reader) next() (*Record, error) {
	rec := &Record{}
	if enc, n, ok := r.peekDecl(); ok {
		start := r.pos
		if _, err := r.br.Discard(n); err != nil {
			return nil, err
		}
		r.pos += int64(n)
		r.enc = enc
		rec.Decl = ByteRange{Start: start, End: r.pos}
		rec.HasDecl = true
	}
	rec.Encoding = r.enc
	for {
		cp, err := r.readCodePoint()
		if err == io.EOF {
			if len(rec.Points) == 0 && !rec.HasDecl {
				return nil, io.EOF
			}
			return rec, nil
		}
		if err != nil {
			return nil, err
		}
		switch cp.Rune {
		case recordSeparator:
			return rec, nil
		case bomRune:
			return nil, fmt.Errorf("%w at byte %d", ErrMidRecordDeclaration, cp.Start)
		}
		rec.Points = append(rec.Points, cp)
	}
}

// peekDecl reports whether the upcoming bytes are a BOM declaration.
// It must only be called at a record boundary.
func (r *Reader) peekDecl() (Encoding, int, bool) {
	if b, err := r.br.Peek(3); err == nil {
		if b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
			return UTF8, 3, true
		}
	}
	if b, err := r.br.Peek(2); err == nil {
		switch {
		case b[0] == 0xFF && b[1] == 0xFE:
			return UTF16LE, 2, true
		case b[0] == 0xFE && b[1] == 0xFF:
			return UTF16BE, 2, true
		}
	}
	return r.enc, 0, false
}

// readCodePoint decodes one code point in the current encoding.
func (r *Reader) readCodePoint() (CodePoint, error) {
	start := r.pos
	switch r.enc {
	case UTF8:
		return r.readUTF8(start)
	default:
		return r.readUTF16(start)
	}
}

func (r *Reader) readByte() (byte, error) {
	b, err := r.br.ReadByte()
	if err != nil {
		return 0, err
	}
	r.pos++
	return b, nil
}

func (r *Reader) readUTF8(start int64) (CodePoint, error) {
	var buf [utf8.UTFMax]byte
	b, err := r.readByte()
	if err != nil {
		return CodePoint{}, err // io.EOF at a code point boundary
	}
	buf[0] = b
	size := 1
	switch {
	case b < 0x80:
	case b >= 0xC2 && b < 0xE0:
		size = 2
	case b >= 0xE0 && b < 0xF0:
		size = 3
	case b >= 0xF0 && b < 0xF5:
		size = 4
	default:
		return CodePoint{}, fmt.Errorf("%w at byte %d", ErrInvalidUTF8, start)
	}
	for i := 1; i < size; i++ {
		b, err = r.readByte()
		if err != nil {
			return CodePoint{}, fmt.Errorf("%w at byte %d", ErrTruncated, start)
		}
		buf[i] = b
	}
	ru, n := utf8.DecodeRune(buf[:size])
	if ru == utf8.RuneError || n != size {
		return CodePoint{}, fmt.Errorf("%w at byte %d", ErrInvalidUTF8, start)
	}
	return CodePoint{Rune: ru, ByteRange: ByteRange{Start: start, End: r.pos}}, nil
}

func (r *Reader) readUTF16(start int64) (CodePoint, error) {
	u1, err := r.readUnit()
	if err != nil {
		return CodePoint{}, err // io.EOF at a code point boundary
	}
	switch {
	case 0xD800 <= u1 && u1 < 0xDC00: // high surrogate: needs a low surrogate
		u2, err := r.readUnit()
		if err != nil {
			if err == io.EOF {
				err = ErrTruncated
			}
			return CodePoint{}, fmt.Errorf("%w at byte %d", err, start)
		}
		if u2 < 0xDC00 || 0xE000 <= u2 {
			return CodePoint{}, fmt.Errorf("%w at byte %d", ErrUnpairedSurrogate, start)
		}
		return CodePoint{Rune: utf16.DecodeRune(rune(u1), rune(u2)), ByteRange: ByteRange{Start: start, End: r.pos}}, nil
	case 0xDC00 <= u1 && u1 < 0xE000: // lone low surrogate
		return CodePoint{}, fmt.Errorf("%w at byte %d", ErrUnpairedSurrogate, start)
	}
	return CodePoint{Rune: rune(u1), ByteRange: ByteRange{Start: start, End: r.pos}}, nil
}

// readUnit reads one 16-bit code unit in the current byte order.
func (r *Reader) readUnit() (uint16, error) {
	b0, err := r.readByte()
	if err != nil {
		return 0, err
	}
	b1, err := r.readByte()
	if err != nil {
		return 0, fmt.Errorf("%w at byte %d", ErrTruncated, r.pos-1)
	}
	if r.enc == UTF16LE {
		return uint16(b0) | uint16(b1)<<8, nil
	}
	return uint16(b0)<<8 | uint16(b1), nil
}
