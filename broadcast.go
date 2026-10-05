// Package broadcast implements a fixed 3-node totally-ordered broadcast
// simulator. Delivery of a numbered message requires a majority (2 of 3)
// of acknowledgments and that every lower-numbered message has already
// been delivered. Duplicate and out-of-order packets are tolerated,
// pending proposals are retained across packet loss, and each node's
// acknowledgment records survive restarts via a durable store.
package broadcast

import (
	"fmt"
	"sort"
	"strings"
)

const (
	NumNodes = 3
	Majority = 2
)

// Message is a numbered broadcast value.
type Message struct {
	Seq   int
	Value string
}

type packetKind int

const (
	kindMsg packetKind = iota // client proposal carrying the value
	kindAck                   // node acknowledgment carrying the value
)

type packet struct {
	from int // -1 denotes the client
	to   int
	kind packetKind
	msg  Message
}

// AckStore is a node's durable acknowledgment log. It is owned by the
// simulator and survives node restarts.
type AckStore struct {
	acks map[int]string
}

func newAckStore() *AckStore { return &AckStore{acks: map[int]string{}} }

// record persists an ack for m; it reports false on a conflicting value.
func (s *AckStore) record(m Message) bool {
	if v, ok := s.acks[m.Seq]; ok {
		return v == m.Value
	}
	s.acks[m.Seq] = m.Value
	return true
}

// Node is one replica. Volatile state is rebuilt from the AckStore and
// from ack gossip after a restart.
type Node struct {
	id      int
	store   *AckStore
	ackedBy map[int]map[int]bool // seq -> set of node ids known to have acked
	values  map[int]string       // seq -> known value (from Msg or Ack)
	next    int                  // next sequence number to deliver
	log     []Message            // delivered prefix
}

func newNode(id int, store *AckStore) *Node {
	n := &Node{
		id:      id,
		store:   store,
		ackedBy: map[int]map[int]bool{},
		values:  map[int]string{},
		next:    1,
	}
	// Recover acknowledgment records from durable storage.
	for seq, v := range store.acks {
		n.values[seq] = v
		n.noteAck(seq, id)
	}
	return n
}

func (n *Node) noteAck(seq, from int) {
	s := n.ackedBy[seq]
	if s == nil {
		s = map[int]bool{}
		n.ackedBy[seq] = s
	}
	s[from] = true
}

// handle processes one packet. It returns packets to send and a conflict
// description (empty when none). Processing is idempotent: duplicates are
// absorbed and out-of-order arrivals are buffered until deliverable.
func (n *Node) handle(p packet) (out []packet, conflict string) {
	switch p.kind {
	case kindMsg:
		if v, ok := n.values[p.msg.Seq]; ok && v != p.msg.Value {
			return nil, fmt.Sprintf("node %d: conflicting message for seq %d: %q vs %q", n.id, p.msg.Seq, v, p.msg.Value)
		}
		if !n.store.record(p.msg) {
			return nil, fmt.Sprintf("node %d: durable ack conflict for seq %d", n.id, p.msg.Seq)
		}
		n.values[p.msg.Seq] = p.msg.Value
		n.noteAck(p.msg.Seq, n.id)
		for peer := 0; peer < NumNodes; peer++ {
			if peer != n.id {
				out = append(out, packet{from: n.id, to: peer, kind: kindAck, msg: p.msg})
			}
		}
	case kindAck:
		if v, ok := n.values[p.msg.Seq]; ok && v != p.msg.Value {
			return nil, fmt.Sprintf("node %d: conflicting ack for seq %d: %q vs %q", n.id, p.msg.Seq, v, p.msg.Value)
		}
		n.values[p.msg.Seq] = p.msg.Value
		n.noteAck(p.msg.Seq, p.from)
	}
	n.deliverReady()
	return out, ""
}

// deliverReady delivers every message that has majority acknowledgment
// and whose whole prefix has already been delivered.
func (n *Node) deliverReady() {
	for {
		v, ok := n.values[n.next]
		if !ok || len(n.ackedBy[n.next]) < Majority {
			return
		}
		n.log = append(n.log, Message{Seq: n.next, Value: v})
		n.next++
	}
}

func (n *Node) hasDelivered(seq int) bool { return seq < n.next }

// Simulator drives the 3-node cluster: a packet queue with optional
// drops, retransmission of pending proposals, and crash/restart control.
type Simulator struct {
	stores    [NumNodes]*AckStore
	nodes     [NumNodes]*Node
	up        [NumNodes]bool
	queue     []packet
	pending   map[int]string
	conflicts []string

	// Drop, when non-nil, decides whether an in-flight packet is lost.
	Drop func(p packet) bool
}

