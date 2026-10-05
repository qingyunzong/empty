// Package aggregator batches items by capacity or (virtual) timeout.
// Once sealed, a batch is immutable. Batches are dispatched to a Sender
// in the background and may complete out of order; Flush, Barrier and
// Close wait for earlier batches and report the lowest failed sequence.
package aggregator

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrClosed is returned by Add after Close has been called.
var ErrClosed = errors.New("aggregator: closed")

// SendFunc delivers a sealed batch. It runs in the background with its own
// context, so cancelling a waiter's context never cancels an in-flight send.
type SendFunc[T any] func(ctx context.Context, b Batch[T]) error

// Batch is a sealed, immutable group of items.
type Batch[T any] struct {
	seq   uint64
	items []T
}

// Seq returns the 1-based sequence number assigned at seal time.
func (b Batch[T]) Seq() uint64 { return b.seq }

// Len returns the number of items in the batch.
func (b Batch[T]) Len() int { return len(b.items) }

// Items returns a copy of the batch contents; the batch itself never changes.
func (b Batch[T]) Items() []T {
	out := make([]T, len(b.items))
	copy(out, b.items)
	return out
}

// SendError reports a failed batch send. Seq is the lowest failed sequence
// number observed by the waiter that received this error.
type SendError struct {
	Seq uint64
	Err error
}

func (e *SendError) Error() string {
	return fmt.Sprintf("aggregator: send batch %d: %v", e.Seq, e.Err)
}

func (e *SendError) Unwrap() error { return e.Err }

// Report describes how items were split into batches and which sequence
// numbers have been acknowledged (successfully sent) at barrier time.
type Report struct {
	Batches int   // batches sealed up to the barrier point
	Sizes   []int // item count per batch, indexed by sequence order
	AckLo   uint64
	AckHi   uint64 // contiguous acknowledged range [AckLo, AckHi]; zero when nothing acked
}

// Aggregator collects items into sealed batches.
type Aggregator[T any] struct {
	capacity int
	timeout  time.Duration
	clock    Clock
	sender   SendFunc[T]

	mu        sync.Mutex
	cur       []T // open (unsealed) items
	curGen    uint64
	curTimer  Timer
	curCancel chan struct{}

	lastSeq   uint64
	sizes     []int
	pending   map[uint64]struct{} // sealed but not yet completed
	failed    map[uint64]error
	succeeded map[uint64]bool // succeeded with seq > ackedUpTo
	ackedUpTo uint64

	changed chan struct{} // closed and replaced on every completion
	closed  bool
	wg      sync.WaitGroup
}

// New creates an Aggregator. A batch seals when it reaches capacity items
// or, if timeout > 0, when timeout elapses (on clk) after the first item of
// the batch was added. Nil clk uses RealClock; nil sender drops batches
// successfully.
func New[T any](capacity int, timeout time.Duration, clk Clock, sender SendFunc[T]) (*Aggregator[T], error) {
	if capacity < 1 {
		return nil, errors.New("aggregator: capacity must be >= 1")
	}
	if timeout < 0 {
		return nil, errors.New("aggregator: timeout must be >= 0")
	}
	if clk == nil {
		clk = RealClock{}
	}
	if sender == nil {
		sender = func(context.Context, Batch[T]) error { return nil }
	}
	return &Aggregator[T]{
		capacity:  capacity,
		timeout:   timeout,
		clock:     clk,
		sender:    sender,
		pending:   make(map[uint64]struct{}),
		failed:    make(map[uint64]error),
		succeeded: make(map[uint64]bool),
		changed:   make(chan struct{}),
	}, nil
}

// Add appends an item to the open batch, sealing it once it reaches capacity.
func (a *Aggregator[T]) Add(item T) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return ErrClosed
	}
	if len(a.cur) == 0 {
		a.openLocked()
	}
	a.cur = append(a.cur, item)
	if len(a.cur) >= a.capacity {
		a.sealLocked()
	}
	return nil
}

// Flush seals the open batch and blocks until every batch sealed so far has
// completed. Cancelling ctx only unblocks the wait; batches keep sending.
func (a *Aggregator[T]) Flush(ctx context.Context) error {
	a.mu.Lock()
	if len(a.cur) > 0 {
		a.sealLocked()
	}
	maxSeq := a.lastSeq
	a.mu.Unlock()
	return a.waitThrough(ctx, maxSeq)
}

