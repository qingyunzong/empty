package q225

import (
	"errors"
	"io"
)

// BodyReader turns a Decoder into an idiomatic io.ReadCloser while keeping
// the connection-safe position semantics of Feed.
//
// It never reads beyond the end of the message: when the decoder finishes,
// the bytes of a pipelined next request that happened to arrive in the same
// connection read are retained in Leftover instead of being consumed or
// buffered silently. A handler hands Leftover to the next request parser
// and closes the connection whenever Err() is non-nil.
type BodyReader struct {
	dec       *Decoder
	r         io.Reader
	pending   []byte // bytes read from r but not yet presented to the decoder
	out       []byte // decoded payload not yet copied to a Read buffer
	done      bool
	sourceEOF bool
	err       error
}

// NewBodyReader validates header and returns a streaming body reader.
// Read calls drive the underlying connection only as fast as the caller
// drains payload, which gives natural per-byte backpressure: a stalled
// handler stalls the connection reads instead of buffering the whole body.
func NewBodyReader(r io.Reader, header Header, limits Limits) (*BodyReader, error) {
	dec, err := NewDecoder(header, limits)
	if err != nil {
		return nil, err
	}
	return &BodyReader{dec: dec, r: r}, nil
}

// Read implements io.Reader. It returns io.EOF exactly once, when the full
// body has been delivered. The first protocol error is sticky; after it is
// returned every later Read fails (matching ErrPoisoned) and the caller
// must not reuse the connection.
func (b *BodyReader) Read(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if len(p) == 0 {
		return 0, nil
	}
	if len(b.out) > 0 {
		n := copy(p, b.out)
		b.out = b.out[n:]
		return n, nil
	}
	if b.done {
		b.err = io.EOF
		return 0, io.EOF
	}

	for {
		// Feed whatever is buffered first. The decoder never consumes
		// beyond the message boundary, so over-read bytes of a pipelined
		// next request remain in pending and surface via Leftover.
		var (
			out  []byte
			used int
			done bool
			err  error
		)
		if len(b.pending) > 0 {
			out, used, done, err = b.dec.Feed(b.pending)
		}
		b.pending = b.pending[used:]
		if len(out) > 0 {
			copied := copy(p, out)
			if copied < len(out) {
				b.out = append(b.out, out[copied:]...)
			}
			b.done = done
			if err != nil {
				b.err = err
			}
			return copied, nil
		}
		if err != nil {
			b.err = err
			return 0, err
		}
		if done {
			b.done = true
			if b.err != nil && !errors.Is(b.err, io.EOF) {
				// The body framed fully from bytes delivered alongside
				// the transport error; the message itself is intact.
				b.err = nil
			}
			if b.err == nil {
				b.err = io.EOF
			}
			return 0, io.EOF
		}

		// The decoder needs more wire bytes. Pull at most the caller's
		// buffer size: a stalled handler therefore stalls the connection,
		// which is the backpressure guarantee.
		if b.sourceEOF {
			b.finish()
			return 0, b.err
		}
		_, rerr := b.fill(len(p))
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				b.sourceEOF = true
				continue
			}
			if len(b.pending) > 0 {
				// Drain the bytes delivered with the error first.
				b.err = rerr
				continue
			}
			b.err = rerr
			return 0, rerr
		}
	}
}

// fill reads up to size bytes from the underlying reader into pending,
// preserving any bytes the decoder retained (such as a dangling CR).
func (b *BodyReader) fill(size int) (int, error) {
	if size <= 0 {
		size = 1
	}
	buf := make([]byte, size)
	n, err := b.r.Read(buf)
	if n > 0 {
		retained := b.pending
		b.pending = make([]byte, 0, len(retained)+n)
		b.pending = append(b.pending, retained...)
		b.pending = append(b.pending, buf[:n]...)
	}
	return n, err
}

// finish is invoked when the underlying reader reports EOF; a body that
// was not fully framed is truncated, which poisons the connection.
func (b *BodyReader) finish() {
	if err := b.dec.Finish(); err != nil && b.err == nil {
		b.err = fmtPoisoned(err)
	}
}

// Close releases the body. Closing before EOF aborts the decoder so that
// neither this body nor the connection can be resumed safely.
func (b *BodyReader) Close() error {
	if !b.done && b.err == nil {
		b.dec.Abort()
		b.err = ErrPoisoned
	}
	return nil
}

// Leftover returns wire bytes already read from the connection but not
// consumed by this body. After a clean EOF these are exactly the bytes of
// the next pipelined request, ready for its head parser.
func (b *BodyReader) Leftover() []byte { return b.pending }

// Consumed returns the exact number of wire bytes belonging to this body
// (its end offset relative to the start of the body stream).
func (b *BodyReader) Consumed() int64 { return b.dec.Consumed() }

// Emitted returns the number of decoded payload bytes delivered so far.
func (b *BodyReader) Emitted() int64 { return b.dec.Emitted() }

// Framing reports the framing selected from the request headers.
func (b *BodyReader) Framing() Framing { return b.dec.Framing() }

// Trailers returns the parsed trailing section (empty until EOF).
func (b *BodyReader) Trailers() Header { return b.dec.Trailers() }

// Err returns the first protocol or transport error; nil means the
// connection is still reusable.
func (b *BodyReader) Err() error { return b.err }

// Poisoned reports whether the connection must be closed.
func (b *BodyReader) Poisoned() bool {
	return b.err != nil && !errors.Is(b.err, io.EOF)
}

// Decoder exposes the underlying push parser for handlers that drive the
// connection manually instead of through Read.
func (b *BodyReader) Decoder() *Decoder { return b.dec }
