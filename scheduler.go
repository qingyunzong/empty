package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrInvalidAmount is returned for non-positive token amounts.
	ErrInvalidAmount = errors.New("dataeng: amount must be positive")
	// ErrRequestTooLarge is returned when n exceeds a bucket's capacity
	// and therefore can never be granted.
	ErrRequestTooLarge = errors.New("dataeng: request exceeds bucket capacity")
	// ErrReservationClosed is returned when using a cancelled reservation.
	ErrReservationClosed = errors.New("dataeng: reservation already closed")
	// ErrLevelDisabled is returned when throttling a limit level that is
	// not configured on the scheduler.
	ErrLevelDisabled = errors.New("dataeng: limit level not configured")
)

// Rate configures one token bucket: up to Burst tokens are available at
// once, refilling continuously at Burst tokens per Every. A zero Rate
// disables the limit level entirely.
type Rate struct {
	Burst int64
	Every time.Duration
}

func (r Rate) enabled() bool { return r.Burst > 0 || r.Every > 0 }
func (r Rate) valid() bool   { return r.Burst > 0 && r.Every > 0 }

// Config holds the provider's quota at each level of the hierarchy.
type Config struct {
	// Global limits the provider as a whole (all tenants share it).
	Global Rate
	// PerApp limits each registered application.
	PerApp Rate
	// PerUser limits each user within an application.
	PerUser Rate
	// PerEndpoint limits each endpoint within an application.
	PerEndpoint Rate
}

// Key identifies the tenant coordinates of a request.
type Key struct {
	App      string
	User     string
	Endpoint string
}

// Level selects one tier of the quota hierarchy.
type Level int

const (
	LevelGlobal Level = iota
	LevelApp
	LevelUser
	LevelEndpoint
)

func (l Level) String() string {
	switch l {
	case LevelGlobal:
		return "global"
	case LevelApp:
		return "app"
	case LevelUser:
		return "user"
	case LevelEndpoint:
		return "endpoint"
	}
	return "unknown"
}

// bucket is a token bucket with an optional freeze deadline learned from
// a 429 response.
type bucket struct {
	capacity    int64
	every       time.Duration
	tokens      float64
	lastRefill  time.Time
	frozenUntil time.Time
}

func newBucket(r Rate, now time.Time) *bucket {
	return &bucket{
		capacity:   r.Burst,
		every:      r.Every,
		tokens:     float64(r.Burst),
		lastRefill: now,
	}
}

func (b *bucket) refill(now time.Time) {
	if !now.After(b.lastRefill) {
		return
	}
	b.tokens += float64(now.Sub(b.lastRefill)) * float64(b.capacity) / float64(b.every)
	if b.tokens > float64(b.capacity) {
		b.tokens = float64(b.capacity)
	}
	b.lastRefill = now
}

// waitFor returns how long until n tokens have accumulated, assuming the
// bucket has already been refilled at now.
func (b *bucket) waitFor(n int64) time.Duration {
	deficit := float64(n) - b.tokens
	if deficit <= 0 {
		return 0
	}
	return time.Duration(deficit * float64(b.every) / float64(b.capacity))
}

// request is one queued acquisition, kept in the scheduler's global
// arrival-ordered pending list.
type request struct {
	n       int64
	buckets []*bucket
	granted bool
}

// Scheduler coordinates quota across the provider's global, per-app,
// per-user and per-endpoint limits. It is safe for concurrent use.
type Scheduler struct {
	clock Clock

	mu        sync.Mutex
	changed   chan struct{} // closed and replaced on every state change
	pending   []*request    // ungranted requests, in arrival order
	global    *bucket
	apps      map[string]*bucket
	users     map[[2]string]*bucket
	endpoints map[[2]string]*bucket
	buckets   []*bucket // every live bucket, for grant processing
	cfg       Config
}

// NewScheduler builds a Scheduler from cfg. A nil clock uses the wall
// clock; pass a ManualClock in tests.
func NewScheduler(cfg Config, clock Clock) (*Scheduler, error) {
	for _, r := range []Rate{cfg.Global, cfg.PerApp, cfg.PerUser, cfg.PerEndpoint} {
		if r.enabled() && !r.valid() {
			return nil, fmt.Errorf("dataeng: invalid rate %+v", r)
		}
	}
	if clock == nil {
		clock = realClock{}
	}
	now := clock.Now()
	s := &Scheduler{
		clock:     clock,
		changed:   make(chan struct{}),
		apps:      make(map[string]*bucket),
		users:     make(map[[2]string]*bucket),
		endpoints: make(map[[2]string]*bucket),
		cfg:       cfg,
	}
	if cfg.Global.enabled() {
		s.global = newBucket(cfg.Global, now)
		s.buckets = append(s.buckets, s.global)
	}
	return s, nil
}

