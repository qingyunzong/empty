// Package streamfanout forwards a byte stream to a primary destination and
// optional mirror destinations.
//
// Semantics:
//   - The primary is written synchronously inside Write, so primary
//     backpressure propagates directly to the caller and is never absorbed
//     by mirror buffering.
//   - Mirrors are written asynchronously, each through its own bounded
//     buffer of at most BufferSize bytes.
//   - A primary failure cancels everything: pending mirror data is dropped,
//     mirror workers exit, and subsequent Write calls fail.
//   - A mirror failure (write error or buffer overflow) is recorded and
//     that mirror is dropped; it never blocks or fails the primary.
package streamfanout

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

// ErrClosed is returned by Write after the MultiWriter has been closed.
var ErrClosed = errors.New("streamfanout: write on closed MultiWriter")

// ErrMirrorOverflow is recorded for a mirror whose bounded buffer would
// exceed BufferSize. The mirror is dropped; the primary is unaffected.
var ErrMirrorOverflow = errors.New("streamfanout: mirror buffer overflow")

// DestinationError describes a failure on one destination.
type DestinationError struct {
	// Destination is "primary" or "mirror[i]".
	Destination string
	Err         error
}

func (e DestinationError) Error() string {
	return fmt.Sprintf("%s: %v", e.Destination, e.Err)
}

func (e DestinationError) Unwrap() error { return e.Err }

// MultiWriter fans a byte stream out to one primary and zero or more
// mirrors. It is safe for concurrent use.
type MultiWriter struct {
	ctx    context.Context
	cancel context.CancelFunc

	primary     io.Writer
	primaryName string

	wmu        sync.Mutex // serializes Write
	wmuPrimary error      // sticky primary write error

	mu        sync.Mutex
	errs      []DestinationError
	closed    bool
	closeErr  error
	closeOnce sync.Once

	mirrors []*mirror
	wg      sync.WaitGroup
}

// New returns a MultiWriter writing to primary and mirroring to mirrors.
// bufferSize caps the bytes buffered per mirror; it must be positive when
// mirrors are present. A single Write larger than bufferSize always
// overflows the mirror's buffer.
func New(primary io.Writer, bufferSize int, mirrors ...io.Writer) *MultiWriter {
	if primary == nil {
		panic("streamfanout: nil primary")
	}
	if len(mirrors) > 0 && bufferSize <= 0 {
		panic("streamfanout: bufferSize must be positive with mirrors")
	}
	ctx, cancel := context.WithCancel(context.Background())
	mw := &MultiWriter{
		ctx:         ctx,
		cancel:      cancel,
		primary:     primary,
		primaryName: "primary",
	}
	for i, w := range mirrors {
		m := &mirror{
			name: fmt.Sprintf("mirror[%d]", i),
			w:    w,
			cap:  bufferSize,
			wake: make(chan struct{}, 1),
			onError: func(name string) func(error) {
				return func(err error) { mw.recordError(name, err) }
			}(fmt.Sprintf("mirror[%d]", i)),
		}
		mw.mirrors = append(mw.mirrors, m)
		mw.wg.Add(1)
		go func() {
			defer mw.wg.Done()
			m.run(ctx)
		}()
	}
	return mw
}

// Write writes p to the primary synchronously, then enqueues p to every
// live mirror. A primary error is returned to the caller and cancels all
// mirrors. Mirror problems never affect the result of Write.
func (mw *MultiWriter) Write(p []byte) (int, error) {
	mw.wmu.Lock()
	defer mw.wmu.Unlock()

	mw.mu.Lock()
	closed := mw.closed
	mw.mu.Unlock()
	if closed {
		return 0, ErrClosed
	}
	if err := mw.wmuPrimary; err != nil {
		return 0, err
	}

	n, err := mw.primary.Write(p)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	if err != nil {
		mw.wmuPrimary = err
		mw.recordError(mw.primaryName, err)
		mw.cancel()
		return n, err
	}

	for _, m := range mw.mirrors {
		m.enqueue(p)
	}
	return n, nil
}

