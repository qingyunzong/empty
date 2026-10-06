// Package shardmig migrates key ranges between shards with epoch fencing
// and idempotent message processing.
//
// During a migration the old shard keeps owning the route and forwards
// messages for the migrating range to the new shard. The new shard is
// promoted to a new generation (epoch) and only commits messages stamped
// with that generation; older generations are fenced. Processed message
// IDs migrate together with the key range, so a delivery retried after
// the move is still deduplicated and every discrete message produces a
// single business effect. All state transfers are atomic under the shard
// locks, so an interrupted acceptance never leaves partial state.
package shardmig

import (
	"errors"
	"fmt"
	"sync"
)

var (
	// ErrStaleEpoch is returned when a message carries an epoch older
	// than the committing shard's current generation.
	ErrStaleEpoch = errors.New("shardmig: commit fenced by epoch")
	// ErrNoRoute is returned when no shard owns the message key.
	ErrNoRoute = errors.New("shardmig: no route for key")
	// ErrOverlap is returned when a route range overlaps an existing one.
	ErrOverlap = errors.New("shardmig: range overlaps existing route")
	// ErrNotMigrating is returned when completing a range that is not
	// migrating out of the expected shard.
	ErrNotMigrating = errors.New("shardmig: range is not migrating")
)

// Range is a half-open key interval [Lo, Hi). The boundary key Lo belongs
// to this, the right, interval; Hi belongs to the next interval to the
// right. An empty Hi means unbounded above.
type Range struct {
	Lo, Hi string
}

// Contains reports whether key falls in [Lo, Hi).
func (r Range) Contains(key string) bool {
	return key >= r.Lo && (r.Hi == "" || key < r.Hi)
}

func (r Range) empty() bool {
	return r.Hi != "" && r.Lo >= r.Hi
}

// containsRange reports whether inner is fully covered by outer.
func containsRange(outer, inner Range) bool {
	if inner.Lo < outer.Lo {
		return false
	}
	if outer.Hi == "" {
		return true
	}
	return inner.Hi != "" && inner.Hi <= outer.Hi
}

func overlaps(a, b Range) bool {
	aBeforeB := a.Hi != "" && a.Hi <= b.Lo
	bBeforeA := b.Hi != "" && b.Hi <= a.Lo
	return !aBeforeB && !bBeforeA
}

// Message is a discrete unit of work. ID is the idempotency key: a message
// delivered more than once is acknowledged but applied exactly once.
type Message struct {
	ID    string
	Key   string
	Value string
	Epoch uint64
}

// Shard owns key ranges and commits messages. Effects and their processed
// IDs are recorded atomically under the shard lock.
type Shard struct {
	mu        sync.Mutex
	id        string
	epoch     uint64
	data      map[string]string
	processed map[string]string // message ID -> key, migrates with the data
	forwards  []forward
}

type forward struct {
	rng Range
	dst *Shard
}

// NewShard returns an empty shard at the given generation.
func NewShard(id string, epoch uint64) *Shard {
	return &Shard{
		id:        id,
		epoch:     epoch,
		data:      map[string]string{},
		processed: map[string]string{},
	}
}

// ID returns the shard identifier.
func (s *Shard) ID() string { return s.id }

// Epoch returns the shard's current generation.
func (s *Shard) Epoch() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.epoch
}

// Get returns the committed value for key.
func (s *Shard) Get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}

// Processed reports whether id has already been applied on this shard.
func (s *Shard) Processed(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.processed[id]
	return ok
}

// apply commits a message. If the key falls in a migrating-out range the
// message is forwarded to the new shard, which enforces the new generation:
// only messages stamped with the current epoch commit, older epochs are
// fenced. Duplicate IDs are acknowledged without re-applying the effect.
func (s *Shard) apply(m Message) error {
	s.mu.Lock()
	for _, f := range s.forwards {
		if f.rng.Contains(m.Key) {
			dst := f.dst
			s.mu.Unlock()
			return dst.apply(m)
		}
	}
	defer s.mu.Unlock()
	if m.Epoch != s.epoch {
		return fmt.Errorf("%w: shard %q at epoch %d, message epoch %d",
			ErrStaleEpoch, s.id, s.epoch, m.Epoch)
	}
	if _, dup := s.processed[m.ID]; dup {
		return nil
	}
	s.data[m.Key] = m.Value
	s.processed[m.ID] = m.Key
	return nil
}

// transfer atomically moves data and processed IDs for rng between shards.
// Both shard locks must be held.
func transfer(from, to *Shard, rng Range) {
	for k, v := range from.data {
		if rng.Contains(k) {
			to.data[k] = v
			delete(from.data, k)
		}
	}
	for id, k := range from.processed {
		if rng.Contains(k) {
			to.processed[id] = k
			delete(from.processed, id)
		}
	}
}

func removeForward(fs []forward, rng Range, dst *Shard) []forward {
	out := fs[:0]
	for _, f := range fs {
		if f.rng == rng && f.dst == dst {
			continue
		}
		out = append(out, f)
	}
	return out
}

// hasForward reports whether src forwards rng to dst. src lock must be held.
func (s *Shard) hasForward(rng Range, dst *Shard) bool {
	for _, f := range s.forwards {
		if f.rng == rng && f.dst == dst {
			return true
		}
	}
	return false
}