func (s *Scheduler) appBucket(key Key) *bucket {
	b, ok := s.apps[key.App]
	if !ok {
		b = newBucket(s.cfg.PerApp, s.clock.Now())
		s.apps[key.App] = b
		s.buckets = append(s.buckets, b)
	}
	return b
}

func (s *Scheduler) userBucket(key Key) *bucket {
	k := [2]string{key.App, key.User}
	b, ok := s.users[k]
	if !ok {
		b = newBucket(s.cfg.PerUser, s.clock.Now())
		s.users[k] = b
		s.buckets = append(s.buckets, b)
	}
	return b
}

func (s *Scheduler) endpointBucket(key Key) *bucket {
	k := [2]string{key.App, key.Endpoint}
	b, ok := s.endpoints[k]
	if !ok {
		b = newBucket(s.cfg.PerEndpoint, s.clock.Now())
		s.endpoints[k] = b
		s.buckets = append(s.buckets, b)
	}
	return b
}

// bucketsForKeyLocked returns the buckets a request for key must draw
// from, creating per-tenant buckets lazily.
func (s *Scheduler) bucketsForKeyLocked(key Key) []*bucket {
	var out []*bucket
	if s.global != nil {
		out = append(out, s.global)
	}
	if s.cfg.PerApp.enabled() {
		out = append(out, s.appBucket(key))
	}
	if s.cfg.PerUser.enabled() {
		out = append(out, s.userBucket(key))
	}
	if s.cfg.PerEndpoint.enabled() {
		out = append(out, s.endpointBucket(key))
	}
	return out
}

func (s *Scheduler) bucketForLevelLocked(key Key, level Level) (*bucket, error) {
	switch level {
	case LevelGlobal:
		if s.global != nil {
			return s.global, nil
		}
	case LevelApp:
		if s.cfg.PerApp.enabled() {
			return s.appBucket(key), nil
		}
	case LevelUser:
		if s.cfg.PerUser.enabled() {
			return s.userBucket(key), nil
		}
	case LevelEndpoint:
		if s.cfg.PerEndpoint.enabled() {
			return s.endpointBucket(key), nil
		}
	default:
		return nil, fmt.Errorf("dataeng: unknown level %d", level)
	}
	return nil, fmt.Errorf("%w: %s", ErrLevelDisabled, level)
}

