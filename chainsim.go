// Package chainsim simulates chain replication: client writes enter at the
// head and propagate hop by hop to the tail; the tail acknowledges and the
// acknowledgement propagates back up the chain. A node may only publish
// (commit) a contiguous prefix of its log. Nodes that restart fill holes in
// their log by syncing with their neighbors, and every topology change is
// bound to a new epoch so that stale messages from a previous configuration
// (in particular stale acknowledgements) are never applied.
package chainsim

import (
	"math/rand"
	"sort"
)

// Entry is a single replicated log record.
type Entry struct {
	Seq int
	Val string
}

type msgKind int

const (
	msgWrite msgKind = iota
	msgAck
	msgSyncReq
	msgSyncData
)

// Message is exchanged between nodes. Every message carries the epoch of the
// chain configuration it belongs to; nodes drop messages from other epochs.
type Message struct {
	Epoch     int
	Kind      msgKind
	From      int
	To        int
	Seq       int          // msgWrite: entry seq; msgAck: committed-through seq
	Val       string       // msgWrite: entry value
	Committed int          // msgSyncReq/msgSyncData: sender's committed prefix
	Have      map[int]bool // msgSyncReq: seqs the requester already holds
	Entries   []Entry      // msgSyncData: entries offered to the receiver
}

// Node is one replica. Log and Committed are durable and survive crashes;
// the remaining fields are volatile and rebuilt on restart.
type Node struct {
	ID        int
	Log       map[int]string
	Committed int

	up           bool
	epoch        int
	pred         int
	succ         int
	ackWatermark int
}

// contig returns the highest seq such that Log contains every seq in
// [1, seq]. Committed always satisfies this invariant, so the scan can
// start there.
func (n *Node) contig() int {
	c := n.Committed
	for {
		if _, ok := n.Log[c+1]; !ok {
			return c
		}
		c++
	}
}

// Sim is an event-driven simulator. Messages sit in a queue and are
// delivered in random order to model arbitrary event reordering.
type Sim struct {
	nodes   map[int]*Node
	chain   []int
	epoch   int
	queue   []Message
	rng     *rand.Rand
	nextSeq int
	writes  map[int]string

	// AfterEach, if set, runs after every delivered event and client write;
	// tests use it to assert invariants at every step.
	AfterEach func(*Sim)
}

func NewSim(seed int64) *Sim {
	return &Sim{
		nodes:  make(map[int]*Node),
		rng:    rand.New(rand.NewSource(seed)),
		writes: make(map[int]string),
	}
}

func (s *Sim) AddNode(id int) {
	s.nodes[id] = &Node{ID: id, Log: make(map[int]string), up: true, pred: -1, succ: -1}
}

func (s *Sim) Node(id int) *Node { return s.nodes[id] }

func (s *Sim) Chain() []int { return append([]int(nil), s.chain...) }

func (s *Sim) Epoch() int { return s.epoch }

func (s *Sim) Pending() int { return len(s.queue) }

// Writes records every client-accepted write, keyed by its sequence number.
func (s *Sim) Writes() map[int]string { return s.writes }

func (s *Sim) send(m Message) { s.queue = append(s.queue, m) }

// SubmitWrite is a synchronous client write accepted by the current head.
// It reports false when the head is down and the write is rejected.
func (s *Sim) SubmitWrite(val string) (int, bool) {
	if len(s.chain) == 0 {
		return 0, false
	}
	head := s.nodes[s.chain[0]]
	if !head.up {
		return 0, false
	}
	s.nextSeq++
	s.writes[s.nextSeq] = val
	head.Log[s.nextSeq] = val
	if head.succ != -1 {
		s.send(Message{Epoch: s.epoch, Kind: msgWrite, From: head.ID, To: head.succ, Seq: s.nextSeq, Val: val})
	}
	s.maybeCommit(head)
	s.afterEach()
	return s.nextSeq, true
}

// Crash takes a node down. Its durable log and committed prefix survive;
// in-flight messages addressed to it are dropped.
func (s *Sim) Crash(id int) { s.nodes[id].up = false }

// Restart brings a node back in the current epoch and chain position, then
// syncs with its neighbors to fill any holes left by messages dropped while
// it was down.
func (s *Sim) Restart(id int) {
	n := s.nodes[id]
	n.up = true
	n.epoch = s.epoch
	n.pred, n.succ = -1, -1
	inChain := false
	for i, x := range s.chain {
		if x == id {
			inChain = true
			if i > 0 {
				n.pred = s.chain[i-1]
			}
			if i < len(s.chain)-1 {
				n.succ = s.chain[i+1]
			}
		}
	}
	n.ackWatermark = n.Committed
	if n.pred != -1 || n.succ != -1 {
		s.syncHello(n)
	}
	if inChain {
		s.maybeCommit(n)
	}
}

