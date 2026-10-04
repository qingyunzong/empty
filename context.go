// Package ctxlib implements a hierarchical cancellation context tree.
//
// Semantics:
//   - A child inherits its parent's effective deadline and may only tighten it.
//   - Cancelling a parent propagates to all descendants exactly once.
//   - Cancelling a child never affects its siblings or ancestors.
//   - A callback registered with AfterFunc is executed exactly once unless
//     its stop function removes it before cancellation; registration racing
//     with cancellation never loses the callback.
package ctxlib

import (
	"errors"
	"sync"
	"time"
)

var (
	// Canceled is the error reported when a context is explicitly cancelled.
	Canceled = errors.New("context canceled")
	// DeadlineExceeded is the error reported when a context's deadline passes.
	DeadlineExceeded = errors.New("context deadline exceeded")
)

// Context is a node in the cancellation tree.
type Context interface {
	// Deadline reports the effective deadline: the earliest deadline on the
	// path from this node up to the root.
	Deadline() (deadline time.Time, ok bool)
	// Done returns a channel closed when the context is cancelled or its
	// effective deadline passes. The background context returns nil.
	Done() <-chan struct{}
	// Err reports why the context ended, or nil while it is still live.
	Err() error
	// AfterFunc registers f to run once this context is done. The returned
	// stop function removes f and reports whether it was removed in time;
	// if stop returns false, f is guaranteed to run (exactly once).
	AfterFunc(f func()) (stop func() bool)
}

// CancelFunc cancels a context and releases its resources. It is idempotent.
type CancelFunc func()

type node struct {
	parent *node
	clock  Clock

	mu       sync.Mutex
	children map[*node]struct{}
	done     chan struct{}
	err      error
	canceled bool

	deadline    time.Time // own deadline, if any
	hasDeadline bool
	effDeadline time.Time // earliest deadline on the path to the root
	hasEff      bool
	timer       Timer

	callbacks map[int]func()
	nextID    int
}

var background = &node{
	children:  make(map[*node]struct{}),
	callbacks: make(map[int]func()),
}

// Background returns the root context: never cancelled, no deadline.
func Background() Context { return background }

func toNode(c Context) *node {
	n, ok := c.(*node)
	if !ok || n == nil {
		panic("ctxlib: parent was not created by this package")
	}
	return n
}

func newNode(parent *node, clk Clock) *node {
	n := &node{
		parent:    parent,
		clock:     clk,
		done:      make(chan struct{}),
		children:  make(map[*node]struct{}),
		callbacks: make(map[int]func()),
	}
	n.effDeadline, n.hasEff = parent.effDeadline, parent.hasEff
	return n
}

// adopt registers n as a child of its parent, or cancels n immediately if
// the parent is already done. Returns false if n was cancelled at birth.
func (n *node) adopt() bool {
	p := n.parent
	p.mu.Lock()
	if p.canceled {
		p.mu.Unlock()
		n.cancel(Canceled)
		return false
	}
	p.children[n] = struct{}{}
	p.mu.Unlock()
	return true
}

// WithCancel returns a child of parent that can be cancelled explicitly.
func WithCancel(parent Context) (Context, CancelFunc) {
	p := toNode(parent)
	n := newNode(p, p.clock)
	n.adopt()
	return n, func() { n.cancel(Canceled) }
}

// WithDeadline returns a child of parent whose effective deadline is the
// earlier of d and the parent's effective deadline. A nil clock uses the
// real wall clock.
func WithDeadline(parent Context, d time.Time, clk Clock) (Context, CancelFunc) {
	p := toNode(parent)
	if clk == nil {
		clk = RealClock{}
	}
	n := newNode(p, clk)
	n.deadline, n.hasDeadline = d, true
	n.effDeadline, n.hasEff = d, true
	if p.hasEff && !d.Before(p.effDeadline) {
		n.effDeadline = p.effDeadline
	}
	if !n.adopt() {
		return n, func() { n.cancel(Canceled) }
	}
	// Only the node that tightens the deadline needs a timer; an inherited
	// earlier deadline is already armed on an ancestor and reaches this node
	// through propagation.
	if !p.hasEff || d.Before(p.effDeadline) {
		n.mu.Lock()
		if !n.canceled {
			n.timer = clk.AfterFunc(d.Sub(clk.Now()), func() { n.cancel(DeadlineExceeded) })
		}
		n.mu.Unlock()
	}
	return n, func() { n.cancel(Canceled) }
}

// WithTimeout is WithDeadline relative to the clock's current time.
func WithTimeout(parent Context, d time.Duration, clk Clock) (Context, CancelFunc) {
	if clk == nil {
		clk = RealClock{}
	}
	return WithDeadline(parent, clk.Now().Add(d), clk)
}

func (n *node) cancel(err error) {
	n.mu.Lock()
	if n.canceled {
		n.mu.Unlock()
		return
	}
	n.canceled = true
	n.err = err
	close(n.done)
	callbacks := n.callbacks
	n.callbacks = nil
	children := make([]*node, 0, len(n.children))
	for c := range n.children {
		children = append(children, c)
	}
	n.children = nil
	timer := n.timer
	n.timer = nil
	n.mu.Unlock()

	if timer != nil {
		timer.Stop()
	}
	for _, f := range callbacks {
		f()
	}
	for _, c := range children {
		c.cancel(err)
	}
	// Release the upward edge so a cancelled subtree can be collected even
	// while the parent lives on.
	p := n.parent
	p.mu.Lock()
	delete(p.children, n)
	p.mu.Unlock()
}

func (n *node) Deadline() (time.Time, bool) {
	return n.effDeadline, n.hasEff
}

func (n *node) Done() <-chan struct{} {
	return n.done
}

func (n *node) Err() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.err
}

func (n *node) AfterFunc(f func()) (stop func() bool) {
	n.mu.Lock()
	if n.canceled {
		n.mu.Unlock()
		f()
		return func() bool { return false }
	}
	id := n.nextID
	n.nextID++
	n.callbacks[id] = f
	n.mu.Unlock()
	return func() bool {
		n.mu.Lock()
		defer n.mu.Unlock()
		if _, ok := n.callbacks[id]; ok {
			delete(n.callbacks, id)
			return true
		}
		return false
	}
}
