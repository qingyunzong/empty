// Package netsim implements a discrete-event simulation of packets, queues
// and a single link over integer ticks. It never sends real network traffic.
//
// A link fault starts with a fixed policy that applies to in-transit packets:
//   - PolicyPause: in-transit packets freeze; they resume after recovery.
//   - PolicyDrop:  in-transit packets are dropped; they never come back.
//   - PolicyDelay: in-transit packets get a fixed extra delay.
//
// While a fault is active the link stops dequeuing new packets; the queue
// waits and continues according to the rules once the link recovers.
// Fault and recovery events are idempotent: a duplicate fault does not change
// the policy fixed at the first fault, and a duplicate recovery is a no-op.
package netsim

import (
	"container/heap"
	"fmt"
	"sort"
)

// Policy decides what happens to in-transit packets when a fault begins.
type Policy int

const (
	PolicyPause Policy = iota // freeze in-transit packets until recovery
	PolicyDrop                // drop in-transit packets permanently
	PolicyDelay               // add a fixed delay to in-transit packets
)

func (p Policy) String() string {
	switch p {
	case PolicyPause:
		return "pause"
	case PolicyDrop:
		return "drop"
	case PolicyDelay:
		return "delay"
	}
	return "unknown"
}

// State is the lifecycle state of a packet. In-transit and unsent
// (pending/queued) packets are distinct states.
type State int

const (
	StatePending   State = iota // created, not yet released into the queue
	StateQueued                 // waiting in the link queue (unsent)
	StateInTransit              // on the wire
	StatePaused                 // in-transit but frozen by a pause fault
	StateDelivered              // reached the destination
	StateDropped                // dropped by a fault; cannot be resurrected
)

func (st State) String() string {
	switch st {
	case StatePending:
		return "pending"
	case StateQueued:
		return "queued"
	case StateInTransit:
		return "in-transit"
	case StatePaused:
		return "paused"
	case StateDelivered:
		return "delivered"
	case StateDropped:
		return "dropped"
	}
	return "unknown"
}

// Packet is a simulated packet. All times are integer ticks.
type Packet struct {
	ID   int
	Size int // bytes, informational

	State      State
	EnqueuedAt int // tick the packet entered the link queue; -1 if never
	SentAt     int // tick the packet left the queue onto the wire; -1 if never
	FinishAt   int // tick the packet was delivered or dropped; -1 otherwise

	deliverAt int // scheduled delivery tick while in transit
	remaining int // remaining transit ticks, valid while paused
}

// Link is a FIFO queue plus a wire with fixed latency and a per-tick send rate.
type Link struct {
	Name    string
	Latency int // ticks a packet spends on the wire
	Rate    int // max packets dequeued per tick

	queue     []*Packet   // unsent packets, FIFO
	inTransit []*Packet   // packets on the wire
	fault     *faultState // nil while healthy
}

type faultState struct {
	policy    Policy
	startedAt int
}

func (l *Link) faulted() bool { return l.fault != nil }

// eventKind identifies scheduled event types.
type eventKind int

const (
	evRelease eventKind = iota // a packet is released into the link queue
	evDeliver                  // a packet reaches the end of the wire
	evFault                    // a fault begins on the link
	evRecover                  // the link recovers from a fault
)

type event struct {
	tick   int
	seq    int // insertion order, breaks ties deterministically
	kind   eventKind
	pkt    *Packet
	policy Policy
	delay  int
}

// eventHeap is a min-heap of events ordered by (tick, seq).
type eventHeap []event

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].tick != h[j].tick {
		return h[i].tick < h[j].tick
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(event)) }
func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	*h = old[:n-1]
	return e
}

// Sim is the discrete-event simulator. Time advances in integer ticks and
// only jumps between scheduled events.
type Sim struct {
	link    *Link
	now     int
	events  eventHeap
	seq     int
	packets []*Packet

	sendTick  int // last tick the link dequeued packets
	sendCount int // packets dequeued during sendTick
}

// NewSim creates a simulator driving the given link.
func NewSim(link *Link) *Sim {
	return &Sim{link: link, sendTick: -1}
}

// Now returns the current tick.
func (s *Sim) Now() int { return s.now }

// Packets returns all packets known to the simulation, in release order.
func (s *Sim) Packets() []*Packet { return s.packets }

func (s *Sim) schedule(tick int, kind eventKind, pkt *Packet, policy Policy, delay int) {
	if tick < s.now {
		panic(fmt.Sprintf("netsim: scheduling event at tick %d in the past (now=%d)", tick, s.now))
	}
	heap.Push(&s.events, event{tick: tick, seq: s.seq, kind: kind, pkt: pkt, policy: policy, delay: delay})
	s.seq++
}

