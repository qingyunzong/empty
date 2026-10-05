// Package raftsim is a deterministic, event-driven simulation of a
// Raft-style replicated log. It uses no real network: every message is an
// explicit event queued in a Sim and delivered one step at a time.
package raftsim

import "fmt"

// Role is the Raft server role.
type Role int

const (
	Follower Role = iota
	Candidate
	Leader
)

func (r Role) String() string {
	switch r {
	case Follower:
		return "follower"
	case Candidate:
		return "candidate"
	case Leader:
		return "leader"
	}
	return "?"
}

// Entry is a single log record. Term is the leader term that created it.
type Entry struct {
	Term  int
	Value string
}

func (e Entry) String() string { return fmt.Sprintf("(t%d,%q)", e.Term, e.Value) }

// MsgType enumerates the explicit message events.
type MsgType int

const (
	MsgRequestVote MsgType = iota
	MsgVoteResp
	MsgAppend
	MsgAppendResp
)

func (t MsgType) String() string {
	switch t {
	case MsgRequestVote:
		return "RequestVote"
	case MsgVoteResp:
		return "VoteResp"
	case MsgAppend:
		return "AppendEntries"
	case MsgAppendResp:
		return "AppendResp"
	}
	return "?"
}

// Message is one explicit event exchanged between two nodes.
type Message struct {
	Type MsgType
	From string
	To   string
	Term int

	// RequestVote / VoteResp
	LastLogIndex int
	LastLogTerm  int
	Granted      bool

	// AppendEntries
	PrevLogIndex int
	PrevLogTerm  int
	Entries      []Entry
	LeaderCommit int

	// AppendResp
	Success    bool
	MatchIndex int
}

func (m Message) String() string {
	base := fmt.Sprintf("%s %s->%s term=%d", m.Type, m.From, m.To, m.Term)
	switch m.Type {
	case MsgRequestVote:
		return base + fmt.Sprintf(" last=(%d,t%d)", m.LastLogIndex, m.LastLogTerm)
	case MsgVoteResp:
		return base + fmt.Sprintf(" granted=%v", m.Granted)
	case MsgAppend:
		return base + fmt.Sprintf(" prev=(%d,t%d) entries=%v leaderCommit=%d",
			m.PrevLogIndex, m.PrevLogTerm, m.Entries, m.LeaderCommit)
	case MsgAppendResp:
		return base + fmt.Sprintf(" success=%v match=%d", m.Success, m.MatchIndex)
	}
	return base
}

// Node is one simulated Raft server. All state transitions happen inside
// message handlers invoked by Sim.Step; there are no timers or goroutines.
type Node struct {
	id          string
	role        Role
	currentTerm int
	votedFor    string
	log         []Entry // log[i] holds the entry at 1-based index i+1
	commitIndex int     // 1-based; 0 means nothing committed

	// Leader volatile state.
	nextIndex  map[string]int
	matchIndex map[string]int

	// Candidate volatile state.
	votesGot map[string]bool

	sim *Sim
}

func (n *Node) ID() string       { return n.id }
func (n *Node) Role() Role       { return n.role }
func (n *Node) Term() int        { return n.currentTerm }
func (n *Node) CommitIndex() int { return n.commitIndex }
func (n *Node) Log() []Entry     { return append([]Entry(nil), n.log...) }
func (n *Node) lastIndex() int   { return len(n.log) }

func (n *Node) lastTerm() int {
	if len(n.log) == 0 {
		return 0
	}
	return n.log[len(n.log)-1].Term
}

// termAt returns the term of the 1-based log index, 0 for the sentinel.
func (n *Node) termAt(idx int) int {
	if idx == 0 {
		return 0
	}
	return n.log[idx-1].Term
}

// setTerm is the only place currentTerm changes; it enforces monotonicity.
func (n *Node) setTerm(t int) {
	if t < n.currentTerm {
		n.sim.violationf("node %s: term moved backwards %d -> %d", n.id, n.currentTerm, t)
		return
	}
	if t > n.currentTerm {
		n.currentTerm = t
		n.votedFor = ""
		n.role = Follower
	}
}

