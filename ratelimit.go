package dataeng

import (
	"context"
	"sync"
	"time"
)

// Scope identifies a rate-limit scope level that a response may carry reset
// feedback for.
type Scope int

const (
	ScopeGlobal Scope = iota
	ScopeTenant
	ScopeResource
	ScopeMethod
)

func (s Scope) String() string {
	switch s {
	case ScopeGlobal:
		return "global"
	case ScopeTenant:
		return "tenant"
	case ScopeResource:
		return "resource"
	case ScopeMethod:
		return "method"
	default:
		return "unknown"
	}
}

// Key addresses a single token bucket. The global bucket uses an empty ID.
type Key struct {
	Scope Scope
	ID    string
}

// Route describes which buckets a request draws from. Empty fields mean the
// scope does not apply to the request.
type Route struct {
	Tenant   string
	Resource string
	Method   string
}

// Keys returns the bucket keys relevant to the route, global scope first.
func (r Route) Keys() []Key {
	keys := make([]Key, 0, 4)
	keys = append(keys, Key{Scope: ScopeGlobal})
	if r.Tenant != "" {
		keys = append(keys, Key{Scope: ScopeTenant, ID: r.Tenant})
	}
	if r.Resource != "" {
		keys = append(keys, Key{Scope: ScopeResource, ID: r.Resource})
	}
	if r.Method != "" {
		keys = append(keys, Key{Scope: ScopeMethod, ID: r.Method})
	}
	return keys
}

// Hint is reset feedback for a single scope. A nil *Hint in Feedback means
// the response said nothing about that scope and its bucket stays untouched.
type Hint struct {
	// ResetAt is the server-side time at which the bucket refills.
	ResetAt time.Time
	// Remaining is the reported token count, or -1 if not provided.
	Remaining int
	// Limit is the reported bucket capacity, or -1 if not provided.
	Limit int
}

// Feedback carries the per-scope reset hints of a single response.
type Feedback struct {
	// ServerTime is the server's Date header, used for bounded clock-skew
	// correction. Zero means the response carried no usable Date.
	ServerTime time.Time
	Global     *Hint
	Tenant     *Hint
	Resource   *Hint
	Method     *Hint
}

type bucket struct {
	resetAt   time.Time
	remaining int // -1 means unknown, treated as unlimited
	limit     int // -1 means unknown
}

// Scheduler is a client-side rate-limit feedback gate. A collection
// scheduler calls Wait before each request and Update with the response
// feedback afterwards.
type Scheduler struct {
	now     func() time.Time
	maxSkew time.Duration

	mu      sync.Mutex
	buckets map[Key]*bucket
}

// Option configures a Scheduler.
type Option func(*Scheduler)

// WithClock overrides the time source, mainly for tests.
func WithClock(now func() time.Time) Option {
	return func(s *Scheduler) { s.now = now }
}

// WithMaxSkew bounds how much clock skew vs. the server is trusted when
// translating server reset times onto the local clock.
func WithMaxSkew(d time.Duration) Option {
	return func(s *Scheduler) { s.maxSkew = d }
}

// NewScheduler returns a Scheduler with a 30 second skew bound.
func NewScheduler(opts ...Option) *Scheduler {
	s := &Scheduler{
		now:     time.Now,
		maxSkew: 30 * time.Second,
		buckets: make(map[Key]*bucket),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func (s *Scheduler) bucketFor(k Key) *bucket {
	b, ok := s.buckets[k]
	if !ok {
		b = &bucket{remaining: -1, limit: -1}
		s.buckets[k] = b
	}
	return b
}

// correct maps a server-side reset time onto the local clock. Clock skew is
// trusted only up to maxSkew, and expired dates are clamped to now so a
// stale hint can never move a bucket deadline backwards.
func (s *Scheduler) correct(serverTime, resetAt time.Time) time.Time {
	now := s.now()
	if !serverTime.IsZero() {
		skew := serverTime.Sub(now)
		if skew > s.maxSkew {
			skew = s.maxSkew
		} else if skew < -s.maxSkew {
			skew = -s.maxSkew
		}
		resetAt = resetAt.Add(-skew)
	}
	if resetAt.Before(now) {
		resetAt = now
	}
	return resetAt
}

// deadlineLocked returns the earliest time at which every relevant bucket
// permits a request: the maximum reset deadline across the given scopes.
// The zero time means the request may proceed immediately.
func (s *Scheduler) deadlineLocked(keys []Key) time.Time {
	now := s.now()
	var deadline time.Time
	for _, k := range keys {
		b, ok := s.buckets[k]
		if !ok || b.remaining != 0 {
			continue
		}
		if b.resetAt.After(now) && b.resetAt.After(deadline) {
			deadline = b.resetAt
		}
	}
	return deadline
}

// Wait blocks until every bucket relevant to the route permits a request,
// then consumes one token from each of them. The effective constraint is the
// maximum reset deadline across the relevant scopes. If ctx is cancelled
// while waiting, Wait returns ctx.Err() and no token is consumed.
func (s *Scheduler) Wait(ctx context.Context, route Route) error {
	keys := route.Keys()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		s.mu.Lock()
		deadline := s.deadlineLocked(keys)
		if deadline.IsZero() {
			s.consumeLocked(keys)
			s.mu.Unlock()
			return nil
		}
		wait := deadline.Sub(s.now())
		s.mu.Unlock()

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// consumeLocked takes one token from each relevant bucket. Buckets whose
// reset time has passed refill first: to their known limit, or to unlimited
// when no limit was ever reported.
func (s *Scheduler) consumeLocked(keys []Key) {
	now := s.now()
	for _, k := range keys {
		b := s.bucketFor(k)
		if b.remaining == 0 && !b.resetAt.After(now) {
			if b.limit > 0 {
				b.remaining = b.limit
			} else {
				b.remaining = -1
			}
		}
		if b.remaining > 0 {
			b.remaining--
		}
	}
}

// Update applies the feedback of one response. Only buckets with a non-nil
// hint are modified; scopes the response did not mention keep their state.
func (s *Scheduler) Update(route Route, fb Feedback) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applyLocked(Key{Scope: ScopeGlobal}, fb.Global, fb.ServerTime)
	if route.Tenant != "" {
		s.applyLocked(Key{Scope: ScopeTenant, ID: route.Tenant}, fb.Tenant, fb.ServerTime)
	}
	if route.Resource != "" {
		s.applyLocked(Key{Scope: ScopeResource, ID: route.Resource}, fb.Resource, fb.ServerTime)
	}
	if route.Method != "" {
		s.applyLocked(Key{Scope: ScopeMethod, ID: route.Method}, fb.Method, fb.ServerTime)
	}
}

func (s *Scheduler) applyLocked(k Key, h *Hint, serverTime time.Time) {
	if h == nil {
		return
	}
	b := s.bucketFor(k)
	if !h.ResetAt.IsZero() {
		b.resetAt = s.correct(serverTime, h.ResetAt)
	}
	if h.Limit >= 0 {
		b.limit = h.Limit
	}
	if h.Remaining >= 0 {
		b.remaining = h.Remaining
	}
}

// Remaining reports the last known token count for a bucket, or -1 when no
// feedback was ever recorded for it.
func (s *Scheduler) Remaining(k Key) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b, ok := s.buckets[k]; ok {
		return b.remaining
	}
	return -1
}
