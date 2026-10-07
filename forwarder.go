package forward

import (
	"context"
	"io"
	"sync"
)

// Source is the upstream request body, read one block at a time. ReadChunk
// must return io.EOF to signal a clean end of body; a zero-length block with
// a nil error is a valid empty chunk, not EOF.
type Source interface {
	ReadChunk() ([]byte, error)
	// Close shuts the upstream down. The forwarder calls it exactly once,
	// immediately when a transfer stops early (limit, read error, cancel)
	// and after the final block otherwise.
	Close() error
}

// Sink is one forwarding destination. Write takes ownership of one lease on
// the chunk and must call Release exactly once when the block is no longer
// needed; until then the underlying block is not recycled. Close delivers the
// unique terminal state and is called exactly once per Forward.
type Sink interface {
	Write(c *Chunk) error
	Close(err error)
}

// Result is the unique terminal state of a Forward call.
type Result struct {
	Outcome Outcome
	// BytesRead counts every byte returned by the source, including the
	// block that tripped the limit.
	BytesRead int64
	// BytesPublished counts bytes of blocks handed to every sink. It never
	// exceeds the configured budget.
	BytesPublished int64
	// Err is nil only for Delivered. It is ErrLimitExceeded for
	// LimitExceeded, a *ReadFailure for ReadFailed, and ctx.Err() for
	// Canceled.
	Err error
}

// Forwarder copies a chunked request body from one source to many sinks.
type Forwarder struct {
	// MaxBytes is the body budget. A negative value means unlimited.
	MaxBytes int64
	// Pool supplies the blocks shared by all sinks. Nil uses a fresh pool
	// per Forward call.
	Pool *Pool
}

// Forward reads the body block by block and fans each block out to every
// sink. The moment the body grows past MaxBytes it stops publishing, closes
// the upstream, waits for all in-flight writes to finish, and only then
// terminates the sinks and returns. A partially sent prefix is never
// reported as Delivered. Cancellation and the main response race for the
// terminal state; whichever lands first wins and is never overwritten.
func (f *Forwarder) Forward(ctx context.Context, src Source, sinks ...Sink) Result {
	pool := f.Pool
	if pool == nil {
		pool = NewPool()
	}

	queues := make([]chan *Chunk, len(sinks))
	var inflight sync.WaitGroup
	var failOnce sync.Once
	var sinkErr *SinkFailure
	sinkFailed := make(chan struct{})
	for i := range sinks {
		queues[i] = make(chan *Chunk)
		inflight.Add(1)
		go func(i int) {
			defer inflight.Done()
			failed := false
			for c := range queues[i] {
				if failed {
					// The sink is done; drop the block and release the
					// lease on its behalf.
					c.Release()
					continue
				}
				if err := sinks[i].Write(c); err != nil {
					failed = true
					failOnce.Do(func() {
						sinkErr = &SinkFailure{Sink: i, Err: err}
						close(sinkFailed)
					})
				}
			}
		}(i)
	}

	var res Result
	var closeOnce sync.Once
	closeSource := func() { closeOnce.Do(func() { src.Close() }) }

	finish := func() Result {
		for _, q := range queues {
			close(q)
		}
		// Wait for every in-flight write to close before terminating.
		inflight.Wait()
		for _, s := range sinks {
			s.Close(res.Err)
		}
		closeSource()
		return res
	}

	for {
		var data []byte
		var err error
		readDone := make(chan struct{})
		go func() {
			data, err = src.ReadChunk()
			close(readDone)
		}()
		select {
		case <-readDone:
		case <-ctx.Done():
			closeSource() // unblock a stuck read
			<-readDone
			res.Outcome, res.Err = Canceled, ctx.Err()
			return finish()
		case <-sinkFailed:
			closeSource()
			<-readDone
			sinkErr.Off = res.BytesPublished
			res.Outcome, res.Err = WriteFailed, sinkErr
			return finish()
		}

		if err == io.EOF {
			// Main response wins: a late cancel must not overwrite a
			// delivered body.
			res.Outcome = Delivered
			return finish()
		}
		if err != nil {
			res.Outcome, res.Err = ReadFailed, &ReadFailure{Off: res.BytesRead, Err: err}
			return finish()
		}

		res.BytesRead += int64(len(data))
		if f.MaxBytes >= 0 && res.BytesRead > f.MaxBytes {
			// Over budget: stop publishing at once and shut the upstream.
			res.Outcome, res.Err = LimitExceeded, ErrLimitExceeded
			return finish()
		}

		block := pool.Get(len(data))
		copy(block.Data, data)
		for _, q := range queues {
			leased := block.Lease()
			select {
			case q <- leased:
			case <-ctx.Done():
				leased.Release()
				block.Release()
				res.Outcome, res.Err = Canceled, ctx.Err()
				return finish()
			case <-sinkFailed:
				leased.Release()
				block.Release()
				sinkErr.Off = res.BytesPublished
				res.Outcome, res.Err = WriteFailed, sinkErr
				return finish()
			}
		}
		block.Release()
		res.BytesPublished += int64(len(data))
	}
}
