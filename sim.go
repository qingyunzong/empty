package raftsim

import (
	"fmt"
	"sort"
	"strings"
)

// CommitEvidence records why an index became committed: which leader, in
// which term, and the replica set that formed a majority.
type CommitEvidence struct {
	Step         int
	Leader       string
	Term         int
	Index        int
	Entry        Entry
	ReplicatedOn []string
}

func (e CommitEvidence) String() string {
	return fmt.Sprintf("COMMIT step=%d index=%d entry=%s leader=%s term=%d replicated=%v",
		e.Step, e.Index, e.Entry, e.Leader, e.Term, e.ReplicatedOn)
}

// Sim is a deterministic event-driven network of nodes. Messages are
// explicit events in a FIFO queue; Step delivers exactly one. Directed
// links can be cut to simulate partitions. No real network is used.
type Sim struct {
	ids   []string
	nodes map[string]*Node
	queue []Message
	cut   map[[2]string]bool

	step int

	// Trace holds one human-readable line per interesting event.
	Trace []string
	// Evidence holds one record per leader-side commit advancement.
	Evidence []CommitEvidence

	// Truncations counts follower-side truncations of uncommitted
	// conflicting suffixes (old leader recovery).
	Truncations int

	violations []string
	// committed witnesses the first value ever committed at each index;
	// any later disagreement is a safety violation.
	committed  map[int]Entry
	maxCommits map[string]int
}

// NewSim builds a cluster of the given node ids (e.g. "n1", "n2", "n3").
func NewSim(ids ...string) *Sim {
	s := &Sim{
		ids:        append([]string(nil), ids...),
		nodes:      map[string]*Node{},
		cut:        map[[2]string]bool{},
		committed:  map[int]Entry{},
		maxCommits: map[string]int{},
	}
	for _, id := range ids {
		s.nodes[id] = &Node{id: id, sim: s}
	}
	return s
}

// Node returns the named node.
func (s *Sim) Node(id string) *Node { return s.nodes[id] }

// StepCount returns how many events have been processed.
func (s *Sim) StepCount() int { return s.step }

func (s *Sim) tracef(format string, args ...any) {
	s.Trace = append(s.Trace, fmt.Sprintf(format, args...))
}

func (s *Sim) violationf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	s.violations = append(s.violations, msg)
	s.tracef("step %d: SAFETY VIOLATION: %s", s.step, msg)
}

// Violations reports every safety violation observed so far.
func (s *Sim) Violations() []string { return append([]string(nil), s.violations...) }

func (s *Sim) send(m Message) { s.queue = append(s.queue, m) }

// Pending reports how many message events are still queued.
func (s *Sim) Pending() int { return len(s.queue) }

// --- External events (injected by the driver to steer the simulation) ---

// StartElection makes id begin an election (the event-driven analogue of a
// timeout firing).
func (s *Sim) StartElection(id string) { s.nodes[id].startElection() }

// Propose asks id to replicate value; it is a no-op unless id is a leader.
func (s *Sim) Propose(id, value string) { s.nodes[id].propose(value) }

// Cut drops all future messages from a to b until Heal is called.
func (s *Sim) Cut(a, b string) { s.cut[[2]string{a, b}] = true }

// Heal restores the directed link from a to b.
func (s *Sim) Heal(a, b string) { delete(s.cut, [2]string{a, b}) }

// CutBoth severs the link between a and b in both directions.
func (s *Sim) CutBoth(a, b string) { s.Cut(a, b); s.cut[[2]string{b, a}] = true }

// HealAll restores every link.
func (s *Sim) HealAll() { s.cut = map[[2]string]bool{} }

// --- Event processing ---------------------------------------------------

// Step delivers the next queued message, or returns false if none remain.
// Dropped (partitioned) messages still consume a step and are logged.
func (s *Sim) Step() bool {
	if len(s.queue) == 0 {
		return false
	}
	m := s.queue[0]
	s.queue = s.queue[1:]
	s.step++
	if s.cut[[2]string{m.From, m.To}] {
		s.tracef("step %d: DROP %s (link cut)", s.step, m)
		return true
	}
	s.tracef("step %d: deliver %s", s.step, m)
	s.nodes[m.To].handle(m)
	s.checkInvariants()
	return true
}

// RunUntilIdle drains the event queue, returning false if maxSteps is hit.
func (s *Sim) RunUntilIdle(maxSteps int) bool {
	for len(s.queue) > 0 {
		if maxSteps <= 0 {
			return false
		}
		s.Step()
		maxSteps--
	}
	return true
}

func (s *Sim) recordCommit(e CommitEvidence) {
	s.Evidence = append(s.Evidence, e)
	s.tracef("step %d: %s", s.step, e)
}

// --- Safety invariants ----------------------------------------------------

// checkInvariants runs after every delivered message:
//  1. commitIndex never decreases on any node;
//  2. any two nodes agree on every entry both have committed
//     (the committed prefix is never overwritten);
//  3. the globally witnessed committed prefix is immutable.
func (s *Sim) checkInvariants() {
	for _, id := range s.ids {
		n := s.nodes[id]
		if n.commitIndex < s.maxCommits[id] {
			s.violationf("node %s: commitIndex regressed %d -> %d", id, s.maxCommits[id], n.commitIndex)
		}
		if n.commitIndex > s.maxCommits[id] {
			s.maxCommits[id] = n.commitIndex
		}
		for idx := 1; idx <= n.commitIndex; idx++ {
			got := n.log[idx-1]
			if want, ok := s.committed[idx]; ok && want != got {
				s.violationf("node %s: committed entry at index=%d changed %s -> %s",
					id, idx, want, got)
			} else if !ok {
				s.committed[idx] = got
			}
		}
	}
	for _, a := range s.ids {
		for _, b := range s.ids {
			na, nb := s.nodes[a], s.nodes[b]
			limit := na.commitIndex
			if nb.commitIndex < limit {
				limit = nb.commitIndex
			}
			for idx := 1; idx <= limit; idx++ {
				if na.log[idx-1] != nb.log[idx-1] {
					s.violationf("committed prefix divergence at index=%d: %s has %s, %s has %s",
						idx, a, na.log[idx-1], b, nb.log[idx-1])
				}
			}
		}
	}
}

// --- Helpers ---------------------------------------------------------------

func sortedKeys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// FormatLog renders a node's log compactly, e.g. [(t1,"A") (t2,"B")].
func FormatLog(log []Entry) string {
	parts := make([]string, len(log))
	for i, e := range log {
		parts[i] = e.String()
	}
	return "[" + strings.Join(parts, " ") + "]"
}
