// Package dedup merges concurrent subscriptions by key so that a single
// upstream operation serves many subscribers.
//
// Semantics:
//   - Subscriptions with the same key share one upstream "generation".
//   - The upstream context is cancelled only when the last subscriber of
//     the generation cancels.
//   - A generation torn down by cancellation never accepts new subscribers;
//     a later Subscribe starts a fresh generation.
//   - When the upstream completes, only subscribers still active at that
//     moment are notified.
//   - Callbacks are never invoked while holding a lock, so a callback may
//     reentrantly Subscribe or Cancel.
//   - Every subscription reaches exactly one terminal state: either the
//     upstream result is delivered, or it is cancelled (ErrCancelled).
package dedup

import (
	"context"
	"errors"
	"sync"
)

// ErrCancelled is the terminal error of a subscription that was cancelled
// before the upstream result was delivered.
var ErrCancelled = errors.New("dedup: subscription cancelled")

// Result is the terminal outcome of an upstream operation.
type Result struct {
	Value any
	Err   error
}

// Starter begins the upstream operation for a key. It is invoked once per
// generation, in its own goroutine. The supplied context is cancelled when
// the last subscriber of the generation cancels; the starter should honor
// it, but the manager tolerates starters that return anyway.
type Starter func(ctx context.Context, key string) (any, error)

// Manager deduplicates subscriptions by key.
type Manager struct {
	start Starter

	mu   sync.Mutex
	gens map[string]*generation
}

// NewManager returns a Manager that starts upstream work with start.
func NewManager(start Starter) *Manager {
	return &Manager{start: start, gens: make(map[string]*generation)}
}

// generation is one shared upstream operation and its live subscribers.
// It is only mutated under Manager.mu.
type generation struct {
	cancel context.CancelFunc
	subs   map[*Subscription]struct{}
	closed bool // terminal: cancelled or completed; never rejoinable
}

// Subscription is a handle to one subscriber's interest in a key.
type Subscription struct {
	m   *Manager
	key string
	gen *generation
	cb  func(Result)

	mu       sync.Mutex
	done     bool
	result   Result
	finished chan struct{}
}

// Subscribe registers cb for key, joining the live generation for that key
// or starting a new one. cb is invoked exactly once with the upstream
// result, and only if the subscription is still active when the upstream
// completes; it is never called under a lock. Pass nil and use Result to
// consume the terminal state synchronously.
func (m *Manager) Subscribe(key string, cb func(Result)) *Subscription {
	m.mu.Lock()
	gen, ok := m.gens[key]
	if !ok {
		ctx, cancel := context.WithCancel(context.Background())
		gen = &generation{cancel: cancel, subs: make(map[*Subscription]struct{})}
		m.gens[key] = gen
		go m.run(ctx, key, gen)
	}
	s := &Subscription{
		m:        m,
		key:      key,
		gen:      gen,
		cb:       cb,
		finished: make(chan struct{}),
	}
	gen.subs[s] = struct{}{}
	m.mu.Unlock()
	return s
}

// run executes the upstream operation and delivers its result to the
// subscribers still active at completion.
func (m *Manager) run(ctx context.Context, key string, gen *generation) {
	v, err := m.start(ctx, key)
	r := Result{Value: v, Err: err}

	m.mu.Lock()
	if gen.closed {
		// The generation was cancelled while the starter was still
		// running; nobody is left to notify.
		m.mu.Unlock()
		return
	}
	gen.closed = true
	delete(m.gens, key)
	subs := make([]*Subscription, 0, len(gen.subs))
	for s := range gen.subs {
		subs = append(subs, s)
		delete(gen.subs, s)
	}
	m.mu.Unlock()

	// Callbacks run outside the lock and may reentrantly Subscribe or
	// Cancel. Each deliver races with Cancel under Subscription.mu, so
	// exactly one terminal state wins per subscription.
	for _, s := range subs {
		s.deliver(r)
	}
}

// deliver attempts to resolve s with the upstream result. The callback
// runs before finished is closed, so once Done reports, the terminal state
// (including callback side effects) is fully settled.
func (s *Subscription) deliver(r Result) {
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		return
	}
	s.done = true
	s.result = r
	s.mu.Unlock()

	if s.cb != nil {
		s.cb(r)
	}
	close(s.finished)
}

// Cancel terminates the subscription. It is idempotent. If this was the
// last live subscriber of its generation, the generation is torn down and
// its upstream context is cancelled; the generation will never accept new
// subscribers again.
func (s *Subscription) Cancel() {
	m := s.m
	m.mu.Lock()
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		m.mu.Unlock()
		return
	}
	s.done = true
	s.result = Result{Err: ErrCancelled}
	gen := s.gen
	delete(gen.subs, s)
	var cancel context.CancelFunc
	if len(gen.subs) == 0 && !gen.closed {
		gen.closed = true
		delete(m.gens, s.key)
		cancel = gen.cancel
	}
	s.mu.Unlock()
	m.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	close(s.finished)
}

// Done is closed when the subscription reaches its terminal state. For a
// delivered subscription the callback, if any, has already returned.
func (s *Subscription) Done() <-chan struct{} { return s.finished }

// Result blocks until the subscription terminates and returns its outcome:
// the upstream result, or ErrCancelled if Cancel won the race.
func (s *Subscription) Result() (any, error) {
	<-s.finished
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.result.Value, s.result.Err
}
