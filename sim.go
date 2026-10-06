package raftsim

import (
	"fmt"
	"sort"
	"strings"
)

// CommitEvidence records proof that an entry was committed: the term and
// index, plus the quorum of nodes whose matchIndex covered the entry at
// commit time.
type CommitEvidence struct {
	Leader int
	Term   int
	Index  int
	Cmd    string
	Quorum []int
}

func (e CommitEvidence) String() string {
	return fmt.Sprintf("COMMIT-EVIDENCE leader=n%d term=%d index=%d cmd=%q quorum=%v",
		e.Leader, e.Term, e.Index, e.Cmd, e.Quorum)
}

// Sim is a deterministic discrete-event simulator: a FIFO queue of explicit
// messages, an optional partition mask, and a step trace. No goroutines, no
// real time, no real network.
type Sim struct {
	Nodes   []*Node
	queue   []Msg
	blocked map[[2]int]bool // directed pairs currently cut by a partition

	Trace    []string         // one line per simulation step
	Evidence []CommitEvidence // commit proofs in order
	Step     int
	Quiet    bool // suppress Trace recording (used by state-space search)
	writeSeq int

	lastTerm []int // per-node term high-water mark, for monotonicity checks
}

// NewSim builds a cluster of size n (use 3 for the required topology).
func NewSim(n int) *Sim {
	s := &Sim{blocked: map[[2]int]bool{}}
	for i := 0; i < n; i++ {
		s.Nodes = append(s.Nodes, NewNode(i, n))
		s.lastTerm = append(s.lastTerm, 0)
	}
	return s
}

func (s *Sim) majority() int { return len(s.Nodes)/2 + 1 }

func (s *Sim) logf(format string, args ...interface{}) {
	s.Step++
	if s.Quiet {
		return
	}
	s.Trace = append(s.Trace, fmt.Sprintf("step %03d: %s", s.Step, fmt.Sprintf(format, args...)))
}

// Timeout fires an election timeout on node i: the node immediately starts
// an election and its RequestVote messages are enqueued.
func (s *Sim) Timeout(i int) {
	n := s.Nodes[i]
	out := n.Handle(Msg{Kind: MTimeout, From: i, To: i}, s.majority())
	s.logf("timeout on n%d -> %s term=%d", i, n.Role, n.Term)
	for _, m := range out {
		s.send(m)
	}
}

// ClientWrite appends cmd to the current leader's log and broadcasts it.
// Returns false if there is no leader.
func (s *Sim) ClientWrite(cmd string) bool {
	leader := s.Leader()
	if leader < 0 {
		return false
	}
	n := s.Nodes[leader]
	out := n.AppendClientCmd(cmd)
	s.logf("client write %q on leader n%d (index %d, term %d)",
		cmd, leader, n.lastLogIndex(), n.Term)
	for _, m := range out {
		s.send(m)
	}
	return true
}

// ClientWriteSeq writes an auto-numbered command; used by the enumerator.
func (s *Sim) ClientWriteSeq() bool {
	s.writeSeq++
	return s.ClientWrite(fmt.Sprintf("w%d", s.writeSeq))
}

// Heartbeat makes the current leader broadcast a (possibly empty)
// AppendEntries round, which is also how its commit index propagates.
func (s *Sim) Heartbeat() bool {
	leader := s.Leader()
	if leader < 0 {
		return false
	}
	n := s.Nodes[leader]
	s.logf("heartbeat from leader n%d (term %d, commit=%d)", leader, n.Term, n.CommitIdx)
	for _, m := range n.broadcastAppend() {
		s.send(m)
	}
	return true
}

// Leader returns the id of the highest-term leader (the current one), or -1
// if there is no leader or two leaders tie in the same term.
func (s *Sim) Leader() int {
	leader := -1
	for _, n := range s.Nodes {
		if n.Role == Leader {
			if leader != -1 && s.Nodes[leader].Term >= n.Term {
				if s.Nodes[leader].Term == n.Term {
					return -1 // same-term split brain: no stable leader
				}
				continue
			}
			leader = n.ID
		}
	}
	return leader
}

// Partition replaces the connectivity mask: nodes in different groups cannot
// exchange messages. Partition({0},{1,2}) isolates node 0; Partition() heals.
func (s *Sim) Partition(groups ...[]int) {
	s.blocked = map[[2]int]bool{}
	for a := 0; a < len(groups); a++ {
		for b := a + 1; b < len(groups); b++ {
			for _, x := range groups[a] {
				for _, y := range groups[b] {
					s.blocked[[2]int{x, y}] = true
					s.blocked[[2]int{y, x}] = true
				}
			}
		}
	}
	if len(groups) == 0 {
		s.logf("partition healed (fully connected)")
	} else {
		s.logf("partition set: %v", groups)
	}
}

func (s *Sim) send(m Msg) { s.queue = append(s.queue, m) }

