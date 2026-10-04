package sim

import (
	"bytes"
	"fmt"
)

// Event kinds produced by the simulator.
const (
	EvSend      = "SEND"
	EvDeliver   = "DELIVER"
	EvLoss      = "LOSS"
	EvDuplicate = "DUP"
	EvCrash     = "CRASH"
	EvHeal      = "HEAL"
	EvDrop      = "DROP" // delivery to a crashed node
)

// Message is an in-flight message in the pending queue.
type Message struct {
	ID   uint64
	Src  int
	Dst  int
	Body uint64
	Dup  int // number of times this message has been duplicated
}

// Simulator is a deterministic event-driven network simulator.
// Every random choice is drawn from a single seeded RNG, so a run is
// fully determined by (seed, node count, step count).
type Simulator struct {
	nodes   []bool // nodes[i] == true means node i is up
	pending []Message
	rng     RNG
	nextID  uint64
	step    int
	out     bytes.Buffer
}

func New(seed uint64, nodeCount int) *Simulator {
	if nodeCount < 2 {
		nodeCount = 2
	}
	nodes := make([]bool, nodeCount)
	for i := range nodes {
		nodes[i] = true
	}
	return &Simulator{nodes: nodes, rng: NewRNG(seed)}
}

// Step advances the simulation by exactly one event, appending a
// canonical log line to the output stream.
func (s *Simulator) Step() {
	s.step++
	switch s.pickAction() {
	case EvSend:
		s.doSend()
	case EvDeliver:
		s.doDeliver()
	case EvLoss:
		s.doLoss()
	case EvDuplicate:
		s.doDuplicate()
	case EvCrash:
		s.doCrash()
	default:
		s.doHeal()
	}
}

func (s *Simulator) pickAction() string {
	w := s.rng.Intn(100)
	switch {
	case w < 35:
		return EvSend
	case w < 60:
		if len(s.pending) > 0 {
			return EvDeliver
		}
		return EvSend
	case w < 70:
		if len(s.pending) > 0 {
			return EvLoss
		}
		return EvSend
	case w < 80:
		if len(s.pending) > 0 {
			return EvDuplicate
		}
		return EvSend
	case w < 90:
		return EvCrash
	default:
		return EvHeal
	}
}

func (s *Simulator) upNodes() []int {
	var up []int
	for i, ok := range s.nodes {
		if ok {
			up = append(up, i)
		}
	}
	return up
}

func (s *Simulator) doSend() {
	up := s.upNodes()
	if len(up) == 0 {
		fmt.Fprintf(&s.out, "#%06d %s no-up-nodes\n", s.step, EvSend)
		return
	}
	src := up[s.rng.Intn(len(up))]
	dst := s.rng.Intn(len(s.nodes))
	msg := Message{ID: s.nextID, Src: src, Dst: dst, Body: s.rng.Next()}
	s.nextID++
	s.pending = append(s.pending, msg)
	fmt.Fprintf(&s.out, "#%06d %s id=%d %d->%d body=%016x\n", s.step, EvSend, msg.ID, src, dst, msg.Body)
}

func (s *Simulator) doDeliver() {
	msg := s.pending[0]
	s.pending = s.pending[1:]
	if !s.nodes[msg.Dst] {
		fmt.Fprintf(&s.out, "#%06d %s id=%d dst-down=%d\n", s.step, EvDrop, msg.ID, msg.Dst)
		return
	}
	fmt.Fprintf(&s.out, "#%06d %s id=%d %d->%d dup=%d body=%016x\n", s.step, EvDeliver, msg.ID, msg.Src, msg.Dst, msg.Dup, msg.Body)
}

func (s *Simulator) doLoss() {
	i := s.rng.Intn(len(s.pending))
	msg := s.pending[i]
	s.pending = append(s.pending[:i], s.pending[i+1:]...)
	fmt.Fprintf(&s.out, "#%06d %s id=%d\n", s.step, EvLoss, msg.ID)
}

func (s *Simulator) doDuplicate() {
	i := s.rng.Intn(len(s.pending))
	msg := s.pending[i]
	msg.Dup++
	s.pending = append(s.pending, msg)
	fmt.Fprintf(&s.out, "#%06d %s id=%d dup=%d\n", s.step, EvDuplicate, msg.ID, msg.Dup)
}

func (s *Simulator) doCrash() {
	up := s.upNodes()
	if len(up) == 0 {
		fmt.Fprintf(&s.out, "#%06d %s none-up\n", s.step, EvCrash)
		return
	}
	n := up[s.rng.Intn(len(up))]
	s.nodes[n] = false
	fmt.Fprintf(&s.out, "#%06d %s node=%d\n", s.step, EvCrash, n)
}

func (s *Simulator) doHeal() {
	var down []int
	for i, ok := range s.nodes {
		if !ok {
			down = append(down, i)
		}
	}
	if len(down) == 0 {
		fmt.Fprintf(&s.out, "#%06d %s none-down\n", s.step, EvHeal)
		return
	}
	n := down[s.rng.Intn(len(down))]
	s.nodes[n] = true
	fmt.Fprintf(&s.out, "#%06d %s node=%d\n", s.step, EvHeal, n)
}

// Output returns the canonical event log bytes produced so far.
func (s *Simulator) Output() []byte {
	return s.out.Bytes()
}

// StepCount returns how many events have been applied.
func (s *Simulator) StepCount() int { return s.step }

// PendingLen reports the number of in-flight messages.
func (s *Simulator) PendingLen() int { return len(s.pending) }