func NewSimulator() *Simulator {
	s := &Simulator{pending: map[int]string{}}
	for i := 0; i < NumNodes; i++ {
		s.stores[i] = newAckStore()
		s.nodes[i] = newNode(i, s.stores[i])
		s.up[i] = true
	}
	return s
}

// Submit proposes a numbered message. Re-proposing a different value for
// the same sequence number is recorded as a conflict.
func (s *Simulator) Submit(seq int, value string) {
	if v, ok := s.pending[seq]; ok && v != value {
		s.conflicts = append(s.conflicts, fmt.Sprintf("client: conflicting submit for seq %d: %q vs %q", seq, v, value))
		return
	}
	s.pending[seq] = value
}

// Tick runs one round: pending proposals are retransmitted (duplicates
// are harmless), durable acks are re-gossiped so lost ack packets are
// eventually replaced, and queued packets are processed.
func (s *Simulator) Tick() {
	seqs := make([]int, 0, len(s.pending))
	for seq := range s.pending {
		seqs = append(seqs, seq)
	}
	sort.Ints(seqs)
	for _, seq := range seqs {
		m := Message{Seq: seq, Value: s.pending[seq]}
		for to := 0; to < NumNodes; to++ {
			s.queue = append(s.queue, packet{from: -1, to: to, kind: kindMsg, msg: m})
		}
	}
	for id := 0; id < NumNodes; id++ {
		if !s.up[id] {
			continue
		}
		for seq, v := range s.stores[id].acks {
			m := Message{Seq: seq, Value: v}
			for peer := 0; peer < NumNodes; peer++ {
				if peer != id {
					s.queue = append(s.queue, packet{from: id, to: peer, kind: kindAck, msg: m})
				}
			}
		}
	}

	q := s.queue
	s.queue = nil
	for _, p := range q {
		if s.Drop != nil && s.Drop(p) {
			continue
		}
		if !s.up[p.to] {
			continue
		}
		out, conflict := s.nodes[p.to].handle(p)
		if conflict != "" {
			s.conflicts = append(s.conflicts, conflict)
		}
		s.queue = append(s.queue, out...)
	}

	// Retire proposals delivered by a majority; the rest stay pending.
	for seq := range s.pending {
		count := 0
		for i := 0; i < NumNodes; i++ {
			if s.nodes[i].hasDelivered(seq) {
				count++
			}
		}
		if count >= Majority {
			delete(s.pending, seq)
		}
	}
}

// Crash halts a node; its durable AckStore is retained.
func (s *Simulator) Crash(id int) { s.up[id] = false }

// Restart brings a node back, recovering its ack records from the store.
func (s *Simulator) Restart(id int) {
	s.nodes[id] = newNode(id, s.stores[id])
	s.up[id] = true
}

// Delivered returns a copy of a node's delivered prefix.
func (s *Simulator) Delivered(id int) []Message {
	return append([]Message(nil), s.nodes[id].log...)
}

// Pending reports the not-yet-retired proposals.
func (s *Simulator) Pending() map[int]string {
	out := make(map[int]string, len(s.pending))
	for k, v := range s.pending {
		out[k] = v
	}
	return out
}

// CheckNoConflict fails if any conflicting value was observed for a
// sequence number at the client or at any node.
func (s *Simulator) CheckNoConflict() error {
	if len(s.conflicts) > 0 {
		return fmt.Errorf("conflicts detected: %s", strings.Join(s.conflicts, "; "))
	}
	return nil
}

// CheckPrefixConsistency verifies that every node's delivered log is the
// prefix 1..k and that all nodes agree on the value of each delivered seq.
func (s *Simulator) CheckPrefixConsistency() error {
	for i := 0; i < NumNodes; i++ {
		for j, m := range s.nodes[i].log {
			if m.Seq != j+1 {
				return fmt.Errorf("node %d: delivered log is not a prefix: position %d holds seq %d", i, j+1, m.Seq)
			}
		}
	}
	seen := map[int]string{}
	for i := 0; i < NumNodes; i++ {
		for _, m := range s.nodes[i].log {
			if v, ok := seen[m.Seq]; ok && v != m.Value {
				return fmt.Errorf("nodes disagree on seq %d: %q vs %q", m.Seq, v, m.Value)
			}
			seen[m.Seq] = m.Value
		}
	}
	return nil
}