// Acquire reserves n tokens for key across every configured limit level,
// blocking until the reservation can be granted or ctx is done.
//
// Pending requests are scanned in arrival order; a request is granted
// when every bucket it needs has enough unclaimed tokens and is not
// frozen. Requests blocked by a token shortfall reserve their share in
// every bucket they touch, so later requests can only spend the surplus:
// tokens are never over-issued and no tenant can be starved by others.
// Cancelling ctx before the grant removes the request from the queue.
func (s *Scheduler) Acquire(ctx context.Context, key Key, n int64) (*Reservation, error) {
	if n <= 0 {
		return nil, ErrInvalidAmount
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	buckets := s.bucketsForKeyLocked(key)
	for _, b := range buckets {
		if n > b.capacity {
			s.mu.Unlock()
			return nil, ErrRequestTooLarge
		}
	}
	req := &request{n: n, buckets: buckets}
	s.pending = append(s.pending, req)
	for {
		s.processLocked()
		if req.granted {
			s.mu.Unlock()
			return &Reservation{sched: s, buckets: buckets, remaining: n}, nil
		}
		wait, hasDeadline := s.waitLocked(req, n)
		ch := s.changed
		s.mu.Unlock()

		var timer Timer
		var fired <-chan time.Time
		if hasDeadline {
			timer = s.clock.Timer(wait)
			fired = timer.C()
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			s.mu.Lock()
			if req.granted {
				s.mu.Unlock()
				return &Reservation{sched: s, buckets: buckets, remaining: n}, nil
			}
			s.removeLocked(req)
			s.processLocked()
			s.mu.Unlock()
			return nil, ctx.Err()
		case <-ch:
			if timer != nil {
				timer.Stop()
			}
			s.mu.Lock()
		case <-fired:
			s.mu.Lock()
		}
	}
}

// processLocked scans pending requests in arrival order and grants each
// one whose buckets can all satisfy it right now. A request blocked by a
// token shortfall claims its amount in each deficient bucket (tracked in
// claimed), so later requests may only spend tokens that earlier ones
// cannot use; because every scan visits requests in the same arrival
// order, those claims always protect the earliest waiters, which is what
// keeps the scheduler starvation-free. Requests blocked by a frozen
// bucket make no claim, since they cannot run soon anyway. It broadcasts
// when anything was granted.
func (s *Scheduler) processLocked() {
	now := s.clock.Now()
	for _, b := range s.buckets {
		b.refill(now)
	}
	claimed := make(map[*bucket]float64, len(s.buckets))
	grantedAny := false
	pending := s.pending[:0]
	for _, req := range s.pending {
		frozen := false
		var deficient []*bucket
		for _, b := range req.buckets {
			if now.Before(b.frozenUntil) {
				frozen = true
				break
			}
			if claimed[b]+float64(req.n) > b.tokens {
				deficient = append(deficient, b)
			}
		}
		switch {
		case frozen:
			pending = append(pending, req)
		case len(deficient) > 0:
			for _, b := range deficient {
				claimed[b] += float64(req.n)
			}
			pending = append(pending, req)
		default:
			for _, b := range req.buckets {
				b.tokens -= float64(req.n)
			}
			req.granted = true
			grantedAny = true
		}
	}
	s.pending = pending
	if grantedAny {
		s.broadcastLocked()
	}
}

// waitLocked computes how long until req's buckets could satisfy it,
// considering token refills and freezes. If the request is blocked only
// by queue position, hasDeadline is false and the caller waits for the
// next state change instead.
func (s *Scheduler) waitLocked(req *request, n int64) (wait time.Duration, hasDeadline bool) {
	now := s.clock.Now()
	for _, b := range req.buckets {
		b.refill(now)
		d := b.waitFor(n)
		if b.frozenUntil.After(now) {
			if fd := b.frozenUntil.Sub(now); fd > d {
				d = fd
			}
		}
		if d > 0 {
			hasDeadline = true
		}
		if d > wait {
			wait = d
		}
	}
	return wait, hasDeadline
}

func (s *Scheduler) removeLocked(req *request) {
	for i, q := range s.pending {
		if q == req {
			s.pending = append(s.pending[:i], s.pending[i+1:]...)
			break
		}
	}
}

func (s *Scheduler) broadcastLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// Throttle records a 429 response: only the single bucket identified by
// key and level is frozen until the Retry-After deadline, leaving sibling
// tenants and other limit levels untouched. retryAfter may be seconds or
// an HTTP date; dateHeader should carry the response's Date header so
// server clock skew is corrected. It returns the local freeze deadline.
func (s *Scheduler) Throttle(key Key, level Level, retryAfter, dateHeader string) (time.Time, error) {
	until, err := ResolveRetryAfter(retryAfter, dateHeader, s.clock.Now())
	if err != nil {
		return time.Time{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := s.bucketForLevelLocked(key, level)
	if err != nil {
		return time.Time{}, err
	}
	if until.After(b.frozenUntil) {
		b.frozenUntil = until
	}
	s.broadcastLocked()
	return until, nil
}

// Reservation is a granted quota allowance. Consume tokens as requests
// are actually sent; Cancel returns whatever remains unused to every
// bucket it was drawn from.
type Reservation struct {
	sched     *Scheduler
	buckets   []*bucket
	remaining int64
	closed    bool
}

// Remaining reports how many reserved tokens are still unconsumed.
func (r *Reservation) Remaining() int64 {
	r.sched.mu.Lock()
	defer r.sched.mu.Unlock()
	return r.remaining
}

// Consume marks n reserved tokens as spent.
func (r *Reservation) Consume(n int64) error {
	if n <= 0 {
		return ErrInvalidAmount
	}
	r.sched.mu.Lock()
	defer r.sched.mu.Unlock()
	if r.closed {
		return ErrReservationClosed
	}
	if n > r.remaining {
		return ErrInvalidAmount
	}
	r.remaining -= n
	return nil
}

// Cancel returns all unconsumed tokens to their buckets, waking queued
// requests that can now proceed. It is idempotent.
func (r *Reservation) Cancel() {
	r.sched.mu.Lock()
	defer r.sched.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	if r.remaining == 0 {
		return
	}
	now := r.sched.clock.Now()
	for _, b := range r.buckets {
		b.refill(now)
		b.tokens += float64(r.remaining)
		if b.tokens > float64(b.capacity) {
			b.tokens = float64(b.capacity)
		}
	}
	r.remaining = 0
	r.sched.processLocked()
	r.sched.broadcastLocked()
}
