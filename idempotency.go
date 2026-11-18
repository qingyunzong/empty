package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrNilFunc is returned when Do is called without a request function.
	ErrNilFunc = errors.New("idempotency: nil request function")
	// ErrPanic is wrapped by the error cached when a request function panics.
	ErrPanic = errors.New("idempotency: request function panicked")
	// ErrClosed is returned by a store after Close has been called.
	ErrClosed = errors.New("idempotency: store is closed")
)

// Clock supplies the current time. Tests can replace it to control expiry.
type Clock interface {
	Now() time.Time
}

// ClockFunc adapts an ordinary function to Clock.
type ClockFunc func() time.Time

// Now implements Clock.
func (f ClockFunc) Now() time.Time {
	return f()
}

type systemClock struct{}

func (systemClock) Now() time.Time {
	return time.Now()
}

// Options configures a Store.
type Options struct {
	// TTL controls how long a completed result remains reusable. A value less
	// than or equal to zero keeps completed results until they are deleted.
	TTL time.Duration
	// Clock defaults to the system clock.
	Clock Clock
}

// Result is a published value and its associated error.
type Result[V any] struct {
	Value     V
	Err       error
	ExpiresAt time.Time
}

type entry[V any] struct {
	done      chan struct{}
	value     V
	err       error
	ready     bool
	expiresAt time.Time
	waiters   int
}

// Store coordinates requests that share a key. The first request for a key
// executes the supplied function; concurrent requests for that key wait for
// and reuse its result. A completed result is reusable until its TTL elapses.
//
// Store is safe for concurrent use. A request function must not call Do with
// the same key: that would wait for the request itself.
type Store[K comparable, V any] struct {
	mu      sync.Mutex
	options Options
	entries map[K]*entry[V]
	closed  bool
}

// New creates a store whose completed results live for ttl. A non-positive
// ttl disables expiry.
func New[K comparable, V any](ttl time.Duration) *Store[K, V] {
	return NewWithOptions[K, V](Options{TTL: ttl})
}

// NewStore is an alias for New.
func NewStore[K comparable, V any](ttl time.Duration) *Store[K, V] {
	return New[K, V](ttl)
}

// NewWithOptions creates a store with the supplied options.
func NewWithOptions[K comparable, V any](options Options) *Store[K, V] {
	if options.Clock == nil {
		options.Clock = systemClock{}
	}
	return &Store[K, V]{
		options: options,
		entries: make(map[K]*entry[V]),
	}
}

// NewWithClock creates a store with an explicit clock.
func NewWithClock[K comparable, V any](ttl time.Duration, clock Clock) *Store[K, V] {
	return NewWithOptions[K, V](Options{TTL: ttl, Clock: clock})
}

// Do returns the result associated with key. If no live result exists, one
// caller executes fn and publishes its result to every caller waiting on the
// same key. Both successful results and errors are cached for the TTL.
//
// If ctx is canceled while waiting, Do returns ctx.Err and leaves the leader
// and the cached result untouched. Cancellation before a call starts means the
// function is not executed.
func (s *Store[K, V]) Do(ctx context.Context, key K, fn func(context.Context) (V, error)) (V, error) {
	var zero V
	if fn == nil {
		return zero, ErrNilFunc
	}
	if ctx == nil {
		return zero, errors.New("idempotency: nil context")
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return zero, ErrClosed
	}

	e := s.entries[key]
	if e != nil && e.ready {
		now := s.options.Clock.Now()
		if !s.expired(e, now) {
			value, err := e.value, e.err
			s.mu.Unlock()
			return value, err
		}
		delete(s.entries, key)
		e = nil
	}
	if e != nil {
		done := e.done
		e.waiters++
		s.mu.Unlock()
		value, err := waitForResult(ctx, e, done)
		s.mu.Lock()
		e.waiters--
		s.mu.Unlock()
		return value, err
	}

	e = &entry[V]{done: make(chan struct{})}
	s.entries[key] = e
	s.mu.Unlock()

	return s.run(ctx, e, fn)
}

func (s *Store[K, V]) run(
	ctx context.Context,
	e *entry[V],
	fn func(context.Context) (V, error),
) (value V, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%w: %v", ErrPanic, recovered)
			s.publish(e, value, err)
			panic(recovered)
		}
		s.publish(e, value, err)
	}()
	return fn(ctx)
}

func (s *Store[K, V]) publish(e *entry[V], value V, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e.value = value
	e.err = err
	e.ready = true
	if s.options.TTL > 0 {
		e.expiresAt = s.options.Clock.Now().Add(s.options.TTL)
	}
	close(e.done)
}

func waitForResult[V any](ctx context.Context, e *entry[V], done <-chan struct{}) (V, error) {
	var zero V
	select {
	case <-done:
		return e.value, e.err
	case <-ctx.Done():
		// Prefer a concurrently published result over cancellation so that all
		// callers observe the same outcome whenever it is available.
		select {
		case <-done:
			return e.value, e.err
		default:
			return zero, ctx.Err()
		}
	}
}

func (s *Store[K, V]) expired(e *entry[V], now time.Time) bool {
	return s.options.TTL > 0 && !now.Before(e.expiresAt)
}

// Get returns the published result for key. The boolean is false when the key
// has no live result, including while its first request is still in flight.
func (s *Store[K, V]) Get(key K) (Result[V], bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e := s.entries[key]
	if e == nil || !e.ready {
		return Result[V]{}, false
	}
	now := s.options.Clock.Now()
	if s.expired(e, now) {
		delete(s.entries, key)
		return Result[V]{}, false
	}
	return Result[V]{Value: e.value, Err: e.err, ExpiresAt: e.expiresAt}, true
}

// Delete removes a completed result. It deliberately refuses to remove an
// in-flight entry: doing so would allow a second execution of the same key
// while the first is still running.
func (s *Store[K, V]) Delete(key K) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.entries[key]
	if !ok || !e.ready {
		return false
	}
	delete(s.entries, key)
	return true
}

// Reap removes expired, completed entries and returns the number removed.
// In-flight entries are never removed, even when their start time is older
// than the TTL. Publication restarts the TTL, so a result that completes after
// a long-running request still gets a full lifetime.
func (s *Store[K, V]) Reap() int {
	now := s.options.Clock.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	removed := 0
	for key, e := range s.entries {
		if e.ready && s.expired(e, now) {
			delete(s.entries, key)
			removed++
		}
	}
	return removed
}

// Sweep calls Reap at each interval until ctx is canceled. It is suitable for
// use as "go store.Sweep(ctx, interval)".
func (s *Store[K, V]) Sweep(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		return errors.New("idempotency: sweep interval must be positive")
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	s.Reap()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			s.Reap()
		}
	}
}

// Close prevents new calls to Do. Results already published remain readable.
// Requests already in flight may still publish and wake their waiters.
func (s *Store[K, V]) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// Len returns the number of tracked entries, including in-flight entries.
func (s *Store[K, V]) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// InFlight returns the number of keys whose first request has not completed.
func (s *Store[K, V]) InFlight() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	n := 0
	for _, e := range s.entries {
		if !e.ready {
			n++
		}
	}
	return n
}

// Waiting returns the number of callers currently waiting for key's first
// request to finish.
func (s *Store[K, V]) Waiting(key K) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	e := s.entries[key]
	if e == nil {
		return 0
	}
	return e.waiters
}
