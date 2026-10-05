// Package groupflush lets many callers share a single fsync.
//
// A Flusher serializes appends to an underlying File and confirms each
// caller only after the batch carrying its bytes has been synced. Batches
// are sealed before any of their bytes are written, so a submit that
// arrives after the seal can never be confirmed by an earlier batch's
// fsync.
package groupflush

import (
	"context"
	"errors"
	"io"
	"sync"
)

// File is the minimal durable sink a Flusher needs. *os.File satisfies it.
type File interface {
	io.Writer
	Sync() error
}

// ErrClosed is returned by Submit after Close has been called.
var ErrClosed = errors.New("groupflush: flusher closed")

type request struct {
	data []byte
	done chan error // buffered with capacity 1
}

type batch struct {
	reqs []*request
}

// Flusher groups concurrent submits into batches and persists each batch
// with a single Sync call.
//
// Failure semantics: a failing flush confirms its own batch (plus any
// earlier still-unconfirmed batches, which the serialized flush loop
// rules out by construction) with the error. Later batches are
// unaffected and may be retried by their callers.
type Flusher struct {
	f File

	mu      sync.Mutex
	cur     batch
	running bool
	closed  bool
	wg      sync.WaitGroup
}

// New returns a Flusher writing to f.
func New(f File) *Flusher { return &Flusher{f: f} }

// Submit appends p to the file and blocks until the batch containing p
// has been synced to durable storage or the flush fails.
//
// If ctx is cancelled while waiting, Submit returns ctx.Err(). The bytes
// are still written and synced with the rest of the batch, and other
// callers sharing the batch are unaffected: cancellation is independent
// per caller.
func (f *Flusher) Submit(ctx context.Context, p []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	req := &request{data: p, done: make(chan error, 1)}

	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return ErrClosed
	}
	f.cur.reqs = append(f.cur.reqs, req)
	if !f.running {
		f.running = true
		f.wg.Add(1)
		go f.run()
	}
	f.mu.Unlock()

	select {
	case err := <-req.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close stops accepting new submits and blocks until every accepted
// request has been flushed and confirmed.
func (f *Flusher) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	f.wg.Wait()
	return nil
}

// run is the serialized flush loop. At most one instance runs at a time,
// so batches are written and synced in seal order.
func (f *Flusher) run() {
	defer f.wg.Done()
	for {
		f.mu.Lock()
		if len(f.cur.reqs) == 0 {
			f.running = false
			f.mu.Unlock()
			return
		}
		// Seal the batch before writing a single byte of it: anything
		// submitted from now on lands in the next batch and must wait
		// for a later Sync.
		b := f.cur
		f.cur = batch{}
		f.mu.Unlock()

		err := f.flush(b)
		for _, req := range b.reqs {
			// done is buffered, so this never blocks even if the
			// caller's context was cancelled and it stopped waiting.
			req.done <- err
		}
		// A failure does not stop the loop: the next batch is a fresh
		// attempt and may succeed.
	}
}

func (f *Flusher) flush(b batch) error {
	for _, req := range b.reqs {
		if err := writeAll(f.f, req.data); err != nil {
			return err
		}
	}
	return f.f.Sync()
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}
