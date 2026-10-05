// Package msglib implements a causally-ordered message library.
//
// Messages carry vector clocks. A message is delivered only when every
// event it causally depends on has already been delivered; otherwise it is
// held in a buffer. Buffered messages are never force-delivered based on
// wall-clock timestamps: they are released only when their vector-clock
// prerequisites are satisfied. Duplicate IDs with identical content are
// idempotent no-ops; duplicate IDs with different content are rejected.
// Close reports messages whose dependencies remain unmet.
package msglib

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrClosed is returned by Deliver after the library has been closed.
	ErrClosed = errors.New("msglib: library is closed")
	// ErrConflict is returned when a message ID is seen again with
	// different content.
	ErrConflict = errors.New("msglib: duplicate message ID with different content")
)

// Message is a single event identified by ID and stamped with the vector
// clock of its origin Node at send time.
type Message struct {
	ID      string
	Node    string
	Clock   map[string]uint64
	Payload []byte
}

func (m Message) equal(o Message) bool {
	if m.ID != o.ID || m.Node != o.Node || !bytes.Equal(m.Payload, o.Payload) {
		return false
	}
	if len(m.Clock) != len(o.Clock) {
		return false
	}
	for k, v := range m.Clock {
		if ov, ok := o.Clock[k]; !ok || ov != v {
			return false
		}
	}
	return true
}

// Pending describes a buffered message whose dependencies were still unmet
// when the library was closed.
type Pending struct {
	Message Message
	// Missing maps a node to the lowest sequence number of that node that
	// is still required before the message could be delivered.
	Missing map[string]uint64
}

// Library delivers messages in an order that respects causality described
// by their vector clocks.
type Library struct {
	mu        sync.Mutex
	clock     map[string]uint64
	delivered map[string]Message
	buffer    map[string]Message
	order     []Message
	closed    bool
}

// New returns an empty Library.
func New() *Library {
	return &Library{
		clock:     make(map[string]uint64),
		delivered: make(map[string]Message),
		buffer:    make(map[string]Message),
	}
}

// Deliver accepts a message. If its causal prerequisites have all been
// delivered it is appended to the delivery order immediately, possibly
// releasing buffered messages that depended on it. Otherwise the message is
// buffered until its prerequisites arrive. Re-delivering an identical
// message is a no-op; the same ID with different content yields
// ErrConflict.
func (l *Library) Deliver(m Message) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrClosed
	}
	if prev, ok := l.delivered[m.ID]; ok {
		if prev.equal(m) {
			return nil
		}
		return fmt.Errorf("%w: id %q", ErrConflict, m.ID)
	}
	if prev, ok := l.buffer[m.ID]; ok {
		if prev.equal(m) {
			return nil
		}
		return fmt.Errorf("%w: id %q", ErrConflict, m.ID)
	}
	if !l.readyLocked(m) {
		l.buffer[m.ID] = m
		return nil
	}
	l.deliverLocked(m)
	l.drainLocked()
	return nil
}

// readyLocked reports whether every causal prerequisite of m has been
// delivered: all other nodes' entries must already be covered by the
// merged clock, and the origin node's own entry must be the next sequence.
func (l *Library) readyLocked(m Message) bool {
	for node, seq := range m.Clock {
		if node == m.Node {
			continue
		}
		if l.clock[node] < seq {
			return false
		}
	}
	return m.Clock[m.Node] == l.clock[m.Node]+1
}

func (l *Library) deliverLocked(m Message) {
	l.delivered[m.ID] = m
	for node, seq := range m.Clock {
		if l.clock[node] < seq {
			l.clock[node] = seq
		}
	}
	l.order = append(l.order, m)
}

// drainLocked repeatedly releases buffered messages whose prerequisites
// have become satisfied. Iteration is sorted by ID so the release order is
// deterministic.
func (l *Library) drainLocked() {
	for {
		progressed := false
		ids := make([]string, 0, len(l.buffer))
		for id := range l.buffer {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			m, ok := l.buffer[id]
			if !ok {
				continue
			}
			if l.readyLocked(m) {
				delete(l.buffer, id)
				l.deliverLocked(m)
				progressed = true
			}
		}
		if !progressed {
			return
		}
	}
}

// Order returns a copy of the delivery order so far.
func (l *Library) Order() []Message {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Message, len(l.order))
	copy(out, l.order)
	return out
}

// Buffered reports the number of messages currently waiting on unmet
// dependencies.
func (l *Library) Buffered() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buffer)
}

// Close marks the library closed and returns every message still buffered
// together with the dependencies that remain unmet. Subsequent Deliver
// calls fail with ErrClosed.
func (l *Library) Close() []Pending {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	ids := make([]string, 0, len(l.buffer))
	for id := range l.buffer {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	pending := make([]Pending, 0, len(ids))
	for _, id := range ids {
		m := l.buffer[id]
		pending = append(pending, Pending{Message: m, Missing: l.missingLocked(m)})
	}
	return pending
}

func (l *Library) missingLocked(m Message) map[string]uint64 {
	missing := make(map[string]uint64)
	for node, seq := range m.Clock {
		if node == m.Node {
			if l.clock[node]+1 < seq {
				missing[node] = l.clock[node] + 1
			}
			continue
		}
		if l.clock[node] < seq {
			missing[node] = l.clock[node] + 1
		}
	}
	return missing
}
