// Package aggregator collects items into batches sealed by capacity or
// by a virtual timeout, sends them in sequence order, and reports the
// earliest sequence failure even when sends complete out of order.
package aggregator

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrClosed is returned by Add after the Aggregator has been closed.
var ErrClosed = errors.New("aggregator: closed")

// Batch is a sealed, immutable group of items. Seq numbers are assigned
// contiguously starting from 0 in sealing order.
type Batch struct {
	Seq   int
	Items []any
}

// Sender delivers a sealed batch. Sends for different batches may run
// concurrently and complete out of order.
type Sender func(ctx context.Context, b Batch) error

// Options configures an Aggregator.
type Options struct {
	// Capacity seals the open batch once it holds this many items.
	// Values <= 0 disable the capacity limit.
	Capacity int

	// Timeout seals the open batch once the virtual clock has advanced
	// this far past the batch's opening time. Values <= 0 disable it.
	Timeout time.Duration

	// Clock drives Timeout. It must be non-nil when Timeout > 0.
	Clock *VirtualClock

	// Sender delivers sealed batches. A nil Sender discards batches
	// and reports success.
	Sender Sender
}

// Aggregator collects items into sealed batches and sends them.
type Aggregator struct {
	capacity int
	timeout  time.Duration
	clock    *VirtualClock
	sender   Sender

	mu      sync.Mutex
	items   []any // items of the currently open batch
	opened  time.Time
	timer   *Timer // timeout timer of the open batch, nil if disabled
	nextSeq int
	closed  bool

	results  map[int]error // completed send results by sequence
	changed  chan struct{} // closed and replaced on every send completion
	finalErr error         // settled drain result, valid once drained
	drained  bool
}

// New returns an Aggregator configured by opts.
func New(opts Options) *Aggregator {
	sender := opts.Sender
	if sender == nil {
		sender = func(context.Context, Batch) error { return nil }
	}
	return &Aggregator{
		capacity: opts.Capacity,
		timeout:  opts.Timeout,
		clock:    opts.Clock,
		sender:   sender,
		results:  make(map[int]error),
		changed:  make(chan struct{}),
	}
}

// Add appends item to the open batch, sealing it first if the virtual
// timeout has already elapsed, and sealing it afterwards if the capacity
// is reached. It returns ErrClosed once the Aggregator is closed.
func (a *Aggregator) Add(item any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return ErrClosed
	}
	a.expireLocked()
	if len(a.items) == 0 {
		a.openLocked()
	}
	a.items = append(a.items, item)
	if a.capacity > 0 && len(a.items) >= a.capacity {
		a.sealLocked()
	}
	return nil
}

// Flush seals the open batch and waits until every batch sealed so far
// has completed its send. If several sends failed, Flush returns the
// error of the batch with the smallest sequence number, regardless of
// completion order. If ctx is cancelled while waiting, Flush returns
// ctx.Err(); the in-flight batches are not cancelled and a later Flush
// observes their results.
func (a *Aggregator) Flush(ctx context.Context) error {
	a.mu.Lock()
	if a.closed {
		drained, err := a.drained, a.finalErr
		a.mu.Unlock()
		if drained {
			return err
		}
		return ErrClosed
	}
	a.sealLocked()
	high := a.nextSeq
	a.mu.Unlock()
	return a.wait(ctx, high)
}

// Close seals the open batch, stops accepting items, and waits for all
// sends to complete, returning the earliest sequence failure if any.
// Cancelling ctx aborts the wait but not the batches; a later Close or
// Flush call reports the settled result.
func (a *Aggregator) Close(ctx context.Context) error {
	a.mu.Lock()
	if !a.closed {
		a.closed = true
		a.sealLocked()
	}
	high := a.nextSeq
	drained := a.drained
	a.mu.Unlock()
	if drained {
		return a.finalErr
	}
	err := a.wait(ctx, high)
	if ctx.Err() == nil {
		a.mu.Lock()
		a.drained = true
		a.finalErr = err
		a.mu.Unlock()
	}
	return err
}

// openLocked starts a new open batch and arms its timeout timer.
func (a *Aggregator) openLocked() {
	a.opened = time.Time{}
	if a.clock != nil {
		a.opened = a.clock.Now()
	}
	if a.timeout > 0 && a.clock != nil {
		a.timer = a.clock.AfterFunc(a.timeout, a.expire)
	}
}

// expireLocked seals the open batch if its virtual timeout has elapsed.
func (a *Aggregator) expireLocked() {
	if a.timer == nil || len(a.items) == 0 {
		return
	}
	if !a.clock.Now().Before(a.opened.Add(a.timeout)) {
		a.sealLocked()
	}
}

// expire is the timer callback for the open batch.
func (a *Aggregator) expire() {
	a.mu.Lock()
	a.expireLocked()
	a.mu.Unlock()
}

// sealLocked seals the open batch, if any, and launches its send. The
// items slice is copied so the sealed batch can never change.
func (a *Aggregator) sealLocked() {
	if a.timer != nil {
		a.timer.Stop()
		a.timer = nil
	}
	if len(a.items) == 0 {
		return
	}
	items := make([]any, len(a.items))
	copy(items, a.items)
	b := Batch{Seq: a.nextSeq, Items: items}
	a.nextSeq++
	a.items = nil
	go a.send(b)
}

// send delivers one batch and records its result.
func (a *Aggregator) send(b Batch) {
	err := a.sender(context.Background(), b)
	a.mu.Lock()
	a.results[b.Seq] = err
	close(a.changed)
	a.changed = make(chan struct{})
	a.mu.Unlock()
}

// wait blocks until every batch with sequence < high has completed,
// then returns the failure with the smallest sequence number.
func (a *Aggregator) wait(ctx context.Context, high int) error {
	a.mu.Lock()
	for !a.completedThroughLocked(high) {
		ch := a.changed
		a.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		}
		a.mu.Lock()
	}
	defer a.mu.Unlock()
	for seq := 0; seq < high; seq++ {
		if err := a.results[seq]; err != nil {
			return err
		}
	}
	return nil
}

// completedThroughLocked reports whether all sequences below high have
// completed their sends.
func (a *Aggregator) completedThroughLocked(high int) bool {
	for seq := 0; seq < high; seq++ {
		if _, ok := a.results[seq]; !ok {
			return false
		}
	}
	return true
}
