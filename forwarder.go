// Package forward streams a request body to multiple destinations in
// leased chunks. It enforces a byte budget (stopping publication and
// closing upstream the moment the budget is exceeded), distinguishes
// upstream read failures from limit hits, supports cancellation and empty
// chunks, and records exactly one terminal state per call.
package forward

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

const (
	defaultChunkSize  = 32 << 10
	defaultQueueDepth = 8
)

// Config tunes a Forwarder.
type Config struct {
	// MaxBytes is the byte budget; non-positive means unlimited. The
	// chunk that pushes the total past the budget is never published.
	MaxBytes int64
	// ChunkSize is the read buffer size when Pool is nil.
	ChunkSize int
	// QueueDepth is the per-destination chunk queue depth.
	QueueDepth int
	// Pool optionally supplies chunk buffers; its buffer size becomes
	// the chunk size. When nil a pool of ChunkSize buffers is created.
	Pool *Pool
}

// Stats accounts for bytes and chunks read from upstream.
type Stats struct {
	BytesRead  int64
	ChunksRead int64
}

// DestStats accounts for one destination's delivered bytes and chunks.
type DestStats struct {
	Name          string
	BytesWritten  int64
	ChunksWritten int64
	Err           error
}

// Result is the single terminal outcome of a Forward call.
type Result struct {
	State State
	Err   error
	Stats Stats
	Dests []DestStats
}

// Forwarder forwards request bodies according to its Config.
type Forwarder struct{ cfg Config }

// New returns a Forwarder with defaults filled in.
func New(cfg Config) *Forwarder {
	if cfg.Pool == nil {
		if cfg.ChunkSize <= 0 {
			cfg.ChunkSize = defaultChunkSize
		}
		cfg.Pool = NewPool(cfg.ChunkSize, 0)
	}
	if cfg.QueueDepth <= 0 {
		cfg.QueueDepth = defaultQueueDepth
	}
	return &Forwarder{cfg: cfg}
}

// outcome records the unique terminal result: the first trySet wins and
// no racing cancel or response can overwrite it.
type outcome struct {
	once sync.Once
	sets atomic.Int32
	res  Result
}

func (o *outcome) trySet(r Result) {
	o.once.Do(func() {
		o.sets.Add(1)
		o.res = r
	})
}

// pump drains one destination's queue, releasing every chunk it dequeues.
type pump struct {
	name  string
	sink  Sink
	queue chan *Chunk
	stats DestStats
}

func (p *pump) run(ctx context.Context, wg *sync.WaitGroup, termErr *error) {
	defer wg.Done()
	var writeErr error
	for c := range p.queue {
		if writeErr == nil {
			if err := p.sink.WriteChunk(ctx, c.Data); err != nil {
				writeErr = err
			} else {
				p.stats.BytesWritten += int64(len(c.Data))
				p.stats.ChunksWritten++
			}
		}
		c.Release()
	}
	// *termErr was assigned before the queue was closed, and the closed
	// channel synchronizes with this drain, so the read below is safe.
	p.stats.Err = writeErr
	if err := p.sink.Close(*termErr); p.stats.Err == nil {
		p.stats.Err = err
	}
}

// closeOnceSource makes Close idempotent so the cancel watcher and the
// main flow can both close upstream exactly once in effect.
type closeOnceSource struct {
	src  Source
	once sync.Once
}

func (s *closeOnceSource) ReadChunk(buf []byte) (int, error) { return s.src.ReadChunk(buf) }

func (s *closeOnceSource) Close() error {
	s.once.Do(func() { _ = s.src.Close() })
	return nil
}

// Forward streams src to every sink and returns the unique terminal
// result. On limit excess or read failure it stops publishing and closes
// upstream immediately, then waits for all in-flight destination writes
// to close before returning. A prefix already sent is never reported as
// a fully delivered request.
func (f *Forwarder) Forward(ctx context.Context, src Source, sinks ...Sink) Result {
	pool := f.cfg.Pool
	src = &closeOnceSource{src: src}

	var o outcome
	var wg sync.WaitGroup
	var termErr error

	pumps := make([]*pump, len(sinks))
	for i, sink := range sinks {
		name := fmt.Sprintf("dest[%d]", i)
		if n, ok := sink.(Namer); ok {
			name = n.Name()
		}
		pumps[i] = &pump{name: name, sink: sink, queue: make(chan *Chunk, f.cfg.QueueDepth)}
		pumps[i].stats.Name = name
		wg.Add(1)
		go pumps[i].run(ctx, &wg, &termErr)
	}

	// Cancellation closes upstream to unblock a pending ReadChunk.
	stop := context.AfterFunc(ctx, func() { _ = src.Close() })
	defer stop()

	var stats Stats
	state := StateDelivered
	var ferr error

loop:
	for {
		if err := ctx.Err(); err != nil {
			state, ferr = StateCanceled, err
			break
		}
		c := newChunk(pool)
		n, err := src.ReadChunk(c.buf)
		c.Data = c.buf[:n]
		stats.BytesRead += int64(n)

		switch {
		case err != nil && !errors.Is(err, io.EOF):
			c.Release()
			if cerr := ctx.Err(); cerr != nil {
				state, ferr = StateCanceled, cerr
			} else {
				state, ferr = StateReadFailed, &ReadError{Err: err}
			}
			break loop
		case f.cfg.MaxBytes > 0 && stats.BytesRead > f.cfg.MaxBytes:
			// Budget exceeded: the overflowing chunk is dropped, nothing
			// more is published, upstream is closed below.
			c.Release()
			state, ferr = StateLimitExceeded, ErrLimitExceeded
			break loop
		}

		isChunk := err == nil || n > 0 // err is nil or io.EOF here
		if isChunk {
			stats.ChunksRead++
			if !publish(ctx, pumps, c) {
				c.Release()
				state, ferr = StateCanceled, ctx.Err()
				break loop
			}
		}
		c.Release()
		if errors.Is(err, io.EOF) {
			break
		}
	}

	// Close upstream, stop publishing, and wait for every in-flight
	// destination write to drain and close before terminating.
	_ = src.Close()
	termErr = ferr
	for _, p := range pumps {
		close(p.queue)
	}
	wg.Wait()

	res := Result{State: state, Err: ferr, Stats: stats}
	var firstDestErr error
	var firstDestName string
	for _, p := range pumps {
		res.Dests = append(res.Dests, p.stats)
		if p.stats.Err != nil && firstDestErr == nil {
			firstDestErr = p.stats.Err
			firstDestName = p.stats.Name
		}
	}
	if state == StateDelivered && firstDestErr != nil {
		if cerr := ctx.Err(); cerr != nil {
			res.State, res.Err = StateCanceled, cerr
		} else {
			res.State = StateWriteFailed
			res.Err = fmt.Errorf("forward: destination %s: %w", firstDestName, firstDestErr)
		}
	}

	o.trySet(res)
	return o.res
}

// publish hands one lease per destination to the queues. It returns false
// if cancellation interrupted the handoff.
func publish(ctx context.Context, pumps []*pump, c *Chunk) bool {
	for _, p := range pumps {
		c.Retain()
		select {
		case p.queue <- c:
		case <-ctx.Done():
			c.Release()
			return false
		}
	}
	return true
}
