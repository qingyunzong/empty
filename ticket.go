package taskpool

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrCanceled is returned by Claim when the ticket was canceled
	// before its result could be claimed.
	ErrCanceled = errors.New("taskpool: ticket canceled")
	// ErrClaimed is returned by Claim when the result was already
	// claimed by another caller.
	ErrClaimed = errors.New("taskpool: result already claimed")
)

// State is the lifecycle state of a Ticket.
type State int

const (
	// Pending: a slot was acquired but the task has not started yet.
	Pending State = iota
	// Running: the task function is executing.
	Running
	// Done: the task finished and its result waits to be claimed.
	Done
	// Claimed: the result was claimed. Terminal state.
	Claimed
	// Canceled: the ticket was canceled. Terminal state.
	Canceled
)

func (s State) String() string {
	switch s {
	case Pending:
		return "Pending"
	case Running:
		return "Running"
	case Done:
		return "Done"
	case Claimed:
		return "Claimed"
	case Canceled:
		return "Canceled"
	}
	return "Unknown"
}

// A Ticket tracks one submitted task. The transitions Cancel, start and
// Claim race against each other, but a ticket always lands in exactly one
// terminal state: Claimed or Canceled.
type Ticket struct {
	mu     sync.Mutex
	state  State
	result any
	err    error
	doneCh chan struct{}
	cancel context.CancelFunc
}

// Cancel resolves the ticket toward the Canceled terminal state:
//   - Pending: the ticket is canceled and the task never runs.
//   - Running: only a signal is sent through the task's context; the task
//     runs to completion and its result remains claimable.
//   - Done: the unclaimed result is discarded.
//
// It returns false once the result has been claimed or the ticket was
// already canceled.
func (t *Ticket) Cancel() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.state {
	case Pending:
		t.state = Canceled
		close(t.doneCh)
		return true
	case Running:
		t.cancel() // signal only; the task decides how to react
		return true
	case Done:
		t.state = Canceled
		t.result, t.err = nil, nil
		return true
	default: // Claimed or Canceled
		return false
	}
}

// Claim blocks until the task finishes or the ticket is canceled, then
// takes ownership of the result. Exactly one caller can claim the result;
// later callers receive ErrClaimed, and callers on a canceled ticket
// receive ErrCanceled.
func (t *Ticket) Claim() (any, error) {
	<-t.doneCh
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.state {
	case Done:
		t.state = Claimed
		return t.result, t.err
	case Canceled:
		return nil, ErrCanceled
	default:
		return nil, ErrClaimed
	}
}

// Done returns a channel closed when the task finished or the ticket was
// canceled before finishing.
func (t *Ticket) Done() <-chan struct{} { return t.doneCh }

// State reports the current lifecycle state.
func (t *Ticket) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

// start marks the ticket running unless it was already canceled.
func (t *Ticket) start(cancel context.CancelFunc) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state == Canceled {
		return false
	}
	t.cancel = cancel
	t.state = Running
	return true
}

// finish stores the task result and wakes waiters.
func (t *Ticket) finish(result any, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.result, t.err = result, err
	t.state = Done
	close(t.doneCh)
}
