// Package sim implements a consumption simulator that assigns shards to
// holders by generation. Revoking a holder waits for its in-flight
// callbacks to drain before a new generation is granted, and acks from
// stale generations can never advance the current generation's cursor.
package sim

import (
	"fmt"
	"sync"
)

// EventKind enumerates the lifecycle events a Simulator emits.
type EventKind int

const (
	EventAssigned  EventKind = iota // a generation was granted to a holder
	EventRevoked                    // the current holder was revoked
	EventDrained                    // all in-flight callbacks of the revoked generation finished
	EventCancelled                  // a shard was cancelled (revoked + drained, no successor)
	EventStaleAck                   // an ack from a stale generation/holder was rejected
	EventAcked                      // an ack advanced the current generation's cursor
)

func (k EventKind) String() string {
	switch k {
	case EventAssigned:
		return "assigned"
	case EventRevoked:
		return "revoked"
	case EventDrained:
		return "drained"
	case EventCancelled:
		return "cancelled"
	case EventStaleAck:
		return "stale-ack"
	case EventAcked:
		return "acked"
	}
	return "unknown"
}

// Event is a single entry in the simulator's event stream.
type Event struct {
	Kind       EventKind
	Shard      int
	Generation uint64
	Holder     string
	Offset     int64 // meaningful for EventAcked / EventStaleAck
}

func (e Event) String() string {
	return fmt.Sprintf("%s shard=%d gen=%d holder=%q offset=%d",
		e.Kind, e.Shard, e.Generation, e.Holder, e.Offset)
}

// Delivery is the unit of work handed to a holder's callback.
type Delivery struct {
	Shard      int
	Generation uint64
	Holder     string
	Offset     int64
	Payload    string
}

// LedgerEntry is one line of a shard's delivery ledger.
type LedgerEntry struct {
	Delivery
	Acked bool
}

// Callback processes a delivery. It runs outside the simulator lock and
// counts as in-flight until it returns.
type Callback func(Delivery)

type shardState struct {
	holder     string
	generation uint64
	active     bool
	inflight   int
	cursor     int64
	ledger     []LedgerEntry
}

// Simulator assigns shards to holders by generation and tracks delivery.
type Simulator struct {
	mu       sync.Mutex
	cond     *sync.Cond
	shards   []*shardState
	callback Callback
	listener func(Event)
}

// New creates a Simulator with shardCount shards. cb is invoked for every
// delivery; listener (may be nil) observes every lifecycle event. The
// listener is called under the simulator lock and must not re-enter it.
func New(shardCount int, cb Callback, listener func(Event)) *Simulator {
	s := &Simulator{
		shards:   make([]*shardState, shardCount),
		callback: cb,
		listener: listener,
	}
	s.cond = sync.NewCond(&s.mu)
	for i := range s.shards {
		s.shards[i] = &shardState{}
	}
	return s
}

func (s *Simulator) emit(e Event) {
	if s.listener != nil {
		s.listener(e)
	}
}

// Assign grants a shard to a holder, starting generation 1 (or the next
// generation if the shard was previously cancelled). The shard must not
// have an active holder; use Rebalance to replace one.
func (s *Simulator) Assign(shard int, holder string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.shards[shard]
	if st.active {
		panic(fmt.Sprintf("shard %d already held by %q; use Rebalance", shard, st.holder))
	}
	st.generation++
	st.holder = holder
	st.active = true
	s.emit(Event{Kind: EventAssigned, Shard: shard, Generation: st.generation, Holder: holder})
	return st.generation
}

// Rebalance revokes the shard's current holder, blocks until all of its
// in-flight callbacks have finished, and only then grants the shard to
// newHolder under a new generation. It returns the new generation.
func (s *Simulator) Rebalance(shard int, newHolder string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.shards[shard]
	if st.active {
		st.active = false
		s.emit(Event{Kind: EventRevoked, Shard: shard, Generation: st.generation, Holder: st.holder})
	}
	for st.inflight > 0 {
		s.cond.Wait()
	}
	s.emit(Event{Kind: EventDrained, Shard: shard, Generation: st.generation, Holder: st.holder})
	st.generation++
	st.holder = newHolder
	st.active = true
	s.emit(Event{Kind: EventAssigned, Shard: shard, Generation: st.generation, Holder: newHolder})
	return st.generation
}

// Cancel revokes the shard's holder, waits for in-flight callbacks to
// drain, and leaves the shard unassigned.
func (s *Simulator) Cancel(shard int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.shards[shard]
	if st.active {
		st.active = false
		s.emit(Event{Kind: EventRevoked, Shard: shard, Generation: st.generation, Holder: st.holder})
	}
	for st.inflight > 0 {
		s.cond.Wait()
	}
	s.emit(Event{Kind: EventCancelled, Shard: shard, Generation: st.generation, Holder: st.holder})
	st.holder = ""
}

// Deliver appends payload to the shard's ledger and invokes the callback
// with the shard's current generation. It returns false if the shard has
// no active holder. The callback runs synchronously; call Deliver from a
// goroutine for concurrent in-flight deliveries.
func (s *Simulator) Deliver(shard int, payload string) bool {
	s.mu.Lock()
	st := s.shards[shard]
	if !st.active {
		s.mu.Unlock()
		return false
	}
	d := Delivery{
		Shard:      shard,
		Generation: st.generation,
		Holder:     st.holder,
		Offset:     int64(len(st.ledger)),
		Payload:    payload,
	}
	st.ledger = append(st.ledger, LedgerEntry{Delivery: d})
	st.inflight++
	s.mu.Unlock()

	if s.callback != nil {
		s.callback(d)
	}

	s.mu.Lock()
	st.inflight--
	if st.inflight == 0 {
		s.cond.Broadcast()
	}
	s.mu.Unlock()
	return true
}

// Ack acknowledges offset on behalf of a holder and generation. The ack
// is accepted only if it matches the shard's current active generation
// and holder; acks from revoked or superseded generations are rejected
// and can never advance the cursor. It reports whether the ack stuck.
func (s *Simulator) Ack(shard int, holder string, generation uint64, offset int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.shards[shard]
	if !st.active || st.holder != holder || generation != st.generation {
		s.emit(Event{Kind: EventStaleAck, Shard: shard, Generation: generation, Holder: holder, Offset: offset})
		return false
	}
	if offset >= 0 && offset < int64(len(st.ledger)) {
		st.ledger[offset].Acked = true
	}
	if offset >= st.cursor {
		st.cursor = offset + 1
	}
	s.emit(Event{Kind: EventAcked, Shard: shard, Generation: generation, Holder: holder, Offset: offset})
	return true
}

// Ledger returns a copy of the shard's delivery ledger.
func (s *Simulator) Ledger(shard int) []LedgerEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]LedgerEntry, len(s.shards[shard].ledger))
	copy(out, s.shards[shard].ledger)
	return out
}

// Cursor returns the shard's current-generation commit cursor.
func (s *Simulator) Cursor(shard int) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shards[shard].cursor
}

// Generation returns the shard's current generation.
func (s *Simulator) Generation(shard int) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shards[shard].generation
}

// Holder returns the shard's current holder and whether it is active.
func (s *Simulator) Holder(shard int) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shards[shard].holder, s.shards[shard].active
}
