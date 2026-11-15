package dataeng

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

var (
	// ErrSchedulerClosed is returned when work is submitted to a closed
	// scheduler or when a queued ticket is released by Close.
	ErrSchedulerClosed = errors.New("dataeng: scheduler closed")
	// ErrTicketCanceled is returned by Ticket.Wait after an explicit Cancel.
	ErrTicketCanceled = errors.New("dataeng: ticket canceled")
	// ErrInvalidRequest identifies an invalid request or bucket configuration.
	ErrInvalidRequest = errors.New("dataeng: invalid request")

	errInvalidBucketRate  = fmt.Errorf("%w: bucket rate must be non-negative", ErrInvalidRequest)
	errInvalidBucketBurst = fmt.Errorf("%w: bucket burst must be non-negative", ErrInvalidRequest)
)

// Request is one outbound API operation.
//
// Cost is expressed in tokens. A zero Cost means one token.
type Request struct {
	Tenant   string
	Endpoint string
	Cost     float64
}

// TenantConfig controls a tenant's weighted share and optional tenant bucket.
// A zero Weight means 1. A zero Bucket is unlimited.
type TenantConfig struct {
	Weight float64
	Bucket BucketConfig
}

// Config describes the quotas and the clock used by a Scheduler.
//
// Tenants and endpoints omitted from the maps are created on first use with
// weight 1 and unlimited buckets. Configure Global to impose a process-wide
// limit.
type Config struct {
	Clock     Clock
	Global    BucketConfig
	Tenants   map[string]TenantConfig
	Endpoints map[string]BucketConfig
}

// Scheduler admits requests when the global, tenant, and endpoint buckets all
// have enough tokens. Among runnable tenants it selects the smallest virtual
// finish time, which gives weighted fair sharing without starving low-weight
// tenants.
type Scheduler struct {
	mu    sync.Mutex
	clock Clock

	global     limitState
	tenants    map[string]*tenantState
	tenantList []*tenantState
	endpoints  map[string]*endpointState

	pending     int
	virtualTime float64
	timer       Timer
	timerDue    time.Time
	timerSeq    uint64
	closed      bool
}

type tenantState struct {
	id     string
	weight float64
	limit  limitState
	queue  []*Ticket
	vtime  float64
}

type endpointState struct {
	id    string
	limit limitState
}

// NewScheduler validates cfg and constructs a scheduler. It does not start a
// goroutine; work is driven by Submit, quota updates, settlements, and Clock
// callbacks.
func NewScheduler(cfg Config) (*Scheduler, error) {
	clock := cfg.Clock
	if clock == nil {
		clock = SystemClock{}
	}
	now := clock.Now()
	if err := validateBucketConfig(cfg.Global); err != nil {
		return nil, fmt.Errorf("global bucket: %w", err)
	}

	s := &Scheduler{
		clock:     clock,
		global:    newLimitState(cfg.Global, now),
		tenants:   make(map[string]*tenantState, len(cfg.Tenants)),
		endpoints: make(map[string]*endpointState, len(cfg.Endpoints)),
	}

	ids := make([]string, 0, len(cfg.Tenants))
	for id := range cfg.Tenants {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		tenantCfg := cfg.Tenants[id]
		weight := tenantCfg.Weight
		if weight == 0 {
			weight = 1
		}
		if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 {
			return nil, fmt.Errorf("tenant %q: %w: weight must be positive", id, ErrInvalidRequest)
		}
		if err := validateBucketConfig(tenantCfg.Bucket); err != nil {
			return nil, fmt.Errorf("tenant %q bucket: %w", id, err)
		}
		tenant := &tenantState{
			id:     id,
			weight: weight,
			limit:  newLimitState(tenantCfg.Bucket, now),
		}
		s.tenants[id] = tenant
		s.tenantList = append(s.tenantList, tenant)
	}

	for id, endpointCfg := range cfg.Endpoints {
		if err := validateBucketConfig(endpointCfg); err != nil {
			return nil, fmt.Errorf("endpoint %q bucket: %w", id, err)
		}
		s.endpoints[id] = &endpointState{id: id, limit: newLimitState(endpointCfg, now)}
	}
	return s, nil
}

