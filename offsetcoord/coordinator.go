// Package offsetcoord provides a checkpoint coordination library for message
// client consume loops.
//
// A Coordinator tracks the committed offset of every partition. Commits are
// ordered (an offset may never move backwards within a generation), resets by
// timestamp start a new generation, and every state transition is published
// atomically under a single mutex, so concurrent consumers always observe a
// consistent (generation, offset) pair.
//
// Generation fencing makes resets safe in the presence of in-flight work: a
// commit carries the generation of the consumer that produced it, and the
// coordinator only accepts commits whose generation matches the partition's
// current generation. A reset bumps the generation, so every late commit from
// the displaced generation is rejected and can never roll the visible offset
// backwards after the reset.
package offsetcoord

import (
	"context"
	"errors"
	"sync"
)

// Partition identifies a partition of a topic the consume loop is tracking.
type Partition string

// Generation identifies a consumer generation. Every successful reset starts a
// new generation with a strictly higher value.
type Generation uint64

// Offset is a partition checkpoint value.
type Offset uint64

// TimestampMs is an epoch millisecond used to resolve a reset position.
type TimestampMs int64

// CommitStatus reports the outcome of a commit attempt.
type CommitStatus int

const (
	// CommitAccepted advances the partition offset to the requested value.
	CommitAccepted CommitStatus = iota
	// CommitStaleGeneration rejects a commit whose generation no longer
	// matches the partition's current generation, typically an in-flight
	// receipt from a consumer displaced by a reset.
	CommitStaleGeneration
	// CommitRegressed rejects an offset below the committed one. Within a
	// generation checkpoints only move forward.
	CommitRegressed
)

// String returns a stable diagnostic name for the status.
func (s CommitStatus) String() string {
	switch s {
	case CommitAccepted:
		return "accepted"
	case CommitStaleGeneration:
		return "stale-generation"
	case CommitRegressed:
		return "regressed"
	default:
		return "unknown"
	}
}

// EventKind classifies a coordinator state transition.
type EventKind int

const (
	// EventCommitted marks an accepted offset commit.
	EventCommitted EventKind = iota
	// EventCommitRejected marks a rejected commit attempt; Offset stays 0.
	EventCommitRejected
	// EventReset marks an accepted reset that bumped the generation.
	EventReset
	// EventResetFailed marks a reset that did not change any state.
	EventResetFailed
)

// String returns a stable diagnostic name for the event kind.
func (k EventKind) String() string {
	switch k {
	case EventCommitted:
		return "committed"
	case EventCommitRejected:
		return "commit-rejected"
	case EventReset:
		return "reset"
	case EventResetFailed:
		return "reset-failed"
	default:
		return "unknown"
	}
}

// Event is one atomic state transition of a partition. An EventHook receives
// every event synchronously while the coordinator lock is held, so a hook must
// be non-blocking and must never call back into the coordinator.
type Event struct {
	Kind       EventKind
	Partition  Partition
	Generation Generation
	Offset     Offset
	Timestamp  TimestampMs
	Status     CommitStatus
}

// EventHook observes coordinator state transitions.
type EventHook func(Event)

// OffsetResolver maps a timestamp to the earliest offset whose record has a
// timestamp at or after the requested one. Implementations must be safe for
// concurrent use.
type OffsetResolver interface {
	ResolveOffset(ctx context.Context, partition Partition, timestamp TimestampMs) (Offset, error)
}

// OffsetResolverFunc adapts a plain function to the OffsetResolver interface.
type OffsetResolverFunc func(ctx context.Context, partition Partition, timestamp TimestampMs) (Offset, error)

// ResolveOffset calls the wrapped function.
func (f OffsetResolverFunc) ResolveOffset(ctx context.Context, partition Partition, timestamp TimestampMs) (Offset, error) {
	return f(ctx, partition, timestamp)
}

// Position is an immutable checkpoint snapshot for one partition.
type Position struct {
	Generation Generation
	Offset     Offset
}

// CommitResult reports a commit attempt and the position that remained visible
// afterwards. Offset is zero when the commit was rejected.
type CommitResult struct {
	Status   CommitStatus
	Position Position
}

