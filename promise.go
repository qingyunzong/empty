// Package proxy implements multi-hop asynchronous request forwarding.
//
// A Proxy forwards a request through a chain of hops. Each hop is opened
// independently and exposes its own cancellation handle (Close). When the
// caller cancels, every hop that has already been opened is closed and the
// proxy waits for all of them to finish, aggregating any close failures.
// Only the complete response of the final hop is treated as success.
package proxy

import "sync"

// State is the settlement state of a controlled Promise.
type State int

const (
	// Pending means the promise has not been settled yet.
	Pending State = iota
	// Fulfilled means the promise settled with a successful result.
	Fulfilled
	// Failed means the promise settled with an error (mid-way failure).
	Failed
	// LateCompleted is returned by Settle when a result arrives after the
	// promise was already settled; the late result is discarded.
	LateCompleted
)

func (s State) String() string {
	switch s {
	case Pending:
		return "Pending"
	case Fulfilled:
		return "Fulfilled"
	case Failed:
		return "Failed"
	case LateCompleted:
		return "LateCompleted"
	default:
		return "Unknown"
	}
}

// Promise is a controlled, settle-once promise. The first settlement wins;
// any result arriving afterwards is reported as LateCompleted and dropped.
type Promise struct {
	mu     sync.Mutex
	state  State
	result Result
	late   int
	done   chan struct{}
}

// NewPromise returns a Promise in the Pending state.
func NewPromise() *Promise {
	return &Promise{state: Pending, done: make(chan struct{})}
}

// Settle attempts to resolve the promise with res. It returns the state of
// this settlement attempt: Fulfilled or Failed for the first settlement, or
// LateCompleted if the promise had already been settled.
func (p *Promise) Settle(res Result) State {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state != Pending {
		p.late++
		return LateCompleted
	}
	if res.Err != nil {
		p.state = Failed
	} else {
		p.state = Fulfilled
	}
	p.result = res
	close(p.done)
	return p.state
}

// Done is closed when the promise settles for the first time.
func (p *Promise) Done() <-chan struct{} { return p.done }

// State returns the current settlement state.
func (p *Promise) State() State {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

// LateCount returns how many results arrived after the first settlement.
func (p *Promise) LateCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.late
}

// Result returns the settled result. It is only meaningful after Done is
// closed.
func (p *Promise) Result() Result {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.result
}
