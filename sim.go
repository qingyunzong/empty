// Package repsim simulates a replicated log with safe membership changes
// via joint consensus: a configuration switch first commits a joint
// (old+new) configuration whose commits require a majority of BOTH the
// old and the new sets; once the final configuration entry commits, only
// the new set arbitrates. Every commit emits an arbitration certificate,
// and duplicate configuration events are idempotent.
package repsim

import "fmt"

// EntryKind classifies log entries.
type EntryKind int

const (
	KindCommand EntryKind = iota // regular client command
	KindJoint                    // enter joint configuration Old+New
	KindFinal                    // finalize to the new configuration only
)

func (k EntryKind) String() string {
	switch k {
	case KindCommand:
		return "command"
	case KindJoint:
		return "joint"
	case KindFinal:
		return "final"
	}
	return "unknown"
}

// Entry is a single replicated log record. Config entries carry the
// membership they install once committed.
type Entry struct {
	Index      int
	Term       int
	Kind       EntryKind
	Cmd        string
	Membership Membership
}

// Node is a simulated replica.
type Node struct {
	ID          string
	Log         []Entry
	CommitIndex int
	Alive       bool
}

// EventKind classifies trace events.
type EventKind string

const (
	EvPropose   EventKind = "propose"
	EvReplicate EventKind = "replicate"
	EvCommit    EventKind = "commit"
	EvCrash     EventKind = "crash"
	EvRecover   EventKind = "recover"
	EvIsolate   EventKind = "isolate"
	EvHeal      EventKind = "heal"
	EvConfig    EventKind = "config-change"
)

// Event is one recorded step of the fault trace.
type Event struct {
	Seq    int
	Kind   EventKind
	Node   string
	Index  int
	Detail string
}

// ChangePhase tracks a membership change.
type ChangePhase int

const (
	PhaseNone ChangePhase = iota
	PhaseJointProposed
	PhaseJointCommitted
	PhaseDone
)

func (p ChangePhase) String() string {
	switch p {
	case PhaseNone:
		return "none"
	case PhaseJointProposed:
		return "joint-proposed"
	case PhaseJointCommitted:
		return "joint-committed"
	case PhaseDone:
		return "done"
	}
	return "unknown"
}

// ChangeResult describes the state of a membership-change request.
type ChangeResult struct {
	Target     []string
	Phase      ChangePhase
	JointIndex int // log index of the joint entry, 0 if none
	FinalIndex int // log index of the final entry, 0 if none
}

// Sim is a deterministic single-leader replication simulator with
// explicit fault injection and stepwise replication (Tick).
type Sim struct {
	Term   int
	Leader string

	Nodes map[string]*Node
	order []string

	initial    Membership // boot configuration
	membership Membership // committed configuration known to the leader
	change     *ChangeResult

	isolated map[string]bool // nodes unreachable from the leader

	Events []Event
	Certs  []CommitCertificate
}

// NewSim creates a cluster with the given voters and leader.
func NewSim(leader string, members []string) *Sim {
	s := &Sim{
		Term:     1,
		Leader:   leader,
		Nodes:    map[string]*Node{},
		initial:  Membership{Old: sortedCopy(members)},
		isolated: map[string]bool{},
	}
	s.membership = s.initial
	for _, id := range members {
		s.ensureNode(id)
	}
	if _, ok := s.Nodes[leader]; !ok {
		s.ensureNode(leader)
	}
	return s
}

func (s *Sim) ensureNode(id string) *Node {
	if n, ok := s.Nodes[id]; ok {
		return n
	}
	n := &Node{ID: id, Alive: true}
	s.Nodes[id] = n
	s.order = append(s.order, id)
	return n
}

func (s *Sim) record(kind EventKind, node string, index int, detail string) {
	s.Events = append(s.Events, Event{Seq: len(s.Events) + 1, Kind: kind, Node: node, Index: index, Detail: detail})
}

// Membership returns the leader's committed configuration.
func (s *Sim) Membership() Membership { return s.membership }

// Change returns the current membership-change state, or nil.
func (s *Sim) Change() *ChangeResult { return s.change }

// leaderConfig is the configuration the leader currently replicates
// under: the one installed by the latest config entry in its log,
// falling back to the boot configuration.
func (s *Sim) leaderConfig() Membership {
	n := s.Nodes[s.Leader]
	for i := len(n.Log) - 1; i >= 0; i-- {
		if n.Log[i].Kind != KindCommand {
			return n.Log[i].Membership
		}
	}
	return s.initial
}

func (s *Sim) appendEntry(kind EntryKind, cmd string, m Membership) int {
	n := s.Nodes[s.Leader]
	e := Entry{Index: len(n.Log) + 1, Term: s.Term, Kind: kind, Cmd: cmd, Membership: m}
	n.Log = append(n.Log, e)
	return e.Index
}

// Propose appends a client command to the leader's log.
func (s *Sim) Propose(cmd string) int {
	idx := s.appendEntry(KindCommand, cmd, Membership{})
	s.record(EvPropose, s.Leader, idx, fmt.Sprintf("cmd=%q", cmd))
	return idx
}