// Submit queues a request and immediately dispatches everything that fits.
// The returned ticket can be waited on, canceled, or inspected.
func (s *Scheduler) Submit(req Request) (*Ticket, error) {
	if req.Cost == 0 {
		req.Cost = 1
	}
	if math.IsNaN(req.Cost) || math.IsInf(req.Cost, 0) || req.Cost <= 0 {
		return nil, fmt.Errorf("%w: cost must be positive and finite", ErrInvalidRequest)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrSchedulerClosed
	}

	now := s.clock.Now()
	tenant := s.tenantLocked(req.Tenant, now)
	endpoint := s.endpointLocked(req.Endpoint, now)
	if req.Cost > s.global.bucket.burst {
		return nil, fmt.Errorf("%w: cost %g exceeds global burst %g", ErrInvalidRequest, req.Cost, s.global.bucket.burst)
	}
	if req.Cost > tenant.limit.bucket.burst {
		return nil, fmt.Errorf("%w: cost %g exceeds tenant %q burst %g", ErrInvalidRequest, req.Cost, tenant.id, tenant.limit.bucket.burst)
	}
	if req.Cost > endpoint.limit.bucket.burst {
		return nil, fmt.Errorf("%w: cost %g exceeds endpoint %q burst %g", ErrInvalidRequest, req.Cost, endpoint.id, endpoint.limit.bucket.burst)
	}

	ticket := &Ticket{s: s, req: req, done: make(chan struct{})}
	if len(tenant.queue) == 0 && tenant.vtime < s.virtualTime {
		tenant.vtime = s.virtualTime
	}
	tenant.queue = append(tenant.queue, ticket)
	s.pending++

	s.dispatchLocked(now)
	if !ticket.terminal {
		s.armTicketLocked(now, tenant, ticket)
	}
	return ticket, nil
}

// Acquire is Submit followed by Ticket.Wait.
func (s *Scheduler) Acquire(ctx context.Context, req Request) (*Reservation, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	ticket, err := s.Submit(req)
	if err != nil {
		return nil, err
	}
	return ticket.Wait(ctx)
}

func (s *Scheduler) tenantLocked(id string, now time.Time) *tenantState {
	if tenant, ok := s.tenants[id]; ok {
		return tenant
	}
	tenant := &tenantState{id: id, weight: 1, limit: newLimitState(BucketConfig{}, now)}
	s.tenants[id] = tenant
	s.tenantList = append(s.tenantList, tenant)
	return tenant
}

func (s *Scheduler) endpointLocked(id string, now time.Time) *endpointState {
	if endpoint, ok := s.endpoints[id]; ok {
		return endpoint
	}
	endpoint := &endpointState{id: id, limit: newLimitState(BucketConfig{}, now)}
	s.endpoints[id] = endpoint
	return endpoint
}

func (s *Scheduler) dispatchLocked(now time.Time) {
	if s.closed {
		return
	}
	s.refillLocked(now)
	for {
		tenant, ticket, index := s.pickLocked(now)
		if ticket == nil {
			return
		}
		endpoint := s.endpoints[ticket.req.Endpoint]
		cost := ticket.req.Cost

		// admissibility was checked under the same lock and at the same
		// instant, so these takes cannot partially fail.
		if !s.global.bucket.take(now, cost) {
			return
		}
		if !tenant.limit.bucket.take(now, cost) {
			s.global.bucket.restore(now, cost)
			return
		}
		if !endpoint.limit.bucket.take(now, cost) {
			s.global.bucket.restore(now, cost)
			tenant.limit.bucket.restore(now, cost)
			return
		}

		tenant.queue = append(tenant.queue[:index], tenant.queue[index+1:]...)
		s.pending--

		reservation := &Reservation{
			s:             s,
			tenantID:      tenant.id,
			endpointID:    endpoint.id,
			cost:          cost,
			admittedAt:    now,
			global:        &s.global,
			tenantLimit:   &tenant.limit,
			endpointLimit: &endpoint.limit,
		}
		ticket.reservation = reservation
		ticket.terminal = true
		close(ticket.done)

		s.global.inFlight += cost
		tenant.limit.inFlight += cost
		endpoint.limit.inFlight += cost

		tenant.vtime += cost / tenant.weight
		s.virtualTime = s.minBacklogVTimeLocked()
		if math.IsInf(s.virtualTime, 1) {
			s.virtualTime = tenant.vtime
		}
	}
}