// Release schedules a new packet to enter the link queue at the given tick.
func (s *Sim) Release(tick, id, size int) *Packet {
	p := &Packet{ID: id, Size: size, State: StatePending, EnqueuedAt: -1, SentAt: -1, FinishAt: -1}
	s.packets = append(s.packets, p)
	s.schedule(tick, evRelease, p, 0, 0)
	return p
}

// Fault schedules a fault to begin at the given tick. The policy (and the
// extra delay for PolicyDelay) is fixed at the moment the fault starts; a
// fault event arriving while a fault is already active is ignored.
func (s *Sim) Fault(tick int, policy Policy, delay int) {
	s.schedule(tick, evFault, nil, policy, delay)
}

// Recover schedules link recovery at the given tick. Recovery while the link
// is healthy is ignored. Recovery never resurrects dropped packets.
func (s *Sim) Recover(tick int) {
	s.schedule(tick, evRecover, nil, 0, 0)
}

// Run processes events until none remain, then returns the final tick.
func (s *Sim) Run() int {
	for len(s.events) > 0 {
		e := heap.Pop(&s.events).(event)
		s.now = e.tick
		switch e.kind {
		case evRelease:
			s.onRelease(e.pkt)
		case evDeliver:
			s.onDeliver(e.pkt)
		case evFault:
			s.onFault(e.policy, e.delay)
		case evRecover:
			s.onRecover()
		}
	}
	return s.now
}

func (s *Sim) onRelease(p *Packet) {
	p.State = StateQueued
	p.EnqueuedAt = s.now
	s.link.queue = append(s.link.queue, p)
	s.trySend()
}

// trySend dequeues packets onto the wire, respecting the per-tick rate and
// the fault state. While a fault is active nothing leaves the queue.
func (s *Sim) trySend() {
	l := s.link
	if l.faulted() {
		return
	}
	if s.sendTick != s.now {
		s.sendTick = s.now
		s.sendCount = 0
	}
	for s.sendCount < l.Rate && len(l.queue) > 0 {
		p := l.queue[0]
		l.queue = l.queue[1:]
		p.State = StateInTransit
		p.SentAt = s.now
		p.deliverAt = s.now + l.Latency
		l.inTransit = append(l.inTransit, p)
		s.schedule(p.deliverAt, evDeliver, p, 0, 0)
		s.sendCount++
	}
}

func (s *Sim) onDeliver(p *Packet) {
	// Stale delivery events belong to packets that were dropped, paused or
	// rescheduled since the event was created; ignore them.
	if p.State != StateInTransit || p.deliverAt != s.now {
		return
	}
	p.State = StateDelivered
	p.FinishAt = s.now
	s.removeInTransit(p)
	s.trySend()
}

func (s *Sim) removeInTransit(p *Packet) {
	l := s.link
	for i, q := range l.inTransit {
		if q == p {
			l.inTransit = append(l.inTransit[:i], l.inTransit[i+1:]...)
			return
		}
	}
}

// inTransitSorted returns in-transit packets ordered by ID for determinism.
func (s *Sim) inTransitSorted() []*Packet {
	ps := append([]*Packet(nil), s.link.inTransit...)
	sort.Slice(ps, func(i, j int) bool { return ps[i].ID < ps[j].ID })
	return ps
}

func (s *Sim) onFault(policy Policy, delay int) {
	l := s.link
	if l.faulted() {
		return // idempotent: the policy fixed at the first fault stands
	}
	l.fault = &faultState{policy: policy, startedAt: s.now}
	switch policy {
	case PolicyPause:
		for _, p := range s.inTransitSorted() {
			p.remaining = p.deliverAt - s.now
			p.State = StatePaused
		}
	case PolicyDrop:
		for _, p := range s.inTransitSorted() {
			p.State = StateDropped
			p.FinishAt = s.now
			s.removeInTransit(p)
		}
	case PolicyDelay:
		for _, p := range s.inTransitSorted() {
			p.deliverAt += delay
			s.schedule(p.deliverAt, evDeliver, p, 0, 0)
		}
	}
}

func (s *Sim) onRecover() {
	l := s.link
	if !l.faulted() {
		return // idempotent: nothing to recover from
	}
	f := l.fault
	l.fault = nil
	if f.policy == PolicyPause {
		for _, p := range s.inTransitSorted() {
			if p.State != StatePaused {
				continue
			}
			p.State = StateInTransit
			p.deliverAt = s.now + p.remaining
			s.schedule(p.deliverAt, evDeliver, p, 0, 0)
		}
	}
	s.trySend() // the queue continues according to the rules
}
