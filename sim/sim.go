// Package sim implements a deterministic distributed-system simulator.
//
// The simulator replays a fixed event log of message sends, losses,
// duplications, deliveries and node crashes. All randomness is drawn from a
// single seeded PRNG whose state is part of every snapshot, together with
// the pending (in-flight) send queue. Restoring a snapshot at any event
// index and continuing must therefore produce a final state that is
// byte-for-byte identical to an uninterrupted full replay.
package sim

import (
	"encoding/binary"
	"fmt"
)

// RNG is a splitmix64 generator. Its entire state is a single uint64, which
// makes it trivially serializable into snapshots.
type RNG struct {
	state uint64
}

func NewRNG(seed uint64) RNG { return RNG{state: seed} }

func (r *RNG) Next() uint64 {
	r.state += 0x9e3779b97f4a7c15
	z := r.state
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

func (r *RNG) Intn(n int) int {
	if n <= 0 {
		return 0
	}
	return int(r.Next() % uint64(n))
}

// State exposes the raw PRNG state for snapshotting.
func (r *RNG) State() uint64 { return r.state }

// Restore sets the raw PRNG state from a snapshot.
func (r *RNG) Restore(state uint64) { r.state = state }

// Kind enumerates the replayable event types.
type Kind int

const (
	EvSend Kind = iota
	EvDeliver
	EvLoss
	EvDup
	EvCrash
	EvRecover
)

func (k Kind) String() string {
	switch k {
	case EvSend:
		return "send"
	case EvDeliver:
		return "deliver"
	case EvLoss:
		return "loss"
	case EvDup:
		return "dup"
	case EvCrash:
		return "crash"
	case EvRecover:
		return "recover"
	}
	return "unknown"
}

// Event is one entry in the replay log. From/To are used by EvSend, Node by
// EvCrash/EvRecover. Loss, duplication and delivery select their target
// message from the pending queue at apply time using the simulator RNG, so
// the RNG state is an essential part of any snapshot.
type Event struct {
	Kind     Kind
	From, To int
	Node     int
}

func (e Event) String() string {
	switch e.Kind {
	case EvSend:
		return fmt.Sprintf("send(%d->%d)", e.From, e.To)
	case EvCrash, EvRecover:
		return fmt.Sprintf("%s(%d)", e.Kind, e.Node)
	default:
		return e.Kind.String()
	}
}

// Message is an in-flight or delivered message.
type Message struct {
	ID      uint64
	From    int
	To      int
	Payload uint64
	Dup     int
}

// Node is a simulated process.
type Node struct {
	Alive bool
	Inbox []Message
	State uint64
}

// Config parameterizes a simulation run.
type Config struct {
	NumNodes int
	Seed     uint64
}

// Sim is the simulator state. The zero value is not usable; use New.
type Sim struct {
	cfg       Config
	rng       RNG
	nodes     []Node
	queue     []Message // pending send queue (in-flight messages)
	delivered []Message // append-only delivery history
	nextMsgID uint64
	cursor    int // index of the next event to apply
}

func New(cfg Config) *Sim {
	if cfg.NumNodes <= 0 {
		cfg.NumNodes = 1
	}
	s := &Sim{cfg: cfg, rng: NewRNG(cfg.Seed)}
	s.nodes = make([]Node, cfg.NumNodes)
	for i := range s.nodes {
		s.nodes[i].Alive = true
	}
	return s
}

// Generate builds a deterministic event log of n events from the seed. It
// uses a private RNG derived from the seed, independent of the runtime RNG
// consumed while applying events.
func Generate(cfg Config, n int) []Event {
	rng := NewRNG(cfg.Seed ^ 0x5bd1e9955bd1e995)
	events := make([]Event, 0, n)
	for i := 0; i < n; i++ {
		roll := rng.Intn(100)
		var ev Event
		switch {
		case roll < 45:
			ev = Event{Kind: EvSend, From: rng.Intn(cfg.NumNodes), To: rng.Intn(cfg.NumNodes)}
		case roll < 65:
			ev = Event{Kind: EvDeliver}
		case roll < 75:
			ev = Event{Kind: EvLoss}
		case roll < 85:
			ev = Event{Kind: EvDup}
		case roll < 93:
			ev = Event{Kind: EvCrash, Node: rng.Intn(cfg.NumNodes)}
		default:
			ev = Event{Kind: EvRecover, Node: rng.Intn(cfg.NumNodes)}
		}
		events = append(events, ev)
	}
	return events
}

// Cursor returns the index of the next event to apply.
func (s *Sim) Cursor() int { return s.cursor }

// QueueLen returns the number of in-flight messages.
func (s *Sim) QueueLen() int { return len(s.queue) }

// Step applies a single event.
func (s *Sim) Step(ev Event) {
	switch ev.Kind {
	case EvSend:
		s.enqueue(Message{
			ID:      s.nextMsgID,
			From:    ev.From % len(s.nodes),
			To:      ev.To % len(s.nodes),
			Payload: s.rng.Next(),
		})
	case EvDeliver:
		if len(s.queue) == 0 {
			break
		}
		idx := s.rng.Intn(len(s.queue))
		msg := s.queue[idx]
		s.queue = append(s.queue[:idx], s.queue[idx+1:]...)
		node := &s.nodes[msg.To]
		if !node.Alive {
			break
		}
		node.Inbox = append(node.Inbox, msg)
		node.State = node.State*31 + msg.Payload
		s.delivered = append(s.delivered, msg)
		// A delivery may trigger a random follow-up response message.
		if s.rng.Intn(3) == 0 {
			s.enqueue(Message{
				ID:      s.nextMsgID,
				From:    msg.To,
				To:      msg.From,
				Payload: s.rng.Next(),
			})
		}
	case EvLoss:
		if len(s.queue) == 0 {
			break
		}
		idx := s.rng.Intn(len(s.queue))
		s.queue = append(s.queue[:idx], s.queue[idx+1:]...)
	case EvDup:
		if len(s.queue) == 0 {
			break
		}
		idx := s.rng.Intn(len(s.queue))
		dup := s.queue[idx]
		dup.Dup++
		s.queue = append(s.queue, dup)
	case EvCrash:
		node := &s.nodes[ev.Node%len(s.nodes)]
		node.Alive = false
		node.Inbox = nil
		node.State = 0
		kept := s.queue[:0]
		for _, m := range s.queue {
			if m.To != ev.Node%len(s.nodes) {
				kept = append(kept, m)
			}
		}
		s.queue = kept
	case EvRecover:
		s.nodes[ev.Node%len(s.nodes)].Alive = true
	}
	s.cursor++
}

func (s *Sim) enqueue(m Message) {
	m.ID = s.nextMsgID
	s.nextMsgID++
	s.queue = append(s.queue, m)
}

// Run applies events[from:to].
func (s *Sim) Run(events []Event, from, to int) {
	for i := from; i < to; i++ {
		s.Step(events[i])
	}
}

// Snapshot is a complete, restorable image of the simulator state, including
// the pending send queue and the PRNG state.
type Snapshot struct {
	Nodes     []Node
	Queue     []Message
	Delivered []Message
	RNGState  uint64
	NextMsgID uint64
	Cursor    int
}

// Snapshot captures the full simulator state.
func (s *Sim) Snapshot() Snapshot {
	snap := Snapshot{
		Nodes:     make([]Node, len(s.nodes)),
		Queue:     append([]Message(nil), s.queue...),
		Delivered: append([]Message(nil), s.delivered...),
		RNGState:  s.rng.State(),
		NextMsgID: s.nextMsgID,
		Cursor:    s.cursor,
	}
	for i, n := range s.nodes {
		snap.Nodes[i] = Node{
			Alive: n.Alive,
			Inbox: append([]Message(nil), n.Inbox...),
			State: n.State,
		}
	}
	return snap
}

// Restore builds a simulator from a snapshot. The returned simulator is
// independent of the one the snapshot was taken from.
func Restore(cfg Config, snap Snapshot) *Sim {
	s := New(cfg)
	s.rng.Restore(snap.RNGState)
	s.nextMsgID = snap.NextMsgID
	s.cursor = snap.Cursor
	s.queue = append([]Message(nil), snap.Queue...)
	s.delivered = append([]Message(nil), snap.Delivered...)
	for i := range s.nodes {
		if i < len(snap.Nodes) {
			s.nodes[i] = Node{
				Alive: snap.Nodes[i].Alive,
				Inbox: append([]Message(nil), snap.Nodes[i].Inbox...),
				State: snap.Nodes[i].State,
			}
		}
	}
	return s
}

// StateBytes serializes the full observable state into a canonical byte
// form. Two runs are equivalent iff their StateBytes are identical.
func (s *Sim) StateBytes() []byte {
	buf := make([]byte, 0, 256)
	var tmp [8]byte
	putU64 := func(v uint64) {
		binary.LittleEndian.PutUint64(tmp[:], v)
		buf = append(buf, tmp[:]...)
	}
	putMsg := func(m Message) {
		putU64(m.ID)
		putU64(uint64(m.From))
		putU64(uint64(m.To))
		putU64(m.Payload)
		putU64(uint64(m.Dup))
	}
	putU64(s.rng.State())
	putU64(s.nextMsgID)
	putU64(uint64(s.cursor))
	putU64(uint64(len(s.nodes)))
	for _, n := range s.nodes {
		if n.Alive {
			buf = append(buf, 1)
		} else {
			buf = append(buf, 0)
		}
		putU64(n.State)
		putU64(uint64(len(n.Inbox)))
		for _, m := range n.Inbox {
			putMsg(m)
		}
	}
	putU64(uint64(len(s.queue)))
	for _, m := range s.queue {
		putMsg(m)
	}
	putU64(uint64(len(s.delivered)))
	for _, m := range s.delivered {
		putMsg(m)
	}
	return buf
}