func (n *Node) becomeFollower() { n.role = Follower }

func (n *Node) majority() int { return len(n.sim.ids)/2 + 1 }

// startElection bumps the term, votes for itself and emits RequestVote events.
func (n *Node) startElection() {
	n.setTerm(n.currentTerm + 1)
	n.role = Candidate
	n.votedFor = n.id
	n.votesGot = map[string]bool{n.id: true}
	n.sim.tracef("step %d: %s starts election term=%d", n.sim.step, n.id, n.currentTerm)
	for _, peer := range n.sim.ids {
		if peer == n.id {
			continue
		}
		n.sim.send(Message{
			Type: MsgRequestVote, From: n.id, To: peer, Term: n.currentTerm,
			LastLogIndex: n.lastIndex(), LastLogTerm: n.lastTerm(),
		})
	}
}

// propose appends a client value; only valid on a leader.
func (n *Node) propose(value string) {
	if n.role != Leader {
		n.sim.tracef("step %d: %s rejects proposal %q (role=%s)", n.sim.step, n.id, value, n.role)
		return
	}
	n.log = append(n.log, Entry{Term: n.currentTerm, Value: value})
	n.matchIndex[n.id] = n.lastIndex()
	n.nextIndex[n.id] = n.lastIndex() + 1
	n.sim.tracef("step %d: %s appends %s at index=%d", n.sim.step, n.id, n.log[len(n.log)-1], n.lastIndex())
	n.broadcastAppend()
}

// broadcastAppend sends each peer the entries it is missing.
func (n *Node) broadcastAppend() {
	for _, peer := range n.sim.ids {
		if peer == n.id {
			continue
		}
		n.sendAppend(peer)
	}
}

func (n *Node) sendAppend(peer string) {
	next := n.nextIndex[peer]
	prev := next - 1
	entries := append([]Entry(nil), n.log[prev:]...)
	n.sim.send(Message{
		Type: MsgAppend, From: n.id, To: peer, Term: n.currentTerm,
		PrevLogIndex: prev, PrevLogTerm: n.termAt(prev),
		Entries: entries, LeaderCommit: n.commitIndex,
	})
}

// handle processes one delivered message event.
func (n *Node) handle(m Message) {
	if m.Term > n.currentTerm {
		n.sim.tracef("step %d: %s sees higher term %d > %d, steps down",
			n.sim.step, n.id, m.Term, n.currentTerm)
		n.setTerm(m.Term)
	}
	switch m.Type {
	case MsgRequestVote:
		n.handleRequestVote(m)
	case MsgVoteResp:
		n.handleVoteResp(m)
	case MsgAppend:
		n.handleAppend(m)
	case MsgAppendResp:
		n.handleAppendResp(m)
	}
}

func (n *Node) handleRequestVote(m Message) {
	grant := false
	upToDate := m.LastLogTerm > n.lastTerm() ||
		(m.LastLogTerm == n.lastTerm() && m.LastLogIndex >= n.lastIndex())
	if m.Term >= n.currentTerm && (n.votedFor == "" || n.votedFor == m.From) && upToDate {
		grant = true
		n.votedFor = m.From
		n.role = Follower
	}
	n.sim.tracef("step %d: %s votes for %s term=%d granted=%v (votedFor=%q upToDate=%v)",
		n.sim.step, n.id, m.From, m.Term, grant, n.votedFor, upToDate)
	n.sim.send(Message{Type: MsgVoteResp, From: n.id, To: m.From, Term: n.currentTerm, Granted: grant})
}

func (n *Node) handleVoteResp(m Message) {
	if n.role != Candidate || m.Term != n.currentTerm || !m.Granted {
		return
	}
	n.votesGot[m.From] = true
	if len(n.votesGot) >= n.majority() {
		n.role = Leader
		n.nextIndex = map[string]int{}
		n.matchIndex = map[string]int{}
		for _, peer := range n.sim.ids {
			n.nextIndex[peer] = n.lastIndex() + 1
			n.matchIndex[peer] = 0
		}
		n.matchIndex[n.id] = n.lastIndex()
		n.sim.tracef("step %d: %s becomes LEADER term=%d votes=%v",
			n.sim.step, n.id, n.currentTerm, sortedKeys(n.votesGot))
		n.broadcastAppend()
	}
}

