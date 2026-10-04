package msgbuf

import (
	"fmt"
	"sort"
)

// Outcome describes what Receive did with a message.
type Outcome int

const (
	// Delivered means the message (and possibly buffered messages that
	// were waiting on it) was delivered immediately.
	Delivered Outcome = iota
	// Duplicate means the message was already delivered or is already
	// buffered; nothing changed and no budget was consumed.
	Duplicate
	// Blocked means the message was buffered because causal dependencies
	// are missing; it now occupies Size() budget bytes.
	Blocked
)

func (o Outcome) String() string {
	switch o {
	case Delivered:
		return "Delivered"
	case Duplicate:
		return "Duplicate"
	case Blocked:
		return "Blocked"
	}
	return "Unknown"
}

// Report describes the result of a Receive call.
type Report struct {
	Outcome Outcome
	// Missing is the complete chain of undelivered dependencies blocking
	// the message: its direct missing dependencies plus, recursively, the
	// missing dependencies of any of those that are themselves buffered.
	// Populated for Blocked outcomes and for budget rejections.
	Missing []Key
	// Now lists every message delivered by this call, in delivery order.
	Now []Message
}

// BudgetError is returned by Receive when buffering a message would exceed
// the memory budget. The buffer is left completely unchanged: the receive
// vector is not advanced and no memory is reserved.
type BudgetError struct {
	Budget  int64 // configured budget in bytes
	Used    int64 // bytes currently held by blocked messages
	Need    int64 // payload bytes the rejected message would add
	Missing []Key // full missing-dependency chain of the rejected message
}

func (e *BudgetError) Error() string {
	return fmt.Sprintf("msgbuf: budget exceeded: used %d + need %d > budget %d (missing %d deps)",
		e.Used, e.Need, e.Budget, len(e.Missing))
}

// Buffer is a causal delivery buffer for one receiver with a byte budget.
//
// A negative budget means unlimited. The zero value is not usable; use New.
type Buffer struct {
	budget  int64
	used    int64
	vector  map[string]uint64 // receive vector: highest delivered seq per sender
	pending map[Key]Message   // causally blocked messages; these occupy the budget
}

// New returns a Buffer that holds at most budget payload bytes of blocked
// messages. A negative budget disables accounting (unlimited).
func New(budget int64) *Buffer {
	return &Buffer{
		budget:  budget,
		vector:  make(map[string]uint64),
		pending: make(map[Key]Message),
	}
}

// Budget returns the configured budget in bytes (negative = unlimited).
func (b *Buffer) Budget() int64 { return b.budget }

// Used returns the payload bytes currently held by blocked messages.
func (b *Buffer) Used() int64 { return b.used }

// Pending returns the number of blocked messages currently buffered.
func (b *Buffer) Pending() int { return len(b.pending) }

// Vector returns a copy of the receive vector: the highest contiguously
// delivered sequence number per sender.
func (b *Buffer) Vector() map[string]uint64 {
	out := make(map[string]uint64, len(b.vector))
	for from, seq := range b.vector {
		out[from] = seq
	}
	return out
}

// Receive ingests one message.
//
// If every dependency is already delivered, the message is delivered at
// once and the receive vector advances; delivery then cascades to buffered
// messages whose dependencies have become satisfied, releasing their bytes.
//
// If dependencies are missing, the message must be buffered. When that
// would exceed the budget, Receive returns a *BudgetError and leaves the
// buffer (including the receive vector) completely unchanged. Otherwise the
// message is buffered and occupies Size() bytes until delivered.
//
// The returned Report always carries the full missing-dependency chain for
// blocked or rejected messages.
func (b *Buffer) Receive(msg Message) (Report, error) {
	id := msg.ID()
	if msg.Seq <= b.vector[msg.From] {
		return Report{Outcome: Duplicate}, nil
	}
	if _, ok := b.pending[id]; ok {
		return Report{Outcome: Duplicate}, nil
	}

	if miss := b.missing(msg); len(miss) > 0 {
		chain := b.missingChain(msg)
		if b.budget >= 0 && b.used+msg.Size() > b.budget {
			return Report{Outcome: Blocked, Missing: chain}, &BudgetError{
				Budget:  b.budget,
				Used:    b.used,
				Need:    msg.Size(),
				Missing: chain,
			}
		}
		b.pending[id] = msg.clone()
		b.used += msg.Size()
		return Report{Outcome: Blocked, Missing: chain}, nil
	}

	rep := Report{Outcome: Delivered}
	b.deliver(msg.clone(), &rep)
	b.cascade(&rep)
	return rep, nil
}

// missing returns the direct undelivered dependencies of msg: gaps in the
// sender's own sequence plus any Deps entries not covered by the vector.
func (b *Buffer) missing(msg Message) []Key {
	set := make(map[Key]struct{})
	for s := b.vector[msg.From] + 1; s < msg.Seq; s++ {
		set[Key{From: msg.From, Seq: s}] = struct{}{}
	}
	for from, seq := range msg.Deps {
		for s := b.vector[from] + 1; s <= seq; s++ {
			set[Key{From: from, Seq: s}] = struct{}{}
		}
	}
	return sortedKeys(set)
}

// missingChain returns the complete chain of undelivered dependencies
// blocking msg: its direct missing dependencies, and recursively the
// missing dependencies of any of those that are themselves buffered.
func (b *Buffer) missingChain(msg Message) []Key {
	seen := make(map[Key]struct{})
	queue := b.missing(msg)
	for len(queue) > 0 {
		k := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		if pm, ok := b.pending[k]; ok {
			queue = append(queue, b.missing(pm)...)
		}
	}
	return sortedKeys(seen)
}

// deliver advances the receive vector and records the delivery.
// Callers must guarantee msg is deliverable (no missing dependencies).
func (b *Buffer) deliver(msg Message, rep *Report) {
	b.vector[msg.From] = msg.Seq
	rep.Now = append(rep.Now, msg)
}

// cascade repeatedly delivers buffered messages whose dependencies are now
// satisfied, releasing their budget bytes, until no more can be delivered.
func (b *Buffer) cascade(rep *Report) {
	for {
		progressed := false
		for _, k := range b.sortedPending() {
			m := b.pending[k]
			if len(b.missing(m)) == 0 {
				delete(b.pending, k)
				b.used -= m.Size()
				b.deliver(m, rep)
				progressed = true
			}
		}
		if !progressed {
			return
		}
	}
}

func (b *Buffer) sortedPending() []Key {
	set := make(map[Key]struct{}, len(b.pending))
	for k := range b.pending {
		set[k] = struct{}{}
	}
	return sortedKeys(set)
}

func sortedKeys(set map[Key]struct{}) []Key {
	out := make([]Key, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].Seq < out[j].Seq
	})
	return out
}
