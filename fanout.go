// Package fanout tees a byte stream to one primary destination and any
// number of optional mirror destinations.
//
// Semantics:
//   - The primary is written synchronously, so its backpressure propagates
//     directly to the caller of Write. Mirrors never absorb or delay it.
//   - Each mirror is fed by a pump goroutine through a bounded buffer of at
//     most N bytes (WithBufferSize). If a mirror falls behind and its buffer
//     would overflow, the mirror is cut off: it keeps whatever prefix it
//     already received and the overflow is recorded as a MirrorError.
//   - A mirror that fails (saturates or returns a write error) is recorded
//     via MirrorErrors but never affects the primary.
//   - A primary write failure cancels everything: all pumps stop, pending
//     mirror data is dropped, and subsequent Write calls return the error.
//   - Mirrors always observe a byte-prefix of the stream: ordered, gapless,
//     and truncated only at the tail.
//   - Close is idempotent and flushes buffered mirror data before returning.
package fanout

import (
	"context"
	"errors"
	"io"
	"sync"
)

// ErrClosed is returned by Write after the Writer has been closed.
var ErrClosed = errors.New("fanout: write on closed writer")

// ErrSaturated records that a mirror was cut off because its bounded buffer
// filled up; the mirror keeps the prefix it already received.
var ErrSaturated = errors.New("fanout: mirror buffer saturated")

// DefaultBufferSize is the per-destination buffer cap used when
// WithBufferSize is not supplied.
const DefaultBufferSize = 64 * 1024

// MirrorError describes a mirror-side failure. It never implies a primary
// failure.
type MirrorError struct {
	Name string
	Err  error
	// Dropped is the number of stream bytes the mirror did not receive.
	Dropped int64
}

// Option configures a Writer.
type Option func(*Writer)

// WithBufferSize sets the per-destination buffer cap in bytes (N). Each
// mirror (and the primary's implicit hand-off) never buffers more than this.
func WithBufferSize(n int) Option {
	return func(w *Writer) {
		if n > 0 {
			w.bufSize = n
		}
	}
}

// WithContext binds the Writer to ctx: cancellation stops all pumps and
// makes Write fail with the context error.
func WithContext(ctx context.Context) Option {
	return func(w *Writer) {
		if ctx != nil {
			w.ctx, w.cancel = context.WithCancel(ctx)
		}
	}
}

// WithMirror adds a mirror destination with a name used in MirrorErrors.
func WithMirror(name string, dst io.Writer) Option {
	return func(w *Writer) {
		w.mirrorSpecs = append(w.mirrorSpecs, mirrorSpec{name: name, dst: dst})
	}
}

type mirrorSpec struct {
	name string
	dst  io.Writer
}

// Writer multiplexes a byte stream to a primary and optional mirrors.
type Writer struct {
	ctx    context.Context
	cancel context.CancelFunc

	primary io.Writer
	bufSize int

	mirrorSpecs []mirrorSpec
	mirrors     []*mirror

	// wmu serializes whole Write calls so the primary and the mirror
	// queues observe the same chunk order (preserving the prefix
	// property) even with concurrent callers.
	wmu     sync.Mutex
	mu      sync.Mutex
	closed  bool
	primErr error
}

// New creates a Writer around primary and starts the mirror pumps.
func New(primary io.Writer, opts ...Option) *Writer {
	w := &Writer{
		primary: primary,
		bufSize: DefaultBufferSize,
	}
	w.ctx, w.cancel = context.WithCancel(context.Background())
	for _, opt := range opts {
		opt(w)
	}
	for _, spec := range w.mirrorSpecs {
		m := &mirror{
			name:   spec.name,
			dst:    spec.dst,
			cap:    w.bufSize,
			signal: make(chan struct{}, 1),
			done:   make(chan struct{}),
		}
		w.mirrors = append(w.mirrors, m)
		go m.pump(w.ctx)
	}
	return w
}

// Write appends p to the stream. It writes the primary synchronously and
// then offers the chunk to each mirror's bounded buffer without blocking.
func (w *Writer) Write(p []byte) (int, error) {
	w.wmu.Lock()
	defer w.wmu.Unlock()

	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return 0, ErrClosed
	}
	if w.primErr != nil {
		err := w.primErr
		w.mu.Unlock()
		return 0, err
	}
	w.mu.Unlock()

	if err := w.ctx.Err(); err != nil {
		return 0, err
	}

	n, err := writeFull(w.primary, p)
	if err != nil {
		w.fail(err)
		return n, err
	}
	for _, m := range w.mirrors {
		m.enqueue(p)
	}
	return n, nil
}

