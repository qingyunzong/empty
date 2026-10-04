// Package chansim simulates Go-like channels: buffered send/receive,
// select with deterministic smallest-index priority, and close semantics.
//
// The whole simulation is serialized on one package-level lock, so every
// commit (send, receive, or select branch) is atomic. A select commits at
// most one branch; its registrations on the remaining branches are fully
// revoked, so a losing send branch can never leak a "ghost" value.
package chansim

import "sync"

var mu sync.Mutex
var cond = sync.NewCond(&mu)

// Chan is a simulated channel carrying values of type any.
// The zero value is not usable; use New.
type Chan struct {
	buf     []any // buffered values (capacity cap)
	cap     int
	closed  bool
	nwait   int   // receivers currently blocked on this channel
	pending []any // values committed by cap-0 sends, awaiting a receiver
}

// New returns a channel with the given buffer capacity.
// A capacity of 0 yields a rendezvous channel: a send commits only while
// a receiver is blocked waiting.
func New(capacity int) *Chan {
	if capacity < 0 {
		panic("chansim: negative capacity")
	}
	return &Chan{cap: capacity}
}

// Cap returns the buffer capacity.
func (c *Chan) Cap() int { return c.cap }

// Len returns the number of values currently held by the channel
// (buffered plus committed rendezvous sends awaiting a receiver).
func (c *Chan) Len() int {
	mu.Lock()
	defer mu.Unlock()
	return len(c.buf) + len(c.pending)
}

// Closed reports whether Close has been called.
func (c *Chan) Closed() bool {
	mu.Lock()
	defer mu.Unlock()
	return c.closed
}

func (c *Chan) sendReadyLocked() bool {
	return !c.closed && (len(c.buf) < c.cap || (c.cap == 0 && c.nwait > 0))
}

func (c *Chan) recvReadyLocked() bool {
	return len(c.buf) > 0 || len(c.pending) > 0 || c.closed
}

// commitSendLocked appends v. Caller must hold mu and have checked
// sendReadyLocked.
func (c *Chan) commitSendLocked(v any) {
	if len(c.buf) < c.cap {
		c.buf = append(c.buf, v)
	} else {
		c.pending = append(c.pending, v)
	}
}

// commitRecvLocked removes and returns the oldest value. On a closed,
// drained channel it returns (nil, false). Caller must hold mu and have
// checked recvReadyLocked.
func (c *Chan) commitRecvLocked() (any, bool) {
	if len(c.buf) > 0 {
		v := c.buf[0]
		c.buf = c.buf[1:]
		return v, true
	}
	if len(c.pending) > 0 {
		v := c.pending[0]
		c.pending = c.pending[1:]
		return v, true
	}
	return nil, false
}

// Send blocks until v is committed to the channel. It returns false if
// the channel is or becomes closed before the send can commit; a send on
// a closed channel always fails and never panics.
func (c *Chan) Send(v any) bool {
	mu.Lock()
	defer mu.Unlock()
	for !c.sendReadyLocked() {
		if c.closed {
			return false
		}
		cond.Wait()
	}
	c.commitSendLocked(v)
	cond.Broadcast()
	return true
}

// Recv blocks until a value is available or the channel is closed and
// drained. It returns (nil, false) once a closed channel is empty.
func (c *Chan) Recv() (any, bool) {
	mu.Lock()
	defer mu.Unlock()
	for !c.recvReadyLocked() {
		// Register as a blocked receiver so rendezvous (cap-0) sends
		// can commit, and revoke the registration on wakeup.
		c.nwait++
		cond.Wait()
		c.nwait--
	}
	v, ok := c.commitRecvLocked()
	cond.Broadcast()
	return v, ok
}

// TrySend commits v only if the send is immediately possible.
func (c *Chan) TrySend(v any) bool {
	mu.Lock()
	defer mu.Unlock()
	if !c.sendReadyLocked() {
		return false
	}
	c.commitSendLocked(v)
	cond.Broadcast()
	return true
}