// Coordinator coordinates partition offsets for consume loops. It is safe for
// concurrent use: all reads and writes are serialized so every published
// (generation, offset) pair is atomically visible.
type Coordinator struct {
	mu      sync.RWMutex
	offsets map[Partition]Position
	hook    EventHook
}

// Option configures a Coordinator at construction time.
type Option func(*Coordinator)

// WithEventHook installs a hook that observes every state transition.
func WithEventHook(hook EventHook) Option {
	return func(c *Coordinator) { c.hook = hook }
}

// New creates a Coordinator. Partitions start unseen in generation zero with no
// committed offset and are materialized lazily by their first accepted commit
// or reset.
func New(opts ...Option) *Coordinator {
	c := &Coordinator{offsets: make(map[Partition]Position)}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// Commit applies a commit receipt for partition.
//
// A commit is accepted only when its generation matches the partition's
// current generation and its offset is not below the committed offset. An
// offset equal to the committed one is a no-op and still reports
// CommitAccepted, making duplicate receipts idempotent. Stale-generation and
// regressing receipts are rejected without mutating any state.
func (c *Coordinator) Commit(partition Partition, generation Generation, offset Offset) CommitResult {
	c.mu.Lock()
	defer c.mu.Unlock()

	current, seen := c.offsets[partition]
	switch {
	case seen && generation != current.Generation:
		c.emit(Event{
			Kind:       EventCommitRejected,
			Partition:  partition,
			Generation: generation,
			Timestamp:  0,
			Status:     CommitStaleGeneration,
		})
		return CommitResult{Status: CommitStaleGeneration, Position: current}
	case seen && offset < current.Offset:
		c.emit(Event{
			Kind:       EventCommitRejected,
			Partition:  partition,
			Generation: generation,
			Timestamp:  0,
			Status:     CommitRegressed,
		})
		return CommitResult{Status: CommitRegressed, Position: current}
	}

	next := Position{Generation: generation, Offset: offset}
	c.offsets[partition] = next
	c.emit(Event{
		Kind:       EventCommitted,
		Partition:  partition,
		Generation: generation,
		Offset:     offset,
	})
	return CommitResult{Status: CommitAccepted, Position: next}
}

// Reset resolves timestamp to an offset for partition and moves the partition
// to a new generation starting at that offset. Only consumers observing the
// returned generation can commit afterwards; receipts from earlier generations
// are fenced off.
//
// The resolver runs without holding the coordinator lock so a slow broker
// lookup never blocks commits on other partitions. A resolver or context
// error leaves all state untouched.
func (c *Coordinator) Reset(ctx context.Context, partition Partition, timestamp TimestampMs, resolver OffsetResolver) (Position, error) {
	if resolver == nil {
		return Position{}, errors.New("offsetcoord: reset requires a non-nil OffsetResolver")
	}
	offset, err := resolver.ResolveOffset(ctx, partition, timestamp)
	if err != nil {
		c.mu.Lock()
		c.emit(Event{
			Kind:      EventResetFailed,
			Partition: partition,
			Timestamp: timestamp,
		})
		c.mu.Unlock()
		return Position{}, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	nextGeneration := c.offsets[partition].Generation + 1
	next := Position{Generation: nextGeneration, Offset: offset}
	c.offsets[partition] = next
	c.emit(Event{
		Kind:       EventReset,
		Partition:  partition,
		Generation: nextGeneration,
		Offset:     offset,
		Timestamp:  timestamp,
	})
	return next, nil
}

// PositionOf returns the visible position of partition and whether it has ever
// been materialized. A zero Position with ok == false means no commit or reset
// has been accepted yet.
func (c *Coordinator) PositionOf(partition Partition) (Position, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	position, ok := c.offsets[partition]
	return position, ok
}

// Snapshot returns an atomic, owned copy of every tracked partition position.
// Callers may mutate the returned map freely.
func (c *Coordinator) Snapshot() map[Partition]Position {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snapshot := make(map[Partition]Position, len(c.offsets))
	for partition, position := range c.offsets {
		snapshot[partition] = position
	}
	return snapshot
}

func (c *Coordinator) emit(event Event) {
	if c.hook != nil {
		c.hook(event)
	}
}