// DeliverNext delivers the head message of the queue. Returns false if empty.
// Messages crossing a partition cut are dropped (and logged), modelling loss.
func (s *Sim) DeliverNext() bool {
	if len(s.queue) == 0 {
		return false
	}
	m := s.queue[0]
	s.queue = s.queue[1:]
	if m.Kind != MTimeout && s.blocked[[2]int{m.From, m.To}] {
		s.logf("DROP %s (partition)", m)
		return true
	}
	n := s.Nodes[m.To]
	before := fmt.Sprintf("n%d %s term=%d votedFor=%d log=%v commit=%d",
		n.ID, n.Role, n.Term, n.VotedFor, n.Log, n.CommitIdx)
	out := n.Handle(m, s.majority())
	s.logf("deliver %s | %s -> n%d %s term=%d log=%v commit=%d",
		m, before, n.ID, n.Role, n.Term, n.Log, n.CommitIdx)
	if n.PendingCommit != nil {
		pc := n.PendingCommit
		n.PendingCommit = nil
		ev := CommitEvidence{
			Leader: n.ID, Term: pc.Term, Index: pc.Index,
			Cmd:    n.Log[pc.Index-1].Cmd,
			Quorum: s.quorumFor(n, pc.Index),
		}
		s.Evidence = append(s.Evidence, ev)
		s.logf("%s", ev)
	}
	for _, om := range out {
		s.send(om)
	}
	return true
}

func (s *Sim) quorumFor(leader *Node, index int) []int {
	var q []int
	for peer := range leader.matchIndex {
		if leader.matchIndex[peer] >= index {
			q = append(q, peer)
		}
	}
	sort.Ints(q)
	return q
}

// Drain delivers until the queue is empty.
func (s *Sim) Drain() {
	for s.DeliverNext() {
	}
}

// QueueLen reports pending message count.
func (s *Sim) QueueLen() int { return len(s.queue) }

// CheckSafety verifies the core invariants and returns the first violation:
//  1. terms are monotonically non-decreasing per node;
//  2. no node ever truncated a committed entry;
//  3. committed prefixes agree across all nodes (state machine safety).
func (s *Sim) CheckSafety() error {
	for _, n := range s.Nodes {
		if n.Term < s.lastTerm[n.ID] {
			return fmt.Errorf("n%d term regressed %d -> %d", n.ID, s.lastTerm[n.ID], n.Term)
		}
		s.lastTerm[n.ID] = n.Term
		if n.TruncatedCommitted {
			return fmt.Errorf("n%d truncated a committed entry", n.ID)
		}
	}
	for a := 0; a < len(s.Nodes); a++ {
		for b := a + 1; b < len(s.Nodes); b++ {
			na, nb := s.Nodes[a], s.Nodes[b]
			limit := na.CommitIdx
			if nb.CommitIdx < limit {
				limit = nb.CommitIdx
			}
			for i := 0; i < limit; i++ {
				if na.Log[i] != nb.Log[i] {
					return fmt.Errorf("committed prefix diverges at index %d: n%d=%v n%d=%v",
						i+1, a, na.Log[i], b, nb.Log[i])
				}
			}
		}
	}
	return nil
}

// Clone deep-copies the simulator for state-space exploration.
func (s *Sim) Clone() *Sim {
	c := &Sim{
		Step:     s.Step,
		Quiet:    s.Quiet,
		writeSeq: s.writeSeq,
		blocked:  map[[2]int]bool{},
		lastTerm: append([]int(nil), s.lastTerm...),
		Evidence: append([]CommitEvidence(nil), s.Evidence...),
		Trace:    append([]string(nil), s.Trace...),
	}
	for k, v := range s.blocked {
		c.blocked[k] = v
	}
	for _, n := range s.Nodes {
		nn := *n
		nn.Log = append([]Entry(nil), n.Log...)
		nn.votes = map[int]bool{}
		for k, v := range n.votes {
			nn.votes[k] = v
		}
		nn.nextIndex = append([]int(nil), n.nextIndex...)
		nn.matchIndex = append([]int(nil), n.matchIndex...)
		if n.PendingCommit != nil {
			pc := *n.PendingCommit
			nn.PendingCommit = &pc
		}
		c.Nodes = append(c.Nodes, &nn)
	}
	for _, m := range s.queue {
		m.Entries = append([]Entry(nil), m.Entries...)
		c.queue = append(c.queue, m)
	}
	return c
}

// Hash returns a canonical fingerprint of the full state, for dedup.
func (s *Sim) Hash() string {
	var b strings.Builder
	for _, n := range s.Nodes {
		fmt.Fprintf(&b, "%d:%d:%d:%d:%d:%v:%v|", n.ID, n.Role, n.Term,
			n.VotedFor, n.CommitIdx, n.Log, n.matchIndex)
	}
	for _, m := range s.queue {
		fmt.Fprintf(&b, "%v;", m)
	}
	var pairs []string
	for p := range s.blocked {
		pairs = append(pairs, fmt.Sprintf("%d-%d", p[0], p[1]))
	}
	sort.Strings(pairs)
	fmt.Fprintf(&b, "#%s#%d", strings.Join(pairs, ","), s.writeSeq)
	return b.String()
}