// TryRecv commits a receive only if one is immediately possible
// (buffered value available, or channel closed). It reports (nil, false)
// both for "would block" and for a receive from a closed, drained
// channel; use RecvReady to distinguish.
func (c *Chan) TryRecv() (any, bool) {
	mu.Lock()
	defer mu.Unlock()
	if !c.recvReadyLocked() {
		return nil, false
	}
	v, ok := c.commitRecvLocked()
	cond.Broadcast()
	return v, ok
}

// SendReady reports whether a send would commit right now.
func (c *Chan) SendReady() bool {
	mu.Lock()
	defer mu.Unlock()
	return c.sendReadyLocked()
}

// RecvReady reports whether a receive would commit right now.
func (c *Chan) RecvReady() bool {
	mu.Lock()
	defer mu.Unlock()
	return c.recvReadyLocked()
}

// Close marks the channel closed and wakes every blocked operation.
// Receives drain the remaining buffer and then observe (nil, false);
// pending and future sends fail. Close is idempotent.
func (c *Chan) Close() {
	mu.Lock()
	defer mu.Unlock()
	if !c.closed {
		c.closed = true
		cond.Broadcast()
	}
}

// Case is one branch of a Select: either a receive on Ch, or a send of
// Val on Ch. Build cases with RecvCase or SendCase.
type Case struct {
	ch   *Chan
	send bool
	val  any
}

// RecvCase is a select branch that receives from ch.
func RecvCase(ch *Chan) Case { return Case{ch: ch} }

// SendCase is a select branch that sends v on ch.
func SendCase(ch *Chan, v any) Case { return Case{ch: ch, send: true, val: v} }

// firstReadyLocked returns the smallest index of a ready branch.
func firstReadyLocked(cases []Case) (int, bool) {
	for i, cs := range cases {
		if cs.send {
			if cs.ch.sendReadyLocked() {
				return i, true
			}
		} else if cs.ch.recvReadyLocked() {
			return i, true
		}
	}
	return -1, false
}

// commitCaseLocked commits exactly branch i. Caller must hold mu and the
// branch must be ready.
func commitCaseLocked(cases []Case, i int) (val any, ok bool) {
	cs := cases[i]
	if cs.send {
		cs.ch.commitSendLocked(cs.val)
		return nil, true
	}
	return cs.ch.commitRecvLocked()
}

// Select blocks until some branch is ready, then commits exactly one
// branch: the ready branch with the smallest index. All registrations on
// the other branches are revoked before Select returns, so no losing
// branch can commit later.
//
// For a chosen receive branch it returns the received value and whether
// the channel was open; for a chosen send branch it returns (nil, true).
// A send branch on a closed channel is never ready, so it is never
// chosen. With no cases, Select blocks forever.
func Select(cases ...Case) (idx int, val any, ok bool) {
	mu.Lock()
	defer mu.Unlock()
	for {
		if i, ready := firstReadyLocked(cases); ready {
			val, ok = commitCaseLocked(cases, i)
			cond.Broadcast()
			return i, val, ok
		}
		// Register as a blocked receiver on every receive branch so
		// rendezvous (cap-0) sends can commit against us, then wait.
		for _, cs := range cases {
			if !cs.send {
				cs.ch.nwait++
			}
		}
		cond.Wait()
		// Fully revoke every registration before re-checking readiness.
		for _, cs := range cases {
			if !cs.send {
				cs.ch.nwait--
			}
		}
	}
}

// SelectNow is the non-blocking form of Select: it commits the
// smallest-index ready branch, or returns idx == -1 if none is ready.
func SelectNow(cases ...Case) (idx int, val any, ok bool) {
	mu.Lock()
	defer mu.Unlock()
	i, ready := firstReadyLocked(cases)
	if !ready {
		return -1, nil, false
	}
	val, ok = commitCaseLocked(cases, i)
	cond.Broadcast()
	return i, val, ok
}
