// Package msglib implements a causally ordered message buffer whose memory
// usage is accounted in payload bytes against a fixed budget.
//
// Accepted but undelivered messages - including causally blocked ones -
// consume budget. A receive that would exceed the budget is rejected and
// leaves the receive vector untouched. Delivered messages release their
// bytes immediately. Blocked messages can report the complete chain of
// dependencies they are waiting on.
package msglib

import (
	"errors"
	"fmt"
	"sort"
)

// ErrOverBudget is returned (wrapped by *OverBudgetError) when accepting a
// message would exceed the buffer's memory budget.
var ErrOverBudget = errors.New("msglib: memory budget exceeded")

// OverBudgetError describes a rejected receive.
type OverBudgetError struct {
	Used  uint64 // bytes held at the time of rejection
	Limit uint64 // total budget
	Need  uint64 // payload bytes the rejected message required
}

func (e *OverBudgetError) Error() string {
	return fmt.Sprintf("%v: used %d + need %d exceeds limit %d", ErrOverBudget, e.Used, e.Need, e.Limit)
}

func (e *OverBudgetError) Unwrap() error { return ErrOverBudget }

// Vector is a vector clock indexed by node ID.
type Vector []uint64

// Clone returns a deep copy of v.
func (v Vector) Clone() Vector {
	c := make(Vector, len(v))
	copy(c, v)
	return c
}

// MessageID uniquely identifies a message by sender and sequence number.
type MessageID struct {
	Sender int
	Seq    uint64
}

// Message is a causally timestamped payload.
type Message struct {
	ID      MessageID
	VT      Vector
	Payload []byte
}

// Gap is a contiguous inclusive range of missing sequence numbers from one
// sender.
type Gap struct {
	Sender int
	From   uint64
	To     uint64
}

// DepChain reports the complete chain of dependencies blocking a buffered
// message: dependencies never received (Absent) and dependencies sitting in
// the buffer (Pending), recursing into the latter (Children).
type DepChain struct {
	ID       MessageID
	Absent   []Gap
	Pending  []MessageID
	Children []*DepChain
}

// Node is a causal broadcast participant with a byte-bounded buffer.
type Node struct {
	id      int
	clock   Vector // receive vector: delivered prefix per sender
	limit   uint64
	used    uint64
	pending map[MessageID]Message
}

// NewNode returns a node with the given ID, cluster size, and payload-byte
// memory budget.
func NewNode(id, n int, limit uint64) *Node {
	return &Node{
		id:      id,
		clock:   make(Vector, n),
		limit:   limit,
		pending: make(map[MessageID]Message),
	}
}

// Send creates a message stamped with the node's current clock. A node's own
// messages are delivered locally at send time and never consume buffer
// memory.
func (n *Node) Send(payload []byte) Message {
	n.clock[n.id]++
	return Message{
		ID:      MessageID{Sender: n.id, Seq: n.clock[n.id]},
		VT:      n.clock.Clone(),
		Payload: payload,
	}
}

// Receive accepts m into the buffer subject to the memory budget, then
// delivers every message whose causal dependencies are satisfied, returning
// the newly delivered messages in causal order.
//
// Duplicates of delivered or buffered messages are ignored. If m does not
// fit in the remaining budget, Receive returns an *OverBudgetError and
// leaves the receive vector and memory accounting untouched.
func (n *Node) Receive(m Message) ([]Message, error) {
	s := m.ID.Sender
	if m.VT[s] <= n.clock[s] {
		return nil, nil
	}
	if _, ok := n.pending[m.ID]; ok {
		return nil, nil
	}
	need := uint64(len(m.Payload))
	if n.used+need > n.limit {
		return nil, &OverBudgetError{Used: n.used, Limit: n.limit, Need: need}
	}
	n.used += need
	n.pending[m.ID] = m
	return n.drain(), nil
}

// Used returns the payload bytes currently held by undelivered messages.
func (n *Node) Used() uint64 { return n.used }

// Limit returns the memory budget in payload bytes.
func (n *Node) Limit() uint64 { return n.limit }

// Vector returns a copy of the receive (delivered) vector.
func (n *Node) Vector() Vector { return n.clock.Clone() }

// Pending returns the IDs of buffered, undelivered messages in sorted order.
func (n *Node) Pending() []MessageID { return n.sortedPending() }

// Missing returns the dependency gaps currently blocking the pending message
// id, or false if id is not pending.
func (n *Node) Missing(id MessageID) ([]Gap, bool) {
	m, ok := n.pending[id]
	if !ok {
		return nil, false
	}
	return n.gaps(m), true
}

// Report builds the complete dependency chain blocking the pending message
// id, or returns false if id is not pending.
func (n *Node) Report(id MessageID) (*DepChain, bool) {
	m, ok := n.pending[id]
	if !ok {
		return nil, false
	}
	return n.chain(m, make(map[MessageID]bool)), true
}

func (n *Node) deliverable(m Message) bool {
	if m.VT[m.ID.Sender] != n.clock[m.ID.Sender]+1 {
		return false
	}
	for j := range n.clock {
		if j != m.ID.Sender && m.VT[j] > n.clock[j] {
			return false
		}
	}
	return true
}

func (n *Node) drain() []Message {
	var delivered []Message
	for {
		progress := false
		for _, id := range n.sortedPending() {
			m := n.pending[id]
			if n.deliverable(m) {
				delete(n.pending, id)
				n.used -= uint64(len(m.Payload))
				n.clock[id.Sender] = m.VT[id.Sender]
				delivered = append(delivered, m)
				progress = true
			}
		}
		if !progress {
			return delivered
		}
	}
}

func (n *Node) sortedPending() []MessageID {
	ids := make([]MessageID, 0, len(n.pending))
	for id := range n.pending {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if ids[i].Sender != ids[j].Sender {
			return ids[i].Sender < ids[j].Sender
		}
		return ids[i].Seq < ids[j].Seq
	})
	return ids
}

func (n *Node) gaps(m Message) []Gap {
	var out []Gap
	s := m.ID.Sender
	if next := n.clock[s] + 1; m.VT[s] > next {
		out = append(out, Gap{Sender: s, From: next, To: m.VT[s] - 1})
	}
	for j := range n.clock {
		if j != s && m.VT[j] > n.clock[j] {
			out = append(out, Gap{Sender: j, From: n.clock[j] + 1, To: m.VT[j]})
		}
	}
	return out
}

func (n *Node) chain(m Message, seen map[MessageID]bool) *DepChain {
	seen[m.ID] = true
	c := &DepChain{ID: m.ID}
	for _, g := range n.gaps(m) {
		seq := g.From
		for seq <= g.To {
			dep := MessageID{Sender: g.Sender, Seq: seq}
			if pm, ok := n.pending[dep]; ok {
				c.Pending = append(c.Pending, dep)
				if !seen[dep] {
					c.Children = append(c.Children, n.chain(pm, seen))
				}
				seq++
				continue
			}
			start := seq
			for seq <= g.To {
				if _, ok := n.pending[MessageID{Sender: g.Sender, Seq: seq}]; ok {
					break
				}
				seq++
			}
			c.Absent = append(c.Absent, Gap{Sender: g.Sender, From: start, To: seq - 1})
		}
	}
	return c
}
