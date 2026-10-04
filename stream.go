package canonenc

import "fmt"

// Decoder is a streaming decoder for canonical encodings. Input may be
// delivered in arbitrarily sized chunks; an escape sequence split across
// chunk boundaries is buffered and completed by later writes.
//
// Malformed or non-canonical input is reported by Write as soon as it is
// detectable (error wrapping ErrInvalid). A chunk boundary in the middle
// of an escape sequence is not an error; if the stream ends there,
// Finalize reports ErrIncomplete. This keeps truncation (incomplete)
// strictly distinct from corruption (invalid).
type Decoder struct {
	pending [3]byte // bytes of a partial escape: pending[0] is always '%'
	npend   int     // 0 = idle, 1 = have '%', 2 = have '%' and one digit
	offset  int     // absolute stream offset, for error messages
	failed  bool    // sticky: a previous Write failed
}

// NewDecoder returns a ready-to-use streaming Decoder.
func NewDecoder() *Decoder { return &Decoder{} }

// Reset returns the Decoder to its initial state.
func (d *Decoder) Reset() { *d = Decoder{} }

// Write consumes the next chunk of encoded input and returns the bytes
// decoded from it. The returned slice is only valid until the next call
// to Write. If p ends inside an escape sequence, the partial sequence is
// buffered and produces no output yet; that is not an error. Malformed or
// non-canonical input yields an error wrapping ErrInvalid, after which
// the Decoder is unusable until Reset.
func (d *Decoder) Write(p []byte) ([]byte, error) {
	if d.failed {
		return nil, fmt.Errorf("%w: decoder is in failed state after earlier error", ErrInvalid)
	}
	out := make([]byte, 0, len(p))
	i := 0
	// Complete a partial escape carried over from the previous chunk.
	for d.npend > 0 && i < len(p) {
		c := p[i]
		if _, good := unhex(c); !good {
			d.failed = true
			return nil, fmt.Errorf("%w: non-hex escape digit 0x%02X at offset %d", ErrInvalid, c, d.offset)
		}
		d.pending[d.npend] = c
		d.npend++
		d.offset++
		i++
		if d.npend == 3 {
			v, err := finishEscape(d.pending[1], d.pending[2], d.offset-3)
			if err != nil {
				d.failed = true
				return nil, err
			}
			out = append(out, v)
			d.npend = 0
		}
	}
	for i < len(p) {
		b, n, ok, err := decodeOne(p, i)
		if err != nil {
			d.failed = true
			return nil, err
		}
		if !ok {
			// Tail of the chunk is a partial escape: buffer it.
			d.pending[0] = EscapeByte
			d.npend = 1
			if i+1 < len(p) {
				d.pending[1] = p[i+1]
				d.npend = 2
			}
			d.offset += len(p) - i
			i = len(p)
			break
		}
		out = append(out, b)
		d.offset += n
		i += n
	}
	return out, nil
}

// Finalize reports whether the encoded stream ended on a complete
// boundary. It returns nil if every escape sequence was completed, or an
// error wrapping ErrIncomplete if the stream was truncated mid-escape.
func (d *Decoder) Finalize() error {
	if d.failed {
		return fmt.Errorf("%w: decoder is in failed state after earlier error", ErrInvalid)
	}
	if d.npend > 0 {
		return fmt.Errorf("%w at offset %d", ErrIncomplete, d.offset-d.npend)
	}
	return nil
}

// finishEscape validates a complete "%XY" escape and returns its byte.
func finishEscape(hiC, loC byte, off int) (byte, error) {
	hi, _ := unhex(hiC)
	lo, _ := unhex(loC)
	if hiC >= 'a' || loC >= 'a' {
		return 0, fmt.Errorf("%w: lowercase hex escape at offset %d (non-canonical)", ErrInvalid, off)
	}
	v := hi<<4 | lo
	if !MustEscape(v) {
		return 0, fmt.Errorf("%w: escape of non-must-escape byte 0x%02X at offset %d (non-canonical)", ErrInvalid, v, off)
	}
	return v, nil
}
