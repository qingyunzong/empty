package canonenc

import "errors"

var (
	// ErrIncomplete reports truncated input: the stream ends immediately
	// after an escape byte, so the final escape sequence is unfinished.
	// More input (or an explicit end-of-stream decision) is required.
	ErrIncomplete = errors.New("canonenc: incomplete escape sequence at end of input")

	// ErrNonCanonical reports illegal input: an escape sequence whose
	// payload decodes to a byte that does not require escaping. Such
	// input can never be produced by Encode and is rejected outright.
	ErrNonCanonical = errors.New("canonenc: non-canonical escape sequence")
)

// Decode decodes a complete canonical encoding. It returns ErrIncomplete
// if src ends with a dangling escape byte, and ErrNonCanonical if any
// escape sequence is not in canonical form.
func Decode(src []byte) ([]byte, error) {
	dst := make([]byte, 0, len(src))
	for i := 0; i < len(src); i++ {
		b := src[i]
		if b != EscapeByte {
			dst = append(dst, b)
			continue
		}
		if i+1 >= len(src) {
			return nil, ErrIncomplete
		}
		i++
		raw := unescapePayload(src[i])
		if !needsEscape(raw) {
			return nil, ErrNonCanonical
		}
		dst = append(dst, raw)
	}
	return dst, nil
}

// StreamDecoder decodes a canonical encoding fed in arbitrary chunks.
// Bytes that cannot be decoded yet (a trailing escape byte awaiting its
// payload) are held internally, so chunk boundaries may fall anywhere,
// including between the two bytes of an escape sequence.
type StreamDecoder struct {
	buf     []byte // decoded output
	pending bool   // an EscapeByte was seen and awaits its payload byte
}

// NewStreamDecoder returns a ready-to-use StreamDecoder.
func NewStreamDecoder() *StreamDecoder { return &StreamDecoder{} }

// Write consumes the next chunk of encoded input. It returns
// ErrNonCanonical as soon as an illegal escape sequence is seen.
// A dangling escape byte at the end of a chunk is not an error; it is
// resolved by the next Write or by Close.
func (d *StreamDecoder) Write(p []byte) (int, error) {
	for i := 0; i < len(p); i++ {
		b := p[i]
		if d.pending {
			d.pending = false
			raw := unescapePayload(b)
			if !needsEscape(raw) {
				return i, ErrNonCanonical
			}
			d.buf = append(d.buf, raw)
			continue
		}
		if b == EscapeByte {
			d.pending = true
			continue
		}
		d.buf = append(d.buf, b)
	}
	return len(p), nil
}

// Close signals end of stream. It returns ErrIncomplete if the stream
// ends in the middle of an escape sequence.
func (d *StreamDecoder) Close() error {
	if d.pending {
		return ErrIncomplete
	}
	return nil
}

// Bytes returns the decoded output accumulated so far.
func (d *StreamDecoder) Bytes() []byte { return d.buf }
