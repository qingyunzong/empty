// Package shardsim simulates a sharded consumer with generation-based
// assignment. Revoking a holder drains its in-flight callbacks before the
// shard is granted to a new holder, and acknowledgements from a stale
// generation never advance the live cursor.
package shardsim

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

var (
	// ErrNoHolder is returned by Deliver when the shard has no holder.
	ErrNoHolder = errors.New("shardsim: shard has no holder")
	// ErrRevoking is returned by Deliver while the shard is draining its
	// previous holder; the caller should retry after reassignment.
	ErrRevoking = errors.New("shardsim: shard assignment is draining")
)

// Record is a single unit of work delivered to a shard holder.
type Record struct {
	Offset  int64
	Payload string
}

// Callback is the holder-side contract. OnRecord reports whether the record
// is acknowledged. OnRevoked fires only after every in-flight OnRecord of the
// revoked generation has returned, and always before the next OnAssigned.
type Callback interface {
	OnAssigned(shard int, generation uint64)
	OnRecord(shard int, generation uint64, rec Record) (ack bool)
	OnRevoked(shard int, generation uint64)
}

// Outcome classifies a finished delivery in the per-shard ledger.
type Outcome int

const (
	// Acked: the holder acknowledged and the ack advanced the live cursor.
	Acked Outcome = iota
	// Dropped: the holder declined to acknowledge.
	Dropped
	// StaleAck: the holder acknowledged, but its generation had already been
	// revoked, so the ack must not advance the new generation's cursor.
	StaleAck
)

func (o Outcome) String() string {
	switch o {
	case Acked:
		return "acked"
	case Dropped:
		return "dropped"
	case StaleAck:
		return "stale-ack"
	}
	return "unknown"
}

// Entry is one line of a shard's delivery ledger.
type Entry struct {
	Offset     int64
	Generation uint64
	Outcome    Outcome
}

type shardState struct {
	generation uint64
	holder     Callback
	inflight   int
	revoking   bool
	cursor     int64
	hasCursor  bool
	ledger     []Entry
}

// Coordinator owns shard assignments, delivery, cursors and ledgers.
type Coordinator struct {
	mu       sync.Mutex
	cond     sync.Cond
	assignMu sync.Mutex // serializes Assign/Cancel so revoke precedes grant
	shards   map[int]*shardState
}

// NewCoordinator returns an empty coordinator.
func NewCoordinator() *Coordinator {
	c := &Coordinator{shards: make(map[int]*shardState)}
	c.cond.L = &c.mu
	return c
}

func (c *Coordinator) stateLocked(shard int) *shardState {
	st, ok := c.shards[shard]
	if !ok {
		st = &shardState{}
		c.shards[shard] = st
	}
	return st
}

// Assign grants the shard to cb. Any current holder is revoked first: its
// generation is invalidated immediately (so late acks are stale), the call
// then blocks until that holder's in-flight callbacks have all returned, and
// only then is the shard granted — OnRevoked (old generation) always fires
// before OnAssigned (new generation). A nil cb simply cancels the assignment.
func (c *Coordinator) Assign(shard int, cb Callback) {
	c.assignMu.Lock()
	defer c.assignMu.Unlock()

	c.mu.Lock()
	st := c.stateLocked(shard)
	for st.revoking {
		c.cond.Wait()
	}
	st.revoking = true
	old, oldGen := st.holder, st.generation
	st.holder = nil
	st.generation++ // revoke: the old generation is stale from here on
	newGen := st.generation
	for st.inflight > 0 {
		c.cond.Wait()
	}
	st.holder = cb
	st.revoking = false
	c.cond.Broadcast()
	c.mu.Unlock()

	if old != nil {
		old.OnRevoked(shard, oldGen)
	}
	if cb != nil {
		cb.OnAssigned(shard, newGen)
	}
}

// Cancel revokes the shard's holder after draining in-flight callbacks and
// leaves the shard unassigned.
func (c *Coordinator) Cancel(shard int) {
	c.Assign(shard, nil)
}

// Deliver hands rec to the shard's current holder. The ack is applied to the
// cursor only if the delivering generation is still the live one.
func (c *Coordinator) Deliver(shard int, rec Record) error {
	c.mu.Lock()
	st := c.stateLocked(shard)
	if st.revoking {
		c.mu.Unlock()
		return ErrRevoking
	}
	cb, gen := st.holder, st.generation
	if cb == nil {
		c.mu.Unlock()
		return ErrNoHolder
	}
	st.inflight++
	c.mu.Unlock()

	ack := cb.OnRecord(shard, gen, rec)

	c.mu.Lock()
	defer c.mu.Unlock()
	st.inflight--
	outcome := Dropped
	if ack {
		if gen == st.generation {
			outcome = Acked
			if !st.hasCursor || rec.Offset > st.cursor {
				st.cursor = rec.Offset
				st.hasCursor = true
			}
		} else {
			outcome = StaleAck
		}
	}
	st.ledger = append(st.ledger, Entry{Offset: rec.Offset, Generation: gen, Outcome: outcome})
	c.cond.Broadcast()
	return nil
}

// Cursor returns the shard's committed offset for the live generation.
func (c *Coordinator) Cursor(shard int) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.stateLocked(shard)
	return st.cursor, st.hasCursor
}

// Generation returns the shard's current assignment generation.
func (c *Coordinator) Generation(shard int) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stateLocked(shard).generation
}

// Ledger returns a copy of the shard's delivery ledger in delivery order.
func (c *Coordinator) Ledger(shard int) []Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.stateLocked(shard)
	out := make([]Entry, len(st.ledger))
	copy(out, st.ledger)
	return out
}

// Report renders every shard's delivery ledger, ordered by shard id.
func (c *Coordinator) Report() string {
	c.mu.Lock()
	ids := make([]int, 0, len(c.shards))
	for id := range c.shards {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	var b strings.Builder
	for _, id := range ids {
		st := c.shards[id]
		cursor := "none"
		if st.hasCursor {
			cursor = fmt.Sprintf("%d", st.cursor)
		}
		fmt.Fprintf(&b, "shard %d generation=%d cursor=%s inflight=%d\n", id, st.generation, cursor, st.inflight)
		for _, e := range st.ledger {
			fmt.Fprintf(&b, "  offset=%d gen=%d %s\n", e.Offset, e.Generation, e.Outcome)
		}
	}
	c.mu.Unlock()
	return b.String()
}
