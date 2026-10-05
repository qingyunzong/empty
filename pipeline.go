// Package pipeline provides a dynamic task-graph executor.
//
// Tasks submitted to a Pipeline may derive downstream tasks while they run.
// Closing the entry stops new top-level submissions, and Wait blocks until
// every accepted task and all of its successors have finished. Completion is
// decided by a reference count of accepted-but-unfinished tasks, never by
// observing a momentarily empty queue. Once any task fails, the pipeline
// stops deriving new work, cancels the shared context, and Wait reports the
// first error.
package pipeline

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrClosed is returned when submitting an entry task after Close.
	ErrClosed = errors.New("pipeline: entry closed")
	// ErrCancelled is returned when deriving work after a task failure.
	ErrCancelled = errors.New("pipeline: cancelled after a task failure")
)

// Task is a unit of work. It may derive downstream tasks via Scope.Spawn.
// A task must return for its completion to be recorded.
type Task func(ctx context.Context, s *Scope) error

// Scope lets a running task derive downstream tasks.
type Scope struct {
	p *Pipeline
}

// Spawn derives a downstream task that belongs to the same pipeline. It
// fails with ErrCancelled once any task has failed: a failure stops further
// derivation. Spawn may be called after Close, because closing only seals
// the entry, not the successors of accepted tasks.
func (s *Scope) Spawn(t Task) error { return s.p.spawn(t, false) }

// Stats counts lifecycle events. Conservation invariant: every accepted
// task is eventually recorded exactly once, so after Wait returns
// Submitted == Completed + Failed.
type Stats struct {
	Submitted int
	Completed int
	Failed    int
}

// Pipeline executes a dynamically growing set of tasks.
type Pipeline struct {
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	cond     *sync.Cond
	inflight int // accepted tasks that have not finished yet
	closed   bool
	failed   bool
	firstErr error
	stats    Stats
}

// New returns an empty, open pipeline.
func New() *Pipeline {
	ctx, cancel := context.WithCancel(context.Background())
	p := &Pipeline{ctx: ctx, cancel: cancel}
	p.cond = sync.NewCond(&p.mu)
	return p
}

// Context returns the pipeline context, cancelled on the first task failure
// and when Wait returns.
func (p *Pipeline) Context() context.Context { return p.ctx }

// Submit adds an entry task. It fails with ErrClosed after Close and with
// ErrCancelled after any task failure.
func (p *Pipeline) Submit(t Task) error { return p.spawn(t, true) }

// spawn accepts a task and starts it. The acceptance check and the inflight
// increment happen atomically under the mutex, so a task derived while the
// previous last task is finishing is still tracked: inflight can only reach
// zero when no accepted task remains able to derive successors.
func (p *Pipeline) spawn(t Task, entry bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failed {
		return ErrCancelled
	}
	if entry && p.closed {
		return ErrClosed
	}
	if p.closed && p.inflight == 0 {
		// The pipeline is fully drained; a stray Spawn from a task that
		// already returned must not resurrect it.
		return ErrClosed
	}
	p.inflight++
	p.stats.Submitted++
	go p.run(t)
	return nil
}

func (p *Pipeline) run(t Task) {
	err := t(p.ctx, &Scope{p: p})
	p.mu.Lock()
	if err != nil {
		p.stats.Failed++
		if !p.failed {
			p.failed = true
			p.firstErr = err
		}
	} else {
		p.stats.Completed++
	}
	p.inflight--
	p.cond.Broadcast()
	p.mu.Unlock()
	if err != nil {
		p.cancel()
	}
}

// Close seals the entry: Submit starts failing with ErrClosed. Tasks already
// accepted keep running and may still derive successors. Close does not
// block; use Wait (or Shutdown) to wait for the drain.
func (p *Pipeline) Close() {
	p.mu.Lock()
	p.closed = true
	p.cond.Broadcast()
	p.mu.Unlock()
}

// Wait blocks until the entry is closed and every accepted task, including
// all derived successors, has finished. It returns the first task error, if
// any. Completion is decided by the inflight count reaching zero, not by
// sampling a queue. Wait requires Close to have been called.
func (p *Pipeline) Wait() error {
	p.mu.Lock()
	for !p.closed || p.inflight != 0 {
		p.cond.Wait()
	}
	err := p.firstErr
	p.mu.Unlock()
	p.cancel()
	return err
}

// Shutdown closes the entry and waits for all accepted tasks and their
// successors to finish, returning the first task error, if any.
func (p *Pipeline) Shutdown() error {
	p.Close()
	return p.Wait()
}

// Stats returns a snapshot of the lifecycle counters.
func (p *Pipeline) Stats() Stats {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stats
}