// SetChain installs a new topology and binds it to a fresh epoch. Messages
// queued under the old epoch become stale and are dropped on delivery.
func (s *Sim) SetChain(ids ...int) {
	s.epoch++
	s.chain = append([]int(nil), ids...)
	in := make(map[int]bool, len(ids))
	for _, id := range ids {
		in[id] = true
	}
	for i, id := range ids {
		n := s.nodes[id]
		n.epoch = s.epoch
		n.pred, n.succ = -1, -1
		if i > 0 {
			n.pred = ids[i-1]
		}
		if i < len(ids)-1 {
			n.succ = ids[i+1]
		}
		n.ackWatermark = n.Committed
		if n.up {
			s.syncHello(n)
		}
		s.maybeCommit(n)
	}
	for id, n := range s.nodes {
		if !in[id] {
			n.pred, n.succ = -1, -1
		}
	}
}

// syncHello exchanges anti-entropy state with both neighbors: a pull request
// describing what this node holds, and a push of its full log so the
// neighbor can adopt anything it misses.
func (s *Sim) syncHello(n *Node) {
	have := make(map[int]bool, len(n.Log))
	entries := make([]Entry, 0, len(n.Log))
	for seq, val := range n.Log {
		have[seq] = true
		entries = append(entries, Entry{Seq: seq, Val: val})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Seq < entries[j].Seq })
	for _, nb := range []int{n.pred, n.succ} {
		if nb == -1 {
			continue
		}
		s.send(Message{Epoch: n.epoch, Kind: msgSyncReq, From: n.ID, To: nb, Have: have, Committed: n.Committed})
		if len(entries) > 0 {
			s.send(Message{Epoch: n.epoch, Kind: msgSyncData, From: n.ID, To: nb, Entries: entries, Committed: n.Committed})
		}
	}
}

// maybeCommit advances the committed prefix. Only a contiguous prefix of the
// log may be published, and a non-tail node additionally needs an
// acknowledgement watermark from its successor in the current epoch.
func (s *Sim) maybeCommit(n *Node) {
	if n.succ == -1 {
		if c := n.contig(); c > n.Committed {
			n.Committed = c
			if n.pred != -1 {
				s.send(Message{Epoch: n.epoch, Kind: msgAck, From: n.ID, To: n.pred, Seq: c})
			}
		}
		return
	}
	if c := min(n.ackWatermark, n.contig()); c > n.Committed {
		n.Committed = c
		if n.pred != -1 {
			s.send(Message{Epoch: n.epoch, Kind: msgAck, From: n.ID, To: n.pred, Seq: c})
		}
	}
}

// Step delivers one randomly chosen queued message. It reports false when
// the queue is empty.
func (s *Sim) Step() bool {
	if len(s.queue) == 0 {
		return false
	}
	i := s.rng.Intn(len(s.queue))
	m := s.queue[i]
	s.queue = append(s.queue[:i], s.queue[i+1:]...)
	s.deliver(m)
	s.afterEach()
	return true
}

// Run drains the event queue.
func (s *Sim) Run() {
	for s.Step() {
	}
}

func (s *Sim) afterEach() {
	if s.AfterEach != nil {
		s.AfterEach(s)
	}
}

func (s *Sim) deliver(m Message) {
	n := s.nodes[m.To]
	if n == nil || !n.up || n.epoch != m.Epoch {
		return
	}
	switch m.Kind {
	case msgWrite:
		if m.From != n.pred {
			return
		}
		if _, ok := n.Log[m.Seq]; !ok {
			n.Log[m.Seq] = m.Val
			if n.succ != -1 {
				s.send(Message{Epoch: n.epoch, Kind: msgWrite, From: n.ID, To: n.succ, Seq: m.Seq, Val: m.Val})
			}
		}
		s.maybeCommit(n)
	case msgAck:
		if m.From != n.succ {
			return
		}
		if m.Seq > n.ackWatermark {
			n.ackWatermark = m.Seq
		}
		s.maybeCommit(n)
	case msgSyncReq:
		if m.From != n.pred && m.From != n.succ {
			return
		}
		var entries []Entry
		for seq, val := range n.Log {
			if !m.Have[seq] {
				entries = append(entries, Entry{Seq: seq, Val: val})
			}
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Seq < entries[j].Seq })
		if len(entries) > 0 {
			s.send(Message{Epoch: n.epoch, Kind: msgSyncData, From: n.ID, To: m.From, Entries: entries, Committed: n.Committed})
		}
		if m.From == n.succ && m.Committed > n.ackWatermark {
			n.ackWatermark = m.Committed
			s.maybeCommit(n)
		}
		if m.From == n.pred && n.Committed > m.Committed {
			s.send(Message{Epoch: n.epoch, Kind: msgAck, From: n.ID, To: n.pred, Seq: n.Committed})
		}
	case msgSyncData:
		if m.From != n.pred && m.From != n.succ {
			return
		}
		var fresh []Entry
		for _, e := range m.Entries {
			if _, ok := n.Log[e.Seq]; !ok {
				n.Log[e.Seq] = e.Val
				fresh = append(fresh, e)
			}
		}
		if len(fresh) > 0 {
			for _, nb := range []int{n.pred, n.succ} {
				if nb != -1 && nb != m.From {
					s.send(Message{Epoch: n.epoch, Kind: msgSyncData, From: n.ID, To: nb, Entries: fresh, Committed: n.Committed})
				}
			}
		}
		if m.From == n.succ && m.Committed > n.ackWatermark {
			n.ackWatermark = m.Committed
		}
		s.maybeCommit(n)
	}
}