// Close stops accepting writes, drains any buffered mirror data, and closes
// every destination that implements io.Closer exactly once. It is idempotent
// and safe to call concurrently. A primary close error is returned; mirror
// close errors are recorded and available from Errors.
func (mw *MultiWriter) Close() error {
	mw.closeOnce.Do(func() {
		mw.mu.Lock()
		mw.closed = true
		mw.mu.Unlock()

		for _, m := range mw.mirrors {
			m.close()
		}
		mw.wg.Wait()

		if c, ok := mw.primary.(io.Closer); ok {
			if err := c.Close(); err != nil {
				mw.closeErr = err
				mw.recordError(mw.primaryName, err)
			}
		}
		for _, m := range mw.mirrors {
			if c, ok := m.w.(io.Closer); ok {
				if err := c.Close(); err != nil {
					mw.recordError(m.name, err)
				}
			}
		}
		mw.cancel()
	})
	return mw.closeErr
}

// Errors enumerates every recorded destination failure, in the order they
// occurred. It includes primary failures, mirror write failures, mirror
// buffer overflows, and destination close failures.
func (mw *MultiWriter) Errors() []DestinationError {
	mw.mu.Lock()
	defer mw.mu.Unlock()
	out := make([]DestinationError, len(mw.errs))
	copy(out, mw.errs)
	return out
}

// Done is closed when the MultiWriter is torn down, either because the
// primary failed or because Close completed. Cancellation drops all
// pending mirror data.
func (mw *MultiWriter) Done() <-chan struct{} { return mw.ctx.Done() }

func (mw *MultiWriter) recordError(dest string, err error) {
	mw.mu.Lock()
	mw.errs = append(mw.errs, DestinationError{Destination: dest, Err: err})
	mw.mu.Unlock()
}

// mirror is one asynchronous destination with a bounded byte buffer.
type mirror struct {
	name string
	w    io.Writer
	cap  int

	mu      sync.Mutex
	queue   [][]byte
	queued  int
	failed  bool
	closing bool

	wake    chan struct{}
	onError func(error)
}

// enqueue buffers p for asynchronous delivery. It never blocks. If the
// buffer would exceed cap bytes, the mirror fails with ErrMirrorOverflow.
func (m *mirror) enqueue(p []byte) {
	m.mu.Lock()
	if m.failed || m.closing {
		m.mu.Unlock()
		return
	}
	if m.queued+len(p) > m.cap {
		m.failed = true
		m.queue = nil
		m.queued = 0
		m.mu.Unlock()
		m.onError(ErrMirrorOverflow)
		return
	}
	cp := make([]byte, len(p))
	copy(cp, p)
	m.queue = append(m.queue, cp)
	m.queued += len(cp)
	m.mu.Unlock()

	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// close asks the worker to drain the remaining buffer and exit.
func (m *mirror) close() {
	m.mu.Lock()
	m.closing = true
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// fail records err once and drops any buffered data.
func (m *mirror) fail(err error) {
	m.mu.Lock()
	if m.failed {
		m.mu.Unlock()
		return
	}
	m.failed = true
	m.queue = nil
	m.queued = 0
	m.mu.Unlock()
	m.onError(err)
}

func (m *mirror) run(ctx context.Context) {
	for {
		m.mu.Lock()
		if len(m.queue) == 0 {
			if m.closing || ctx.Err() != nil {
				m.mu.Unlock()
				return
			}
			m.mu.Unlock()
			select {
			case <-ctx.Done():
				return // cancelled: drop pending data
			case <-m.wake:
			}
			continue
		}
		chunk := m.queue[0]
		m.queue = m.queue[1:]
		m.queued -= len(chunk)
		m.mu.Unlock()

		if _, err := m.w.Write(chunk); err != nil {
			m.fail(err)
			return
		}
	}
}
