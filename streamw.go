// Package streamw provides a concurrency-safe streaming writer whose Write
// may accept only a prefix of the input before returning an error. Callers
// retry the remaining bytes p[n:] without duplicating the accepted prefix.
package streamw

import (
	"errors"
	"io"
	"sync"
)

// ErrClosed is returned by Write after the writer has been closed, and by
// Close when the writer was already closed.
var ErrClosed = errors.New("streamw: writer is closed")

// errInvalidWrite is returned when the underlying writer reports an
// impossible byte count (negative or larger than the input).
var errInvalidWrite = errors.New("streamw: invalid write count")

// Writer wraps an io.Writer with serialized access, an exactly-once
// terminal Close state, and an accurate count of persisted bytes.
type Writer struct {
	mu     sync.Mutex
	w      io.Writer
	closed bool
	n      int64 // bytes accepted by the underlying writer
}

// New returns a Writer persisting to w.
func New(w io.Writer) *Writer {
	return &Writer{w: w}
}

// Write persists a prefix of p and reports how many bytes were accepted.
// On error, exactly the first n bytes of p were persisted; the caller must
// retry only p[n:]. A nil error guarantees n == len(p); a short count with a
// nil error from the underlying writer is surfaced as io.ErrShortWrite.
// Write on a closed writer persists nothing and returns ErrClosed.
func (s *Writer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, ErrClosed
	}
	n, err := s.w.Write(p)
	if n < 0 || n > len(p) {
		return 0, errInvalidWrite
	}
	s.n += int64(n)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	return n, err
}

// Close transitions the writer to its single terminal state and closes the
// underlying writer if it implements io.Closer. Only the first Close takes
// effect; later calls return ErrClosed.
func (s *Writer) Close() error {
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

// Persisted reports the exact number of bytes accepted by the underlying
// writer so far.
func (s *Writer) Persisted() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n
}

// WriteAll retries Write until all of p is persisted, returning the number
// of bytes written and the last error encountered. ErrClosed is terminal
// and stops the loop immediately; any other error is retried, but the loop
// gives up after maxZeroProgress consecutive calls that accept zero bytes,
// so a stalled underlying writer cannot spin the retry loop forever.
func WriteAll(s *Writer, p []byte, maxZeroProgress int) (int, error) {
	total := 0
	zero := 0
	for total < len(p) {
		n, err := s.Write(p[total:])
		total += n
		if errors.Is(err, ErrClosed) {
			return total, err
		}
		if n == 0 {
			zero++
			if zero >= maxZeroProgress {
				if err == nil {
					err = io.ErrNoProgress
				}
				return total, err
			}
		} else {
			zero = 0
		}
	}
	return total, nil
}