func (s *Scheduler) pickLocked(now time.Time) (*tenantState, *Ticket, int) {
	var bestTenant *tenantState
	var bestTicket *Ticket
	bestIndex := -1

	for _, tenant := range s.tenantList {
		if len(tenant.queue) == 0 {
			continue
		}
		index := -1
		for i, ticket := range tenant.queue {
			if s.admissibleLocked(tenant, ticket, now) {
				index = i
				break
			}
		}
		if index < 0 {
			continue
		}
		if bestTenant == nil || tenant.vtime < bestTenant.vtime {
			bestTenant = tenant
			bestTicket = tenant.queue[index]
			bestIndex = index
		}
	}
	return bestTenant, bestTicket, bestIndex
}

func (s *Scheduler) admissibleLocked(tenant *tenantState, ticket *Ticket, now time.Time) bool {
	if s.global.cooldownWait(now) > 0 || tenant.limit.cooldownWait(now) > 0 {
		return false
	}
	endpoint, ok := s.endpoints[ticket.req.Endpoint]
	if !ok {
		return false
	}
	if endpoint.limit.cooldownWait(now) > 0 {
		return false
	}
	cost := ticket.req.Cost
	return s.global.bucket.tokens >= cost &&
		tenant.limit.bucket.tokens >= cost &&
		endpoint.limit.bucket.tokens >= cost
}

func (s *Scheduler) refillLocked(now time.Time) {
	s.global.bucket.refill(now)
	for _, tenant := range s.tenantList {
		tenant.limit.bucket.refill(now)
	}
	for _, endpoint := range s.endpoints {
		endpoint.limit.bucket.refill(now)
	}
}

func (s *Scheduler) minBacklogVTimeLocked() float64 {
	min := math.Inf(1)
	for _, tenant := range s.tenantList {
		if len(tenant.queue) > 0 && tenant.vtime < min {
			min = tenant.vtime
		}
	}
	return min
}

func (s *Scheduler) nextWakeLocked(now time.Time) (time.Duration, bool) {
	best := neverDuration
	found := false
	for _, tenant := range s.tenantList {
		for _, ticket := range tenant.queue {
			d := s.ticketWaitLocked(tenant, ticket, now)
			if d < best {
				best = d
				found = true
			}
		}
	}
	if !found {
		return 0, false
	}
	if best <= 0 {
		best = time.Nanosecond
	}
	return best, true
}

func (s *Scheduler) ticketWaitLocked(tenant *tenantState, ticket *Ticket, now time.Time) time.Duration {
	wait := time.Duration(0)
	update := func(d time.Duration) {
		if d > wait {
			wait = d
		}
	}
	update(s.global.cooldownWait(now))
	update(tenant.limit.cooldownWait(now))
	if endpoint, ok := s.endpoints[ticket.req.Endpoint]; ok {
		update(endpoint.limit.cooldownWait(now))
		update(endpoint.limit.bucket.timeUntil(now, ticket.req.Cost))
	} else {
		return neverDuration
	}
	update(s.global.bucket.timeUntil(now, ticket.req.Cost))
	update(tenant.limit.bucket.timeUntil(now, ticket.req.Cost))
	if wait == neverDuration {
		return neverDuration
	}
	if wait < 0 {
		return 0
	}
	return wait
}

func (s *Scheduler) armLocked(now time.Time) {
	if s.closed {
		if s.timer != nil {
			s.timer.Stop()
			s.timer = nil
			s.timerDue = time.Time{}
		}
		return
	}
	wait, ok := s.nextWakeLocked(now)
	if !ok {
		if s.timer != nil {
			s.timer.Stop()
			s.timer = nil
			s.timerDue = time.Time{}
		}
		return
	}
	s.armWaitLocked(now, wait)
}

func (s *Scheduler) armTicketLocked(now time.Time, tenant *tenantState, ticket *Ticket) {
	wait := s.ticketWaitLocked(tenant, ticket, now)
	if wait == neverDuration {
		return
	}
	s.armWaitLocked(now, wait)
}

