// Package scope provides block-scoped resource management.
//
// Resources are registered with Defer and cleaned up in LIFO order when the
// scope closes. Cleanup runs on every exit path: normal return, panic, and
// context cancellation. If cleanups fail, the primary error is preserved and
// cleanup failures are attached as secondary errors via errors.Join.
// Resources registered while cleanup is in progress are still cleaned up
// before the block exits. All lifecycle steps are emitted as trace events.
package scope

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

var (
	// ErrClosed is returned by Defer when the scope has fully closed.
	ErrClosed = errors.New("scope: already closed")
	// ErrNilCleanup is returned by Defer when the cleanup callback is nil.
	ErrNilCleanup = errors.New("scope: nil cleanup callback")
)

// EventKind identifies a lifecycle event in a Scope.
type EventKind string

const (
	EventOpen            EventKind = "open"
	EventAcquire         EventKind = "acquire"
	EventAcquireRejected EventKind = "acquire_rejected"
	EventRelease         EventKind = "release"
	EventReleaseFailed   EventKind = "release_failed"
	EventClose           EventKind = "close"
)

// Event is a single trace record emitted by a Scope.
type Event struct {
	Kind EventKind
	Name string
	Err  error
}

func (e Event) String() string {
	if e.Err != nil {
		return fmt.Sprintf("%s %q: %v", e.Kind, e.Name, e.Err)
	}
	if e.Name != "" {
		return fmt.Sprintf("%s %q", e.Kind, e.Name)
	}
	return string(e.Kind)
}

// Tracer receives lifecycle events. Implementations must be safe for
// concurrent use.
type Tracer interface {
	Emit(Event)
}

// TracerFunc adapts a function to Tracer.
type TracerFunc func(Event)

// Emit calls f(e).
func (f TracerFunc) Emit(e Event) { f(e) }

// Option configures a Scope.
type Option func(*Scope)

// WithTracer attaches a Tracer to the scope.
func WithTracer(t Tracer) Option {
	return func(s *Scope) { s.tracer = t }
}

type cleanup struct {
	name string
	fn   func(ctx context.Context) error
}

// Scope tracks resources whose cleanup runs in LIFO order on Close.
type Scope struct {
	ctx context.Context

	mu      sync.Mutex
	stack   []cleanup
	closing bool
	closed  bool
	tracer  Tracer
}

// New creates a Scope bound to ctx. A nil ctx means context.Background().
func New(ctx context.Context, opts ...Option) *Scope {
	if ctx == nil {
		ctx = context.Background()
	}
	s := &Scope{ctx: ctx}
	for _, o := range opts {
		o(s)
	}
	s.emit(Event{Kind: EventOpen})
	return s
}

// Context returns the context the scope is bound to.
func (s *Scope) Context() context.Context { return s.ctx }

func (s *Scope) emit(e Event) {
	if s.tracer != nil {
		s.tracer.Emit(e)
	}
}

// Defer registers fn to run on Close, in LIFO order relative to other
// registered cleanups.
//
// Acceptance is controlled: a nil callback is rejected with ErrNilCleanup,
// and registration after the scope has fully closed is rejected with
// ErrClosed. Registration while Close is still running is accepted, so
// resources created during cleanup are themselves cleaned up before the
// block exits.
func (s *Scope) Defer(name string, fn func(ctx context.Context) error) error {
	if fn == nil {
		s.emit(Event{Kind: EventAcquireRejected, Name: name, Err: ErrNilCleanup})
		return ErrNilCleanup
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.emit(Event{Kind: EventAcquireRejected, Name: name, Err: ErrClosed})
		return ErrClosed
	}
	s.stack = append(s.stack, cleanup{name: name, fn: fn})
	s.mu.Unlock()
	s.emit(Event{Kind: EventAcquire, Name: name})
	return nil
}

// Close runs every registered cleanup in LIFO order, including cleanups
// registered by other cleanups while Close is in progress. A cleanup that
// panics is recovered and reported as an error so remaining cleanups still
// run. All cleanup failures are joined into the returned error.
//
// Close is idempotent in effect but returns ErrClosed on subsequent calls.
func (s *Scope) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrClosed
	}
	s.closing = true
	s.mu.Unlock()

	var errs []error
	for {
		s.mu.Lock()
		if len(s.stack) == 0 {
			s.closed = true
			s.closing = false
			s.mu.Unlock()
			break
		}
		c := s.stack[len(s.stack)-1]
		s.stack = s.stack[:len(s.stack)-1]
		s.mu.Unlock()

		if err := callCleanup(s.ctx, c); err != nil {
			errs = append(errs, err)
			s.emit(Event{Kind: EventReleaseFailed, Name: c.name, Err: err})
		} else {
			s.emit(Event{Kind: EventRelease, Name: c.name})
		}
	}
	s.emit(Event{Kind: EventClose})
	return errors.Join(errs...)
}

func callCleanup(ctx context.Context, c cleanup) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("scope: cleanup %q panicked: %v", c.name, r)
		}
	}()
	return c.fn(ctx)
}

// Run executes fn inside a new scope and guarantees cleanup on every exit
// path: normal return, fn panic, and context cancellation.
//
// If fn returns an error and cleanups also fail, the fn error is the primary
// error and cleanup failures are attached after it via errors.Join. If fn
// panics, cleanups still run and the original panic value is re-panicked.
func Run(ctx context.Context, fn func(s *Scope) error, opts ...Option) (err error) {
	s := New(ctx, opts...)
	defer func() {
		cerr := s.Close()
		if p := recover(); p != nil {
			panic(p)
		}
		err = errors.Join(err, cerr)
	}()
	if err := s.ctx.Err(); err != nil {
		return err
	}
	return fn(s)
}
