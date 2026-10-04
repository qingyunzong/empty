// Package router routes reads to replicas that have applied at least a
// caller-confirmed sequence number, with an explicit stale-read escape
// hatch and honest timeout behaviour.
package router

import (
	"errors"
	"time"
)

var (
	// ErrTimeout is returned when no replica can serve a fresh read
	// before the request deadline. The router never fabricates a
	// successful result on timeout.
	ErrTimeout = errors.New("router: timed out waiting for a replica with applied sequence >= MinSeq")
	// ErrNoReplicas is returned when the router has no replicas.
	ErrNoReplicas = errors.New("router: no replicas configured")
)

// ReadRequest describes a single routed read.
type ReadRequest struct {
	Key string
	// MinSeq is the confirmed sequence number: only replicas whose
	// applied sequence is at least MinSeq may serve the read.
	MinSeq uint64
	// AllowStale permits a degraded read from a replica below MinSeq
	// once the deadline passes. The result is marked Stale and carries
	// the actual (older) version so the caller can see how old it is.
	AllowStale bool
	// Timeout bounds how long the router waits for a replica to catch
	// up to MinSeq. Zero means a single attempt.
	Timeout time.Duration
}

// ReadResult is the outcome of a routed read.
type ReadResult struct {
	Value string
	// Version is the sequence number at which Value was written; it is
	// provable against the serving replica's log.
	Version   uint64
	ReplicaID string
	// Stale is true when the read was served under AllowStale from a
	// replica whose applied sequence is below MinSeq.
	Stale bool
}

// Router routes reads across a set of replicas.
type Router struct {
	Replicas []Replica
	// Clock defaults to RealClock when nil.
	Clock Clock
	// PollInterval is how long the router waits between freshness
	// checks while replicas catch up. Defaults to 50ms.
	PollInterval time.Duration
}

// Read serves req, waiting up to req.Timeout for a replica fresh enough
// to honour req.MinSeq. It returns ErrTimeout rather than a fabricated
// success when no fresh replica appears in time.
func (rt *Router) Read(req ReadRequest) (ReadResult, error) {
	if len(rt.Replicas) == 0 {
		return ReadResult{}, ErrNoReplicas
	}
	clock := rt.Clock
	if clock == nil {
		clock = RealClock{}
	}
	poll := rt.PollInterval
	if poll <= 0 {
		poll = 50 * time.Millisecond
	}
	deadline := clock.Now().Add(req.Timeout)

	for {
		if res, ok := rt.tryFresh(req); ok {
			return res, nil
		}
		if !clock.Now().Before(deadline) {
			break
		}
		clock.Sleep(poll)
	}
	if req.AllowStale {
		if res, ok := rt.staleRead(req); ok {
			return res, nil
		}
	}
	return ReadResult{}, ErrTimeout
}

// tryFresh attempts one read from a replica whose applied sequence is
// at least req.MinSeq, re-verifying freshness after the read.
func (rt *Router) tryFresh(req ReadRequest) (ReadResult, bool) {
	for _, r := range rt.Replicas {
		if r.AppliedSeq() < req.MinSeq {
			continue
		}
		value, version, ok := r.Read(req.Key)
		if !ok {
			continue
		}
		// Re-verify after the read: the replica may have been revoked
		// between the freshness check and the read, in which case its
		// data no longer provably covers MinSeq.
		if r.AppliedSeq() < req.MinSeq {
			continue
		}
		return ReadResult{Value: value, Version: version, ReplicaID: r.ID()}, true
	}
	return ReadResult{}, false
}

// staleRead serves the key from the freshest replica regardless of
// MinSeq, marking the result Stale.
func (rt *Router) staleRead(req ReadRequest) (ReadResult, bool) {
	var best Replica
	var bestSeq uint64
	for _, r := range rt.Replicas {
		if best == nil || r.AppliedSeq() > bestSeq {
			best, bestSeq = r, r.AppliedSeq()
		}
	}
	if best == nil {
		return ReadResult{}, false
	}
	value, version, ok := best.Read(req.Key)
	if !ok {
		return ReadResult{}, false
	}
	return ReadResult{Value: value, Version: version, ReplicaID: best.ID(), Stale: true}, true
}
