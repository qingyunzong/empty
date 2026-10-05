// Package idem provides an idempotent request execution library.
//
// Idempotency keys carry a client generation and a per-generation sequence
// number. Duplicate requests return the original recorded decision instead of
// re-executing. Keys at or below the reclamation watermark are rejected with
// ErrReclaimed rather than re-executed. The watermark advances only when the
// client explicitly acknowledges completed sequences.
//
// Decision records and business effects commit atomically through a
// write-ahead log: after a crash between the cache record and the business
// commit, recovery exposes either both or neither.
package idem

import (
	"errors"
	"fmt"
)

// Key identifies a request idempotently. Gen is the client generation
// (epoch); Seq is a strictly client-managed sequence number within Gen.
type Key struct {
	Client string
	Gen    uint64
	Seq    uint64
}

// Decision is the recorded outcome of executing a request once.
type Decision struct {
	Key    Key
	Output []byte
}

var (
	// ErrReclaimed is returned for keys at or below the reclamation
	// watermark. The original decision has been reclaimed and the request
	// is NOT re-executed.
	ErrReclaimed = errors.New("idem: key at or below reclamation watermark")
	// ErrStaleGeneration is returned when a request carries a generation
	// older than the client's current generation.
	ErrStaleGeneration = errors.New("idem: stale client generation")
	// ErrCrashed is returned by any operation on an executor that has
	// suffered an injected crash; reopen from disk to recover.
	ErrCrashed = errors.New("idem: executor crashed, reopen required")
	// ErrInjectedCrash is returned when an armed crash hook fires.
	ErrInjectedCrash = errors.New("idem: injected crash")
)

// CrashPoint identifies a fault-injection point inside the atomic commit.
type CrashPoint string

const (
	// PointAfterDecisionRecord is after the idempotency (cache) record is
	// written to the WAL but before any business effect is written.
	PointAfterDecisionRecord CrashPoint = "after-decision-record"
	// PointAfterBusinessEffects is after business effects are written to
	// the WAL but before the commit marker.
	PointAfterBusinessEffects CrashPoint = "after-business-effects"
	// PointAfterCommit is after the commit marker is durable but before
	// the transaction is applied to in-memory state.
	PointAfterCommit CrashPoint = "after-commit"
)

// Tx stages business effects that commit atomically with the decision
// record. Effects are applied only if the surrounding request commits.
type Tx struct {
	effects []Effect
}

// Effect is one staged business mutation (a key/value put into the
// business table).
type Effect struct {
	K string `json:"k"`
	V string `json:"v"`
}

// Put stages a business-table write.
func (t *Tx) Put(k, v string) {
	t.effects = append(t.effects, Effect{K: k, V: v})
}

// BusinessFunc implements the request's business logic. Its staged Tx
// effects and its returned output commit atomically: the output becomes
// the recorded decision returned to duplicates.
type BusinessFunc func(tx *Tx) ([]byte, error)

// Executor executes requests idempotently with atomic, durable commits.
type Executor struct {
	s *store
}

// Open opens (or creates) an executor rooted at dir, replaying its WAL.
// Incomplete transactions torn by a crash are discarded; committed ones
// are replayed, so a decision record and its business effects are either
// both visible or both absent.
func Open(dir string) (*Executor, error) {
	s, err := openStore(dir)
	if err != nil {
		return nil, err
	}
	return &Executor{s: s}, nil
}

// SetCrashHook installs a fault-injection hook invoked at each CrashPoint
// during commit. If the hook returns an error, the commit aborts
// immediately (simulating power loss) and the executor becomes unusable.
func (e *Executor) SetCrashHook(h func(CrashPoint) error) {
	e.s.setCrashHook(h)
}

// Do executes fn exactly once for key. A duplicate key returns the
// original recorded decision without re-executing fn. A key at or below
// the reclamation watermark fails with ErrReclaimed and fn is not run.
func (e *Executor) Do(key Key, fn BusinessFunc) (Decision, error) {
	if err := e.s.checkLive(); err != nil {
		return Decision{}, err
	}
	e.s.mu.Lock()
	defer e.s.mu.Unlock()

	if err := e.s.checkLiveLocked(); err != nil {
		return Decision{}, err
	}

	// Duplicate: return the original decision, never re-execute.
	if d, ok := e.s.records[key]; ok {
		return cloneDecision(d), nil
	}

	// Stale generation: reject outright.
	if gen := e.s.generations[key.Client]; gen != 0 && key.Gen < gen {
		return Decision{}, fmt.Errorf("%w: client %q gen %d < current %d",
			ErrStaleGeneration, key.Client, key.Gen, gen)
	}

	// Below/at watermark: reclaimed, do NOT re-execute.
	if key.Seq <= e.s.watermarks[clientGen{client: key.Client, gen: key.Gen}] {
		return Decision{}, fmt.Errorf("%w: client %q gen %d seq %d",
			ErrReclaimed, key.Client, key.Gen, key.Seq)
	}

	tx := &Tx{}
	out, err := fn(tx)
	if err != nil {
		return Decision{}, err
	}

	d := Decision{Key: key, Output: out}
	if err := e.s.commit(d, tx.effects); err != nil {
		return Decision{}, err
	}
	return cloneDecision(d), nil
}

// Ack acknowledges completion of seq for (client, gen) and advances the
// reclamation watermark. The watermark moves only through Ack; records at
// or below it are reclaimed. Ack is monotonic: lower seqs are no-ops.
func (e *Executor) Ack(client string, gen, seq uint64) error {
	if err := e.s.checkLive(); err != nil {
		return err
	}
	e.s.mu.Lock()
	defer e.s.mu.Unlock()
	if err := e.s.checkLiveLocked(); err != nil {
		return err
	}
	return e.s.ack(clientGen{client: client, gen: gen}, seq)
}

// Watermark returns the current reclamation watermark for (client, gen).
func (e *Executor) Watermark(client string, gen uint64) uint64 {
	e.s.mu.Lock()
	defer e.s.mu.Unlock()
	return e.s.watermarks[clientGen{client: client, gen: gen}]
}

// Lookup returns the recorded decision for key, if one is retained.
func (e *Executor) Lookup(key Key) (Decision, bool) {
	e.s.mu.Lock()
	defer e.s.mu.Unlock()
	d, ok := e.s.records[key]
	return cloneDecision(d), ok
}

// BusinessGet reads the business table (post-commit state).
func (e *Executor) BusinessGet(k string) (string, bool) {
	e.s.mu.Lock()
	defer e.s.mu.Unlock()
	v, ok := e.s.business[k]
	return v, ok
}

// Close flushes and closes the executor.
func (e *Executor) Close() error { return e.s.close() }

func cloneDecision(d Decision) Decision {
	if d.Output != nil {
		out := make([]byte, len(d.Output))
		copy(out, d.Output)
		d.Output = out
	}
	return d
}