func (s *Scheduler) armWaitLocked(now time.Time, wait time.Duration) {
	due := now.Add(wait)
	if s.timer != nil && !s.timerDue.IsZero() && !s.timerDue.After(due) {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timerSeq++
	seq := s.timerSeq
	s.timer = s.clock.AfterFunc(wait, func() { s.onTimer(seq) })
	s.timerDue = due
}

func (s *Scheduler) onTimer(seq uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if seq != s.timerSeq {
		return
	}
	s.timer = nil
	s.timerDue = time.Time{}
	if s.closed {
		return
	}
	now := s.clock.Now()
	s.dispatchLocked(now)
	s.armLocked(now)
}

func (s *Scheduler) cancelTicket(ticket *Ticket) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ticket.terminal {
		return false
	}
	tenant := s.tenants[ticket.req.Tenant]
	if tenant == nil {
		return false
	}
	for i, candidate := range tenant.queue {
		if candidate != ticket {
			continue
		}
		tenant.queue = append(tenant.queue[:i], tenant.queue[i+1:]...)
		s.pending--
		ticket.terminal = true
		ticket.err = ErrTicketCanceled
		close(ticket.done)
		now := s.clock.Now()
		s.dispatchLocked(now)
		s.armLocked(now)
		return true
	}
	return false
}

func (s *Scheduler) settle(reservation *Reservation, state ReservationState, retryAfter time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock.Now()
	if state != ReservationCommitted {
		reservation.global.bucket.restore(now, reservation.cost)
		reservation.tenantLimit.bucket.restore(now, reservation.cost)
		reservation.endpointLimit.bucket.restore(now, reservation.cost)
	}
	reservation.global.inFlight -= reservation.cost
	reservation.tenantLimit.inFlight -= reservation.cost
	reservation.endpointLimit.inFlight -= reservation.cost
	if state == ReservationFailed && retryAfter > 0 {
		reservation.endpointLimit.extendCooldown(now.Add(retryAfter))
	}
	if !s.closed && state != ReservationCommitted {
		s.dispatchLocked(now)
		s.armLocked(now)
	}
}

// Pending reports the number of queued, not-yet-admitted tickets.
func (s *Scheduler) Pending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending
}

// Close stops accepting work and releases queued tickets with
// ErrSchedulerClosed. Reservations already granted may still be settled.
func (s *Scheduler) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
		s.timerDue = time.Time{}
	}
	for _, tenant := range s.tenantList {
		for _, ticket := range tenant.queue {
			ticket.terminal = true
			ticket.err = ErrSchedulerClosed
			close(ticket.done)
		}
		tenant.queue = nil
	}
	s.pending = 0
}

// Ticket is a queued request. A Ticket must not be copied after submission.
type Ticket struct {
	s    *Scheduler
	req  Request
	done chan struct{}

	// Fields below are guarded by s.mu.
	terminal    bool
	reservation *Reservation
	err         error
}

// Request returns a copy of the submitted request.
func (t *Ticket) Request() Request { return t.req }

// Done is closed when the ticket is admitted, canceled, or closed.
func (t *Ticket) Done() <-chan struct{} { return t.done }

// Reservation returns the granted reservation, or nil if the ticket has not
// been admitted.
func (t *Ticket) Reservation() *Reservation {
	t.s.mu.Lock()
	defer t.s.mu.Unlock()
	return t.reservation
}

// Cancel removes a queued ticket. It returns false if the ticket was already
// admitted or settled.
func (t *Ticket) Cancel() bool { return t.s.cancelTicket(t) }

// Wait blocks until the ticket is admitted, canceled, closed, or ctx ends.
// Cancellation through ctx removes the ticket from the queue. If admission
// wins the race with cancellation, the reservation is returned.
func (t *Ticket) Wait(ctx context.Context) (*Reservation, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-t.done:
		return t.result()
	default:
	}
	select {
	case <-t.done:
		return t.result()
	case <-ctx.Done():
		if t.Cancel() {
			return nil, ctx.Err()
		}
		<-t.done
		return t.result()
	}
}

func (t *Ticket) result() (*Reservation, error) {
	t.s.mu.Lock()
	defer t.s.mu.Unlock()
	return t.reservation, t.err
}

// ReservationState records how a granted reservation was settled.
type ReservationState uint32

const (
	ReservationPending ReservationState = iota
	ReservationCommitted
	ReservationFailed
	ReservationCancelled
)

