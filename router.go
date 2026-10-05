// Package readroute routes read requests to replicas that have applied at
// least a caller-supplied confirmed sequence number. A read is only served
// from a replica whose applied sequence is >= the requested one, unless the
// caller explicitly opts into degraded stale reads. Timeouts are reported as
// errors and never masquerade as successful reads.
package readroute

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Seq is a monotonically increasing log/apply sequence number.
type Seq uint64

// ErrTimeout is returned when no replica reaches the requested confirmed
// sequence before the router's timeout elapses. A timed-out read never
// returns a value.
var ErrTimeout = errors.New("readroute: timed out waiting for a replica at the confirmed sequence")

// ErrKeyNotFound is returned by replicas when the key does not exist.
var ErrKeyNotFound = errors.New("readroute: key not found")

// VersionedValue is a value together with the sequence at which it was
// written, so callers can verify which version they observed.
type VersionedValue struct {
	Value []byte
	Seq   Seq
}

// Replica is a single serving replica.
type Replica interface {
	ID() string
	// AppliedSeq reports the highest sequence the replica has applied.
	AppliedSeq() Seq
	// Read returns the value for key and the sequence at which it was written.
	Read(ctx context.Context, key string) (VersionedValue, error)
}

// Request describes one routed read.
type Request struct {
	Key string
	// MinSeq is the confirmed sequence the caller depends on; the read is
	// only served from replicas whose applied sequence is >= MinSeq.
	MinSeq Seq
	// AllowStale explicitly permits a degraded read from a replica that has
	// not yet reached MinSeq. The result is then marked Stale.
	AllowStale bool
}

// Result is the outcome of a routed read.
type Result struct {
	Value     []byte
	Seq       Seq // version of the returned value
	ReplicaID string
	// Stale is true when the value's version is below Request.MinSeq, which
	// can only happen when Request.AllowStale was set.
	Stale bool
}

// Router routes reads to sufficiently fresh replicas.
type Router struct {
	clock        Clock
	timeout      time.Duration
	pollInterval time.Duration

	mu       sync.RWMutex
	replicas map[string]Replica
	changed  chan struct{}
}

// Option configures a Router.
type Option func(*Router)

// WithClock sets the clock used for timeouts and polling (default: real time).
func WithClock(c Clock) Option { return func(r *Router) { r.clock = c } }

// WithTimeout bounds how long Read waits for a fresh replica (default 5s).
func WithTimeout(d time.Duration) Option { return func(r *Router) { r.timeout = d } }

// WithPollInterval sets how often replicas are re-examined while waiting
// (default 50ms). Updates also wake the read immediately via NotifyUpdate.
func WithPollInterval(d time.Duration) Option { return func(r *Router) { r.pollInterval = d } }

func NewRouter(opts ...Option) *Router {
	r := &Router{
		clock:        RealClock{},
		timeout:      5 * time.Second,
		pollInterval: 50 * time.Millisecond,
		replicas:     make(map[string]Replica),
		changed:      make(chan struct{}, 1),
	}
	for _, o := range opts {
		o(r)
	}
	return r
}

// Register adds a replica to the routing table.
func (r *Router) Register(rep Replica) {
	r.mu.Lock()
	r.replicas[rep.ID()] = rep
	r.mu.Unlock()
	r.NotifyUpdate()
}

// Unregister revokes a replica: it is removed from the routing table and is
// never selected for subsequent read attempts.
func (r *Router) Unregister(id string) {
	r.mu.Lock()
	delete(r.replicas, id)
	r.mu.Unlock()
	r.NotifyUpdate()
}

// NotifyUpdate wakes pending reads so they re-examine replica freshness,
// e.g. after a replica applied more entries.
func (r *Router) NotifyUpdate() {
	select {
	case r.changed <- struct{}{}:
	default:
	}
}

func (r *Router) snapshot() []Replica {
	r.mu.RLock()
	defer r.mu.RUnlock()
	reps := make([]Replica, 0, len(r.replicas))
	for _, rep := range r.replicas {
		reps = append(reps, rep)
	}
	sort.Slice(reps, func(i, j int) bool { return reps[i].ID() < reps[j].ID() })
	return reps
}

// freshest returns the replica with the highest applied sequence, or nil.
func freshest(reps []Replica) Replica {
	var best Replica
	for _, rep := range reps {
		if best == nil || rep.AppliedSeq() > best.AppliedSeq() {
			best = rep
		}
	}
	return best
}

// Read serves req, blocking until a replica at or beyond req.MinSeq answers,
// the request is degraded via AllowStale, or the timeout/context expires.
// A read that cannot be verified never returns a value: it ends in an error.
func (r *Router) Read(ctx context.Context, req Request) (Result, error) {
	if req.Key == "" {
		return Result{}, errors.New("readroute: empty key")
	}
	timer := r.clock.After(r.timeout)
	for {
		reps := r.snapshot()

		var fresh []Replica
		for _, rep := range reps {
			if rep.AppliedSeq() >= req.MinSeq {
				fresh = append(fresh, rep)
			}
		}
		if len(fresh) > 0 {
			rep := freshest(fresh)
			v, err := rep.Read(ctx, req.Key)
			if err != nil {
				return Result{}, fmt.Errorf("readroute: replica %s: %w", rep.ID(), err)
			}
			if v.Seq >= req.MinSeq {
				// Provably fresh: the value's own version satisfies the request.
				return Result{Value: v.Value, Seq: v.Seq, ReplicaID: rep.ID()}, nil
			}
			// The replica's applied sequence regressed or it served an older
			// version; do not pass this off as a fresh read.
		}

		if req.AllowStale {
			if rep := freshest(reps); rep != nil {
				v, err := rep.Read(ctx, req.Key)
				if err != nil {
					return Result{}, fmt.Errorf("readroute: replica %s: %w", rep.ID(), err)
				}
				return Result{
					Value:     v.Value,
					Seq:       v.Seq,
					ReplicaID: rep.ID(),
					Stale:     v.Seq < req.MinSeq,
				}, nil
			}
		}

		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-timer:
			return Result{}, ErrTimeout
		case <-r.changed:
		case <-r.clock.After(r.pollInterval):
		}
	}
}
