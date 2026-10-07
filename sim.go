package jointsim

import "fmt"

type MsgKind int

const (
	MsgAppend MsgKind = iota
	MsgResp
)

type Message struct {
	Kind         MsgKind
	From, To     string
	PrevIndex    int
	Entries      []Entry
	LeaderCommit int
	OK           bool
	Match        int
}

type EventKind int

const (
	EvSend EventKind = iota
	EvDeliver
	EvDrop
	EvDuplicate
	EvCommit
	EvConfigPropose
	EvConfigCommit
	EvConfigFinal
)

type Event struct {
	Kind   EventKind
	Msg    Message
	Cert   *Certificate
	Joint  *Config
	Target []string
}

type Faults interface {
	Filter(m Message) (drop bool, duplicates int)
}

type NoFaults struct{}

func (NoFaults) Filter(Message) (bool, int) { return false, 0 }

type Sim struct {
	Term   int
	Leader string
	Faults Faults
	Trace  []Event
	nodes  map[string]*Node
	match  map[string]int
	queue  []Message

	initial []string
	stable  []string
	target  []string
	joint   *Config

	jointIdx       int
	finalIdx       int
	finalCommitted bool
}

func NewSim(members []string, leader string, faults Faults) *Sim {
	if faults == nil {
		faults = NoFaults{}
	}
	s := &Sim{
		Term:    1,
		Leader:  leader,
		Faults:  faults,
		nodes:   map[string]*Node{},
		match:   map[string]int{},
		initial: sortedCopy(members),
		stable:  sortedCopy(members),
	}
	s.node(leader)
	return s
}

func (s *Sim) node(id string) *Node {
	n, ok := s.nodes[id]
	if !ok {
		n = &Node{ID: id}
		s.nodes[id] = n
	}
	return n
}

func (s *Sim) leader() *Node { return s.node(s.Leader) }

func (s *Sim) Node(id string) *Node { return s.node(id) }

func (s *Sim) LeaderCommit() int { return s.leader().Commit }

func (s *Sim) LeaderLog() []Entry { return s.leader().Log }

func (s *Sim) Propose(cmd string) int {
	e := s.appendEntry(cmd, nil)
	s.broadcast()
	return e.Index
}

// Heartbeat re-broadcasts the leader's log suffixes and commit index,
// e.g. to make progress after a partition heals.
func (s *Sim) Heartbeat() { s.broadcast() }

func (s *Sim) ChangeMembership(newMembers []string) error {
	nm := sortedCopy(newMembers)
	if s.target != nil {
		if equalStrings(s.target, nm) {
			return nil
		}
		return fmt.Errorf("membership change to %v already in progress", s.target)
	}
	if equalStrings(s.stable, nm) {
		return nil
	}
	j := JointConfig(s.stable, nm)
	s.joint = &j
	s.target = nm
	s.finalIdx = 0
	s.finalCommitted = false
	e := s.appendEntry("joint-config", &j)
	s.jointIdx = e.Index
	s.Trace = append(s.Trace, Event{Kind: EvConfigPropose, Joint: &j, Target: nm})
	s.broadcast()
	return nil
}

func (s *Sim) appendEntry(cmd string, cfg *Config) Entry {
	l := s.leader()
	e := Entry{Index: l.lastIndex() + 1, Term: s.Term, Cmd: cmd, Cfg: cfg}
	l.Log = append(l.Log, e)
	return e
}

func (s *Sim) peers() []string {
	set := map[string]bool{s.Leader: true}
	for _, m := range s.stable {
		set[m] = true
	}
	for _, m := range s.target {
		set[m] = true
	}
	return sortedKeys(set)
}

func (s *Sim) broadcast() {
	for _, p := range s.peers() {
		if p != s.Leader {
			s.sendAppend(p)
		}
	}
}