func (s ReservationState) String() string {
	switch s {
	case ReservationPending:
		return "pending"
	case ReservationCommitted:
		return "committed"
	case ReservationFailed:
		return "failed"
	case ReservationCancelled:
		return "cancelled"
	default:
		return "unknown"
	}
}

// Reservation is a token grant. Exactly one of Commit, Fail, or Cancel wins;
// repeated or racing settlement calls return false and change nothing. A
// Reservation must not be copied after it is granted.
type Reservation struct {
	s          *Scheduler
	tenantID   string
	endpointID string
	cost       float64
	admittedAt time.Time

	global        *limitState
	tenantLimit   *limitState
	endpointLimit *limitState
	state         atomic.Uint32
}

// Tenant reports the tenant that owns the reservation.
func (r *Reservation) Tenant() string { return r.tenantID }

// Endpoint reports the endpoint of the reserved request.
func (r *Reservation) Endpoint() string { return r.endpointID }

// Cost reports the number of tokens reserved.
func (r *Reservation) Cost() float64 { return r.cost }

// AdmittedAt reports the virtual or wall-clock time of admission.
func (r *Reservation) AdmittedAt() time.Time { return r.admittedAt }

// State reports the current settlement state.
func (r *Reservation) State() ReservationState {
	return ReservationState(r.state.Load())
}

// Commit records a successful send. Tokens stay consumed.
func (r *Reservation) Commit() bool {
	return r.settle(ReservationCommitted, 0)
}

// Fail records a failed send, refunds its tokens, and applies retryAfter as an
// endpoint cooldown. The first settlement wins.
func (r *Reservation) Fail(retryAfter time.Duration) bool {
	if retryAfter < 0 {
		retryAfter = 0
	}
	return r.settle(ReservationFailed, retryAfter)
}

// Cancel records a canceled send and refunds its tokens. The first
// settlement wins.
func (r *Reservation) Cancel() bool {
	return r.settle(ReservationCancelled, 0)
}

func (r *Reservation) settle(state ReservationState, retryAfter time.Duration) bool {
	if !r.state.CompareAndSwap(uint32(ReservationPending), uint32(state)) {
		return false
	}
	r.s.settle(r, state, retryAfter)
	return true
}

// BucketSnapshot is an immutable view of one quota bucket.
type BucketSnapshot struct {
	Rate          float64
	Burst         float64
	Tokens        float64
	InFlight      float64
	CooldownUntil time.Time
}

// TenantSnapshot is a view of a tenant's bucket and weighted queue.
type TenantSnapshot struct {
	BucketSnapshot
	Weight      float64
	Pending     int
	VirtualTime float64
}

// Snapshot is a point-in-time view of all scheduler state.
type Snapshot struct {
	Now         time.Time
	Global      BucketSnapshot
	Tenants     map[string]TenantSnapshot
	Endpoints   map[string]BucketSnapshot
	Pending     int
	VirtualTime float64
}

// Snapshot returns a copy of current state, refilling buckets to the clock's
// current time first.
func (s *Scheduler) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	s.refillLocked(now)
	snapshot := Snapshot{
		Now:         now,
		Global:      snapshotLimit(&s.global),
		Tenants:     make(map[string]TenantSnapshot, len(s.tenants)),
		Endpoints:   make(map[string]BucketSnapshot, len(s.endpoints)),
		Pending:     s.pending,
		VirtualTime: s.virtualTime,
	}
	for id, tenant := range s.tenants {
		snapshot.Tenants[id] = TenantSnapshot{
			BucketSnapshot: snapshotLimit(&tenant.limit),
			Weight:         tenant.weight,
			Pending:        len(tenant.queue),
			VirtualTime:    tenant.vtime,
		}
	}
	for id, endpoint := range s.endpoints {
		snapshot.Endpoints[id] = snapshotLimit(&endpoint.limit)
	}
	return snapshot
}

func snapshotLimit(limit *limitState) BucketSnapshot {
	return BucketSnapshot{
		Rate:          limit.bucket.rate,
		Burst:         limit.bucket.burst,
		Tokens:        limit.bucket.tokens,
		InFlight:      limit.inFlight,
		CooldownUntil: limit.cooldownUntil,
	}
}
