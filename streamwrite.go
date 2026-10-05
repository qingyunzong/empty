// Package streamwrite provides a concurrency-safe streaming writer.
//
// StreamWriter wraps an io.Writer and guarantees:
//   - Write reports exactly how many leading bytes of p were durably
//     accepted; a caller retrying with p[n:] never duplicates the
//     already-accepted prefix.
//   - Write and Close may be called concurrently; the stream reaches
//     exactly one terminal state. A Write racing Close either persists
//     its bytes in full or fails with ErrClosed.
//   - BytesPersisted always reflects the exact number of bytes handed
//     to and accepted by the underlying writer.
package streamwrite

import (
	"errors"
	"io"
	"sync"
)

var (
	// ErrClosed is returned by Write and Close after the stream has
	// reached its terminal closed state.
	ErrClosed = errors.New("streamwrite: stream is closed")

	// ErrNoProgress is returned when the underlying writer accepts zero
	// bytes without reporting an error, so callers can retry instead of
	// spinning forever.
	ErrNoProgress = errors.New("streamwrite: underlying writer made no progress")

	// errInvalidWrite is returned when the underlying writer violates the
	// io.Writer contract by returning an out-of-range byte count.
	errInvalidWrite = errors.New("streamwrite: invalid write count from underlying writer")
)

// StreamWriter is a concurrency-safe streaming writer with an accurate
// persisted-byte count.
type StreamWriter struct {
	mu        sync.Mutex
	w         io.Writer
	closed    bool
	persisted int64
}

// New returns a StreamWriter writing to w.
func New(w io.Writer) *StreamWriter {
	return &StreamWriter{w: w}
}

// Write persists a prefix of p and returns the number of bytes accepted.
//
// Write loops over the underlying writer until p is fully consumed, the
// underlying writer reports an error, or it makes zero progress. The
// returned n is always the exact count of durably accepted leading bytes,
// so a caller may safely retry with p[n:] without duplicating data.
//
// A concurrent Close either runs entirely before Write (Write fails with
// ErrClosed and persists nothing) or entirely after it (Write completes
// its current pass first); the two never interleave.
func (s *StreamWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return 0, ErrClosed
	}

	total := 0
	for total < len(p) {
		n, err := s.w.Write(p[total:])
		switch {
		case n < 0 || n > len(p)-total:
			return total, errInvalidWrite
		case n > 0:
			total += n
			s.persisted += int64(n)
		}
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, ErrNoProgress
		}
	}
	return total, nil
}

// Close moves the stream to its single terminal state. The first Close
// wins: it closes the underlying writer if it implements io.Closer and
// returns that error. Any later Close, and any Write that loses the race,
// fails with ErrClosed.
func (s *StreamWriter) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return ErrClosed
	}
	s.closed = true
	if c, ok := s.w.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// BytesPersisted returns the exact number of bytes accepted by the
// underlying writer so far.
func (s *StreamWriter) BytesPersisted() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persisted
}