func (s *Sim) sendAppend(to string) {
	l := s.leader()
	from := s.match[to]
	m := Message{
		Kind:         MsgAppend,
		From:         s.Leader,
		To:           to,
		PrevIndex:    from,
		LeaderCommit: l.Commit,
	}
	if from < l.lastIndex() {
		m.Entries = append([]Entry(nil), l.Log[from:]...)
	}
	s.send(m)
}

func (s *Sim) send(m Message) {
	drop, dups := s.Faults.Filter(m)
	if drop {
		s.Trace = append(s.Trace, Event{Kind: EvDrop, Msg: m})
		return
	}
	s.queue = append(s.queue, m)
	s.Trace = append(s.Trace, Event{Kind: EvSend, Msg: m})
	for i := 0; i < dups; i++ {
		s.queue = append(s.queue, m)
		s.Trace = append(s.Trace, Event{Kind: EvDuplicate, Msg: m})
	}
}

func (s *Sim) Step() bool {
	if len(s.queue) == 0 {
		return false
	}
	m := s.queue[0]
	s.queue = s.queue[1:]
	s.Trace = append(s.Trace, Event{Kind: EvDeliver, Msg: m})
	switch m.Kind {
	case MsgAppend:
		s.handleAppend(m)
	case MsgResp:
		s.handleResp(m)
	}
	return true
}

func (s *Sim) Run() {
	for i := 0; i < 1000000 && s.Step(); i++ {
	}
}

func (s *Sim) handleAppend(m Message) {
	n := s.node(m.To)
	match, ok := n.appendEntries(m.PrevIndex, m.Entries)
	if ok && m.LeaderCommit > n.Commit {
		n.Commit = min(m.LeaderCommit, n.lastIndex())
	}
	s.send(Message{Kind: MsgResp, From: m.To, To: m.From, OK: ok, Match: match})
}

func (s *Sim) handleResp(m Message) {
	if m.OK {
		if m.Match > s.match[m.From] {
			s.match[m.From] = m.Match
		}
		s.advanceCommit()
		return
	}
	if m.Match < s.match[m.From] {
		s.match[m.From] = m.Match
	}
	s.sendAppend(m.From)
}

func (s *Sim) commitConfig(n int) Config {
	cfg := SimpleConfig(s.initial)
	for _, e := range s.leader().Log {
		if e.Index > n {
			break
		}
		if e.Cfg == nil {
			continue
		}
		if !e.Cfg.IsJoint() && e.Index == s.finalIdx && !s.finalCommitted {
			cfg = *s.joint
		} else {
			cfg = *e.Cfg
		}
	}
	return cfg
}

func (s *Sim) advanceCommit() {
	l := s.leader()
	advanced := false
	for n := l.Commit + 1; n <= l.lastIndex(); n++ {
		cfg := s.commitConfig(n)
		members := cfg.Members()
		voters := map[string]bool{}
		if members[s.Leader] {
			voters[s.Leader] = true
		}
		for id, mi := range s.match {
			if mi >= n && members[id] {
				voters[id] = true
			}
		}
		if !cfg.Quorum(voters) {
			break
		}
		l.Commit = n
		advanced = true
		cert := &Certificate{Index: n, Term: s.Term, Config: cfg, Voters: sortedKeys(voters)}
		s.Trace = append(s.Trace, Event{Kind: EvCommit, Cert: cert})
		s.onCommit(n)
	}
	if advanced {
		s.broadcast()
	}
}

func (s *Sim) onCommit(n int) {
	e := s.leader().at(n)
	if !e.isConfig() {
		return
	}
	if e.Cfg.IsJoint() {
		s.Trace = append(s.Trace, Event{Kind: EvConfigCommit, Joint: e.Cfg, Target: s.target})
		final := SimpleConfig(s.target)
		s.finalIdx = s.appendEntry("final-config", &final).Index
		return
	}
	s.Trace = append(s.Trace, Event{Kind: EvConfigFinal, Target: s.target})
	s.stable = s.target
	s.target = nil
	s.joint = nil
	s.finalCommitted = true
}