// fail records the terminal primary error and cancels all mirror pumps.
func (w *Writer) fail(err error) {
	w.mu.Lock()
	if w.primErr == nil {
		w.primErr = err
	}
	w.mu.Unlock()
	w.cancel()
}

// Err returns the terminal primary error, or the context error if the
// Writer's context was cancelled. Mirror failures are not reported here;
// use MirrorErrors.
func (w *Writer) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.primErr != nil || w.closed {
		return w.primErr
	}
	return w.ctx.Err()
}

// Context returns a context that is cancelled when the Writer terminates:
// on primary failure, on Close, or when the context passed to WithContext
// ends. Destinations that block inside Write should select on it.
func (w *Writer) Context() context.Context {
	return w.ctx
}

// MirrorErrors enumerates the mirrors that failed or were cut off, in the
// order the mirrors were added.
func (w *Writer) MirrorErrors() []MirrorError {
	var out []MirrorError
	for _, m := range w.mirrors {
		m.mu.Lock()
		if m.err != nil {
			out = append(out, MirrorError{Name: m.name, Err: m.err, Dropped: m.dropped})
		}
		m.mu.Unlock()
	}
	return out
}

// Close stops accepting writes, flushes each mirror's buffered bytes, waits
// for the pumps to exit, and returns the terminal primary error, if any.
// It is safe to call multiple times; only the first call shuts anything down.
func (w *Writer) Close() error {
	w.mu.Lock()
	if w.closed {
		err := w.primErr
		w.mu.Unlock()
		return err
	}
	w.closed = true
	w.mu.Unlock()

	for _, m := range w.mirrors {
		m.stop()
	}
	for _, m := range w.mirrors {
		<-m.done
	}

	w.mu.Lock()
	if w.primErr == nil {
		// Capture an external cancellation before our own cancel below
		// would mask it.
		w.primErr = w.ctx.Err()
	}
	err := w.primErr
	w.mu.Unlock()
	w.cancel()
	return err
}

// mirror is one asynchronous destination with a bounded byte buffer.
type mirror struct {
	name string
	dst  io.Writer
	cap  int

	signal chan struct{}
	done   chan struct{}

	mu        sync.Mutex
	queue     [][]byte
	queued    int
	saturated bool
	failed    bool
	stopping  bool
	err       error
	dropped   int64
}

// enqueue offers a chunk to the mirror. It never blocks. If the buffer cap
// would be exceeded, the mirror is cut off so its received bytes remain a
// prefix of the stream.
func (m *mirror) enqueue(p []byte) {
	m.mu.Lock()
	if m.stopping {
		m.mu.Unlock()
		return
	}
	if m.failed || m.saturated {
		m.dropped += int64(len(p))
		m.mu.Unlock()
		return
	}
	if m.queued+len(p) > m.cap {
		m.saturated = true
		m.err = ErrSaturated
		m.dropped += int64(len(p))
		m.mu.Unlock()
		return
	}
	cp := make([]byte, len(p))
	copy(cp, p)
	m.queue = append(m.queue, cp)
	m.queued += len(cp)
	m.mu.Unlock()

	select {
	case m.signal <- struct{}{}:
	default:
	}
}

// stop asks the pump to drain what it has and exit.
func (m *mirror) stop() {
	m.mu.Lock()
	m.stopping = true
	m.mu.Unlock()
	select {
	case m.signal <- struct{}{}:
	default:
	}
}

func (m *mirror) pump(ctx context.Context) {
	defer close(m.done)
	for {
		m.mu.Lock()
		if len(m.queue) == 0 {
			if m.stopping || m.failed {
				m.mu.Unlock()
				return
			}
			m.mu.Unlock()
			select {
			case <-m.signal:
				continue
			case <-ctx.Done():
				return
			}
		}
		chunk := m.queue[0]
		m.queue = m.queue[1:]
		m.queued -= len(chunk)
		m.mu.Unlock()

		if _, err := writeFull(m.dst, chunk); err != nil {
			m.mu.Lock()
			m.failed = true
			m.err = err
			m.dropped += int64(m.queued)
			m.queue = nil
			m.queued = 0
			m.mu.Unlock()
			return
		}
	}
}

// writeFull writes all of p, looping over short writes.
func writeFull(w io.Writer, p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n, err := w.Write(p)
		total += n
		p = p[n:]
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}
