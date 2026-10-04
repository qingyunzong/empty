package opctx

import (
	"context"
	"sync"
	"time"
)

// Cancellation causes, aliased to the standard library for interoperability.
var (
	Canceled         = context.Canceled
	DeadlineExceeded = context.DeadlineExceeded
)

// Context is an operation context: a node in a cancellation tree.
type Context interface {
	// Deadline reports the effective deadline: the earliest deadline of
	// this node and its ancestors. ok is false when no ancestor set one.
	Deadline() (deadline time.Time, ok bool)
	// Done is closed when the context is canceled. It is nil for
	// Background contexts and is never closed by Release.
	Done() <-chan struct{}
	// Err reports why the context was canceled, or nil while it is live.
	Err() error
	// OnCancel registers fn to be called exactly once if this context is
	// canceled. If the context is already canceled, fn runs synchronously
	// before OnCancel returns, so a registration racing with cancellation
	// is never missed. The returned function deregisters fn; it is
	// idempotent and guarantees fn is never called afterwards.
	OnCancel(fn func()) (deregister func())
}

// CancelFunc cancels its context. It is idempotent: only the first call
// has an effect, so cancellation propagates through the tree exactly once.
type CancelFunc func()

// Background returns the root context backed by the wall clock.
func Background() Context { return BackgroundWithClock(RealClock{}) }

// BackgroundWithClock returns the root context backed by clk.
func BackgroundWithClock(clk Clock) Context {
	return &cancelCtx{clock: clk}
}

// WithCancel returns a child of parent that can be canceled explicitly.
func WithCancel(parent Context) (Context, CancelFunc) {
	p := mustCtx(parent)
	c := newChild(p)
	p.addChild(c)
	return c, CancelFunc(func() { c.cancel(Canceled) })
}

// WithDeadline returns a child of parent whose effective deadline is the
// earlier of d and parent's effective deadline: children inherit the
// parent's deadline and may only tighten it. A dedicated timer is armed
// only when d is strictly earlier than the parent's effective deadline;
// otherwise cancellation (and its cause) propagates from the parent.
func WithDeadline(parent Context, d time.Time) (Context, CancelFunc) {
	p := mustCtx(parent)
	c := newChild(p)
	if pd, ok := p.Deadline(); ok && !pd.After(d) {
		c.deadline, c.hasDeadline = pd, true
	} else {
		c.deadline, c.hasDeadline = d, true
	}
	p.addChild(c)

	if pd, ok := p.Deadline(); ok && !pd.After(d) {
		// Parent's deadline wins; no timer of our own.
	} else if now := p.clock.Now(); !d.After(now) {
		c.cancel(DeadlineExceeded)
	} else {
		t := p.clock.AfterFunc(d, func() { c.cancel(DeadlineExceeded) })
		c.mu.Lock()
		if c.err == nil && !c.released {
			c.timer = t
		} else {
			t.Stop()
		}
		c.mu.Unlock()
	}
	return c, CancelFunc(func() { c.cancel(Canceled) })
}

// WithTimeout is WithDeadline relative to the context's clock.
func WithTimeout(parent Context, d time.Duration) (Context, CancelFunc) {
	p := mustCtx(parent)
	return WithDeadline(p, p.clock.Now().Add(d))
}

// Release frees ctx's resources (its deadline timer and registered
// callbacks) and detaches it from its parent without canceling it.
// Registered callbacks are dropped, never invoked. Children keep their own
// timers and stay attached to ctx. Release reports whether ctx was live.
func Release(ctx Context) bool {
	c, ok := ctx.(*cancelCtx)
	if !ok {
		return false
	}
	return c.release()
}

type cancelCtx struct {
	parent *cancelCtx
	clock  Clock

	mu       sync.Mutex
	done     chan struct{}
	err      error
	released bool

	deadline    time.Time
	hasDeadline bool

	callbacks map[int64]func()
	cbOrder   []int64
	nextID    int64
	children  map[*cancelCtx]struct{}
	timer     Timer
}

func newChild(p *cancelCtx) *cancelCtx {
	c := &cancelCtx{
		parent: p,
		clock:  p.clock,
		done:   make(chan struct{}),
	}
	// Children inherit the parent's effective deadline; WithDeadline may
	// tighten it further.
	c.deadline, c.hasDeadline = p.Deadline()
	return c
}

func mustCtx(c Context) *cancelCtx {
	if cc, ok := c.(*cancelCtx); ok {
		return cc
	}
	panic("opctx: parent Context was not created by opctx")
}

func (c *cancelCtx) Deadline() (time.Time, bool) {
	return c.deadline, c.hasDeadline
}

func (c *cancelCtx) Done() <-chan struct{} { return c.done }

func (c *cancelCtx) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *cancelCtx) OnCancel(fn func()) func() {
	c.mu.Lock()
	if c.err != nil {
		// Already canceled: run inline so the callback is never missed.
		c.mu.Unlock()
		fn()
		return func() {}
	}
	if c.released {
		// A released context never cancels; the callback never runs.
		c.mu.Unlock()
		return func() {}
	}
	id := c.nextID
	c.nextID++
	if c.callbacks == nil {
		c.callbacks = make(map[int64]func())
	}
	c.callbacks[id] = fn
	c.cbOrder = append(c.cbOrder, id)
	c.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			delete(c.callbacks, id)
			c.mu.Unlock()
		})
	}
}

func (c *cancelCtx) addChild(child *cancelCtx) {
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		child.cancel(err)
		return
	}
	if c.children == nil {
		c.children = make(map[*cancelCtx]struct{})
	}
	c.children[child] = struct{}{}
	c.mu.Unlock()
}

func (c *cancelCtx) removeChild(child *cancelCtx) {
	c.mu.Lock()
	delete(c.children, child)
	c.mu.Unlock()
}

// cancel transitions the node to canceled exactly once and propagates the
// same cause to every live child. Siblings are unreachable from here, so a
// child's cancellation can never affect them.
func (c *cancelCtx) cancel(err error) bool {
	c.mu.Lock()
	if c.err != nil || c.released {
		c.mu.Unlock()
		return false
	}
	c.err = err
	if c.done != nil {
		close(c.done)
	}
	callbacks := c.callbacks
	order := c.cbOrder
	c.callbacks = nil
	c.cbOrder = nil
	children := c.children
	c.children = nil
	timer := c.timer
	c.timer = nil
	c.mu.Unlock()

	if timer != nil {
		timer.Stop()
	}
	for _, id := range order {
		if fn, ok := callbacks[id]; ok {
			fn()
		}
	}
	for child := range children {
		child.cancel(err)
	}
	if c.parent != nil {
		c.parent.removeChild(c)
	}
	return true
}

func (c *cancelCtx) release() bool {
	c.mu.Lock()
	if c.err != nil || c.released {
		c.mu.Unlock()
		return false
	}
	c.released = true
	c.callbacks = nil
	c.cbOrder = nil
	timer := c.timer
	c.timer = nil
	c.mu.Unlock()

	if timer != nil {
		timer.Stop()
	}
	if c.parent != nil {
		c.parent.removeChild(c)
	}
	return true
}
