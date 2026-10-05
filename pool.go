// Package taskpool provides a bounded pool for running tasks whose
// results are claimed through single-terminal-state tickets.
package taskpool

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed is returned by Submit on a closed pool.
var ErrClosed = errors.New("taskpool: pool closed")

// Pool runs tasks with bounded concurrency. The zero value is not usable;
// construct one with New.
type Pool struct {
	slots  chan struct{}
	closed chan struct{}
	once   sync.Once
	wg     sync.WaitGroup

	// Test hooks fired around the start transition of a task.
	beforeStart func()
	afterStart  func()
}

// New returns a pool running at most capacity tasks concurrently.
func New(capacity int) *Pool {
	if capacity <= 0 {
		panic("taskpool: capacity must be positive")
	}
	return &Pool{
		slots:  make(chan struct{}, capacity),
		closed: make(chan struct{}),
	}
}

// Submit blocks until a slot is free, then runs fn asynchronously and
// returns its Ticket. It returns ErrClosed if the pool is or becomes
// closed while waiting.
func (p *Pool) Submit(fn func(ctx context.Context) (any, error)) (*Ticket, error) {
	select {
	case <-p.closed:
		return nil, ErrClosed
	default:
	}
	select {
	case p.slots <- struct{}{}:
	case <-p.closed:
		return nil, ErrClosed
	}
	t := &Ticket{state: Pending, doneCh: make(chan struct{})}
	p.wg.Add(1)
	go p.run(t, fn)
	return t, nil
}

func (p *Pool) run(t *Ticket, fn func(context.Context) (any, error)) {
	defer p.wg.Done()
	defer func() { <-p.slots }() // return capacity on every exit path
	if p.beforeStart != nil {
		p.beforeStart()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !t.start(cancel) {
		return // canceled before start
	}
	if p.afterStart != nil {
		p.afterStart()
	}
	t.finish(fn(ctx))
}

// Close stops new submissions and releases every goroutine blocked in
// Submit with ErrClosed. In-flight tasks keep running.
func (p *Pool) Close() {
	p.once.Do(func() { close(p.closed) })
}

// Wait blocks until all in-flight tasks finish. It must not run
// concurrently with Submit.
func (p *Pool) Wait() { p.wg.Wait() }