// Barrier behaves like Flush and additionally verifies the result: the
// returned Report describes the batch split and the contiguous acknowledged
// range. It returns an error when that range does not cover every batch
// sealed up to the barrier point.
func (a *Aggregator[T]) Barrier(ctx context.Context) (Report, error) {
	a.mu.Lock()
	if len(a.cur) > 0 {
		a.sealLocked()
	}
	maxSeq := a.lastSeq
	a.mu.Unlock()

	err := a.waitThrough(ctx, maxSeq)

	a.mu.Lock()
	rep := Report{
		Batches: int(maxSeq),
		Sizes:   append([]int(nil), a.sizes...),
	}
	if a.ackedUpTo > 0 {
		rep.AckLo = 1
		rep.AckHi = a.ackedUpTo
	}
	a.mu.Unlock()

	if err != nil {
		return rep, err
	}
	if rep.AckHi < maxSeq {
		return rep, fmt.Errorf("aggregator: ack range [%d, %d] does not cover %d batches",
			rep.AckLo, rep.AckHi, maxSeq)
	}
	return rep, nil
}

// Close seals the open batch, stops accepting items and drains: it blocks
// until every batch has completed. It is idempotent.
func (a *Aggregator[T]) Close(ctx context.Context) error {
	a.mu.Lock()
	if !a.closed {
		a.closed = true
		if len(a.cur) > 0 {
			a.sealLocked()
		}
	}
	maxSeq := a.lastSeq
	a.mu.Unlock()

	err := a.waitThrough(ctx, maxSeq)
	if err == nil {
		a.wg.Wait()
	}
	return err
}

// openLocked starts a new open batch and arms its timeout. Caller holds mu.
func (a *Aggregator[T]) openLocked() {
	a.curGen++
	if a.timeout <= 0 {
		return
	}
	gen := a.curGen
	timer := a.clock.NewTimer(a.timeout)
	cancel := make(chan struct{})
	a.curTimer = timer
	a.curCancel = cancel
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		select {
		case <-timer.C():
			a.mu.Lock()
			if a.curGen == gen && len(a.cur) > 0 {
				a.sealLocked()
			}
			a.mu.Unlock()
		case <-cancel:
		}
	}()
}

// sealLocked seals the open batch and dispatches it to the sender.
// Caller holds mu and len(a.cur) > 0.
func (a *Aggregator[T]) sealLocked() {
	if a.curTimer != nil {
		a.curTimer.Stop()
		close(a.curCancel)
		a.curTimer = nil
		a.curCancel = nil
	}
	a.lastSeq++
	seq := a.lastSeq
	items := a.cur
	a.cur = nil
	a.sizes = append(a.sizes, len(items))
	a.pending[seq] = struct{}{}

	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		err := a.sender(context.Background(), Batch[T]{seq: seq, items: items})
		a.mu.Lock()
		delete(a.pending, seq)
		if err != nil {
			a.failed[seq] = err
		} else {
			a.succeeded[seq] = true
			for a.succeeded[a.ackedUpTo+1] {
				a.ackedUpTo++
				delete(a.succeeded, a.ackedUpTo)
			}
		}
		a.broadcastLocked()
		a.mu.Unlock()
	}()
}

// waitThrough blocks until every batch with seq <= maxSeq has completed,
// then returns the lowest-sequence failure among them, if any.
func (a *Aggregator[T]) waitThrough(ctx context.Context, maxSeq uint64) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		a.mu.Lock()
		done := a.completedThroughLocked(maxSeq)
		var err error
		if done {
			err = a.firstFailureLocked(maxSeq)
		}
		ch := a.changed
		a.mu.Unlock()
		if done {
			return err
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (a *Aggregator[T]) completedThroughLocked(maxSeq uint64) bool {
	for seq := range a.pending {
		if seq <= maxSeq {
			return false
		}
	}
	return true
}

func (a *Aggregator[T]) firstFailureLocked(maxSeq uint64) error {
	var minSeq uint64
	var minErr error
	for seq, err := range a.failed {
		if seq <= maxSeq && (minErr == nil || seq < minSeq) {
			minSeq, minErr = seq, err
		}
	}
	if minErr != nil {
		return &SendError{Seq: minSeq, Err: minErr}
	}
	return nil
}

func (a *Aggregator[T]) broadcastLocked() {
	close(a.changed)
	a.changed = make(chan struct{})
}