func (n *Node) handleAppend(m Message) {
	if m.Term < n.currentTerm {
		n.sim.send(Message{Type: MsgAppendResp, From: n.id, To: m.From, Term: n.currentTerm, Success: false})
		return
	}
	// A valid leader exists for this term; step down if we thought otherwise.
	n.becomeFollower()

	// Consistency check: the entry before the new ones must match.
	if m.PrevLogIndex > n.lastIndex() || n.termAt(m.PrevLogIndex) != m.PrevLogTerm {
		n.sim.tracef("step %d: %s rejects append from %s: prev=(%d,t%d) inconsistent with last=(%d,t%d)",
			n.sim.step, n.id, m.From, m.PrevLogIndex, m.PrevLogTerm, n.lastIndex(), n.lastTerm())
		n.sim.send(Message{Type: MsgAppendResp, From: n.id, To: m.From, Term: n.currentTerm, Success: false})
		return
	}

	// Apply entries, truncating the first conflicting uncommitted suffix.
	for i, e := range m.Entries {
		idx := m.PrevLogIndex + 1 + i
		if idx <= n.lastIndex() {
			if n.log[idx-1].Term != e.Term {
				if idx <= n.commitIndex {
					n.sim.violationf("node %s: would truncate committed entry at index=%d (commitIndex=%d)",
						n.id, idx, n.commitIndex)
				}
				n.sim.tracef("step %d: %s truncates uncommitted conflict at index=%d: was %v, now %v",
					n.sim.step, n.id, idx, n.log[idx-1:], m.Entries[i:])
				n.sim.Truncations++
				n.log = n.log[:idx-1]
			} else {
				continue
			}
		}
		n.log = append(n.log, m.Entries[i:]...)
		break
	}
	match := m.PrevLogIndex + len(m.Entries)

	// Follow the leader's commit index.
	if m.LeaderCommit > n.commitIndex {
		newCommit := m.LeaderCommit
		if newCommit > n.lastIndex() {
			newCommit = n.lastIndex()
		}
		n.commitIndex = newCommit
		n.sim.tracef("step %d: %s advances commitIndex to %d (leaderCommit=%d)",
			n.sim.step, n.id, n.commitIndex, m.LeaderCommit)
	}
	n.sim.send(Message{Type: MsgAppendResp, From: n.id, To: m.From, Term: n.currentTerm,
		Success: true, MatchIndex: match})
}

func (n *Node) handleAppendResp(m Message) {
	if n.role != Leader || m.Term != n.currentTerm {
		return
	}
	if !m.Success {
		if n.nextIndex[m.From] > 1 {
			n.nextIndex[m.From]--
		}
		n.sendAppend(m.From)
		return
	}
	if m.MatchIndex > n.matchIndex[m.From] {
		n.matchIndex[m.From] = m.MatchIndex
		n.nextIndex[m.From] = m.MatchIndex + 1
	}
	n.advanceCommit()
}

// advanceCommit applies the Raft rule: only entries from the leader's own
// term may be committed by counting replicas.
func (n *Node) advanceCommit() {
	for idx := n.lastIndex(); idx > n.commitIndex; idx-- {
		if n.log[idx-1].Term != n.currentTerm {
			continue
		}
		count := 0
		var replicated []string
		for _, peer := range n.sim.ids {
			if n.matchIndex[peer] >= idx {
				count++
				replicated = append(replicated, peer)
			}
		}
		if count >= n.majority() {
			n.commitIndex = idx
			n.sim.recordCommit(CommitEvidence{
				Step: n.sim.step, Leader: n.id, Term: n.currentTerm,
				Index: idx, Entry: n.log[idx-1], ReplicatedOn: replicated,
			})
			// Propagate the new leaderCommit promptly.
			n.broadcastAppend()
		}
		break
	}
}