// ChangeMembership switches the cluster to target via joint consensus.
// It is idempotent: repeating the same target while a change is in
// progress or after it completed returns the existing result without
// appending duplicate configuration entries. A conflicting target while
// a change is in progress is rejected.
func (s *Sim) ChangeMembership(target []string) (ChangeResult, error) {
	key := keyOf(target)
	if s.change != nil && keyOf(s.change.Target) == key {
		// Duplicate configuration event: no-op.
		return *s.change, nil
	}
	if s.change != nil && s.change.Phase != PhaseDone {
		return ChangeResult{}, fmt.Errorf("membership change to %v already in progress (phase %s)",
			s.change.Target, s.change.Phase)
	}
	if !s.membership.Joint() && keyOf(s.membership.Old) == key {
		// Already running the target configuration: no-op.
		s.change = &ChangeResult{Target: sortedCopy(target), Phase: PhaseDone}
		return *s.change, nil
	}
	for _, id := range target {
		s.ensureNode(id)
	}
	joint := Membership{Old: sortedCopy(s.membership.Old), New: sortedCopy(target)}
	idx := s.appendEntry(KindJoint, "", joint)
	s.change = &ChangeResult{Target: sortedCopy(target), Phase: PhaseJointProposed, JointIndex: idx}
	s.record(EvConfig, s.Leader, idx, fmt.Sprintf("joint old=%v new=%v", joint.Old, joint.New))
	return *s.change, nil
}

// Crash kills a node; Recover brings it back. Isolate cuts a node off
// from the leader; Heal restores all connectivity.
func (s *Sim) Crash(id string) {
	s.Nodes[id].Alive = false
	s.record(EvCrash, id, 0, "")
}

func (s *Sim) Recover(id string) {
	s.Nodes[id].Alive = true
	s.record(EvRecover, id, 0, "")
}

func (s *Sim) Isolate(ids ...string) {
	for _, id := range ids {
		s.isolated[id] = true
		s.record(EvIsolate, id, 0, "")
	}
}

func (s *Sim) Heal() {
	s.isolated = map[string]bool{}
	s.record(EvHeal, "", 0, "")
}

// Tick runs one round: the leader appends the final configuration entry
// once the joint entry is committed, replicates its log to all reachable
// followers, then advances the commit index as far as the current
// configuration's quorum(s) allow, emitting a certificate per commit.
func (s *Sim) Tick() {
	leader := s.Nodes[s.Leader]
	if !leader.Alive {
		return
	}

	// Joint committed but final not yet proposed: propose it.
	if s.change != nil && s.change.Phase == PhaseJointCommitted && s.change.FinalIndex == 0 {
		m := s.leaderConfig()
		if m.Joint() {
			idx := s.appendEntry(KindFinal, "", Membership{Old: sortedCopy(m.New)})
			s.change.FinalIndex = idx
			s.record(EvConfig, s.Leader, idx, fmt.Sprintf("final new=%v", m.New))
		}
	}

	// Replicate to reachable followers.
	for _, id := range s.order {
		n := s.Nodes[id]
		if id == s.Leader || !n.Alive || s.isolated[id] {
			continue
		}
		if len(n.Log) < len(leader.Log) {
			n.Log = append(n.Log[:len(n.Log):len(n.Log)], leader.Log[len(n.Log):]...)
			s.record(EvReplicate, id, len(n.Log), fmt.Sprintf("from=%s", s.Leader))
		}
		if n.CommitIndex < leader.CommitIndex {
			n.CommitIndex = min(leader.CommitIndex, len(n.Log))
		}
	}

	// Advance commit index under the leader's current configuration.
	cfg := s.leaderConfig()
	for i := leader.CommitIndex + 1; i <= len(leader.Log); i++ {
		voters := s.votersFor(i, cfg)
		if !cfg.QuorumSatisfied(voters) {
			break
		}
		leader.CommitIndex = i
		cert := CommitCertificate{
			Index:      i,
			Term:       leader.Log[i-1].Term,
			Kind:       leader.Log[i-1].Kind,
			Membership: cfg,
			Voters:     voters,
			OldQuorum:  intersect(cfg.Old, voters),
		}
		if cfg.Joint() {
			cert.NewQuorum = intersect(cfg.New, voters)
		}
		s.Certs = append(s.Certs, cert)
		s.record(EvCommit, s.Leader, i, fmt.Sprintf("voters=%v", voters))
		s.applyConfig(leader.Log[i-1])
	}
}

func (s *Sim) votersFor(index int, cfg Membership) []string {
	set := cfg.Old
	if cfg.Joint() {
		set = union(cfg.Old, cfg.New)
	}
	var voters []string
	for _, id := range set {
		n := s.Nodes[id]
		if n != nil && n.Alive && !s.isolated[id] && len(n.Log) >= index {
			voters = append(voters, id)
		}
	}
	return sortedCopy(voters)
}

func (s *Sim) applyConfig(e Entry) {
	switch e.Kind {
	case KindJoint:
		s.membership = e.Membership
		if s.change != nil && s.change.Phase == PhaseJointProposed {
			s.change.Phase = PhaseJointCommitted
		}
	case KindFinal:
		s.membership = Membership{Old: sortedCopy(e.Membership.Old)}
		if s.change != nil {
			s.change.Phase = PhaseDone
		}
	}
}

// Committed reports the leader's commit index.
func (s *Sim) Committed() int { return s.Nodes[s.Leader].CommitIndex }
