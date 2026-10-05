package taskpool

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrClosed is returned by Submit once the pool has been closed.
	ErrClosed = errors.New("taskpool: pool closed")
	// ErrCancelled is returned by Result on a ticket cancelled before start.
	ErrCancelled = errors.New("taskpool: ticket cancelled")
	// ErrAlreadyClaimed is returned by Result when the result was already claimed.
	ErrAlreadyClaimed = errors.New("taskpool: result already claimed")
)

// State is the lifecycle state of a Ticket.
type State int

const (
	// Pending: submitted, not yet picked up by a worker.
	Pending State = iota
	// Running: executing the task.
	Running
	// Done: task finished, result ready to be claimed.
	Done
	// Cancelled: terminal; cancelled before it started.
	Cancelled
	// Claimed: terminal; result claimed exactly once.
	Claimed
)

func (s State) String() string {
	switch s {
	case Pending:
		return "Pending"
	case Running:
		return "Running"
	case Done:
		return "Done"
	case Cancelled:
		return "Cancelled"
	case Claimed:
		return "Claimed"
	}
	return "Unknown"
}

// Terminal reports whether s is one of the two terminal states: a ticket
// is either cancelled before running or claimed after finishing, never both.
func (s State) Terminal() bool { return s == Cancelled || s == Claimed }

// Ticket tracks one submitted task through its lifecycle.
type Ticket struct {
	mu     sync.Mutex
	state  State
	result any
	err    error
	cancel context.CancelFunc
	doneCh chan struct{} // closed on Cancelled or Done
}

// State returns the ticket's current state.
func (t *Ticket) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

// Done returns a channel closed once the ticket leaves Pending/Running.
func (t *Ticket) Done() <-chan struct{} { return t.doneCh }

// Cancel reports whether this call had an effect. On a pending ticket it
// transitions to Cancelled (the task never runs). On a running ticket it
// only signals the task's context. Once the result is claimed, the task
// finished, or the ticket is already cancelled, Cancel fails.
func (t *Ticket) Cancel() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.state {
	case Pending:
		t.state = Cancelled
		close(t.doneCh)
		return true
	case Running:
		t.cancel() // signal only; the task still runs to completion
		return true
	default: // Done, Cancelled, Claimed
		return false
	}
}

// Result waits for the task to finish and claims its result. The first
// successful call wins; later calls fail with ErrAlreadyClaimed. A ticket
// cancelled before start yields ErrCancelled. A ctx timeout does not
// claim the result and the call may be retried.
func (t *Ticket) Result(ctx context.Context) (any, error) {
	select {
	case <-t.doneCh:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.state {
	case Cancelled:
		return nil, ErrCancelled
	case Claimed:
		return nil, ErrAlreadyClaimed
	}
	t.state = Claimed
	return t.result, t.err
}

// Pool is a bounded task pool: at most Capacity tasks hold a slot at once.
type Pool struct {
	slots    chan struct{}
	mu       sync.Mutex
	closed   bool
	closedCh chan struct{}
	ctx      context.Context
	stop     context.CancelFunc
	wg       sync.WaitGroup

	preStart func() // test hook: runs while a ticket is still Pending
}

// New returns a pool admitting at most capacity in-flight tasks.
func New(capacity int) *Pool {
	if capacity <= 0 {
		panic("taskpool: capacity must be positive")
	}
	ctx, stop := context.WithCancel(context.Background())
	return &Pool{
		slots:    make(chan struct{}, capacity),
		closedCh: make(chan struct{}),
		ctx:      ctx,
		stop:     stop,
	}
}

// Capacity returns the maximum number of in-flight tasks.
func (p *Pool) Capacity() int { return cap(p.slots) }

// Submit blocks until a slot is free and returns a ticket for fn. It
// fails with ErrClosed once the pool is closed, or with ctx's error if
// ctx expires while waiting for a slot.
func (p *Pool) Submit(ctx context.Context, fn func(context.Context) (any, error)) (*Ticket, error) {
	select {
	case p.slots <- struct{}{}:
	case <-p.closedCh:
		return nil, ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		<-p.slots
		return nil, ErrClosed
	}
	t := &Ticket{state: Pending, doneCh: make(chan struct{})}
	p.wg.Add(1)
	p.mu.Unlock()
	go p.run(t, fn)
	return t, nil
}

func (p *Pool) run(t *Ticket, fn func(context.Context) (any, error)) {
	defer p.wg.Done()
	defer func() { <-p.slots }() // capacity always returns to the pool
	if p.preStart != nil {
		p.preStart()
	}
	t.mu.Lock()
	if t.state == Cancelled {
		t.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(p.ctx)
	t.cancel = cancel
	t.state = Running
	t.mu.Unlock()

	result, err := fn(ctx)
	cancel()

	t.mu.Lock()
	t.result, t.err = result, err
	t.state = Done
	close(t.doneCh)
	t.mu.Unlock()
}

// Close stops the pool: blocked and future Submit calls fail with
// ErrClosed, running tasks receive a cancellation signal, and Close
// returns once every in-flight task has finished, so all waiters can exit.
func (p *Pool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		p.wg.Wait()
		return
	}
	p.closed = true
	close(p.closedCh)
	p.mu.Unlock()
	p.stop()
	p.wg.Wait()
}
