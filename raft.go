// Package raftsim implements a deterministic, message-event-driven simulation
// of Raft-style log replication on a fixed three-node cluster. It uses no
// real network, timers, or goroutines: every state transition is triggered by
// an explicit message delivered by the Simulator.
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
		return "Follower"
	case Candidate:
		return "Candidate"
	case Leader:
		return "Leader"
	}
	return "?"
}

// Entry is a single replicated log record.
type Entry struct {
	Term int
	Cmd  string
}

func (e Entry) String() string { return fmt.Sprintf("%s@%d", e.Cmd, e.Term) }

// MsgKind enumerates the explicit message events that drive the simulation.
type MsgKind int

const (
	MTimeout MsgKind = iota // self-message: election timeout fires
	MRequestVote
	MVoteResp
	MAppend
	MAppendResp
)

func (k MsgKind) String() string {
	switch k {
	case MTimeout:
		return "Timeout"
	case MRequestVote:
		return "RequestVote"
	case MVoteResp:
		return "VoteResp"
	case MAppend:
		return "AppendEntries"
	case MAppendResp:
		return "AppendResp"
	}
	return "?"
}

// Msg is the single envelope payload type for all protocol messages.
type Msg struct {
	Kind MsgKind
	From int
	To   int
	Term int

	// RequestVote
	LastLogIndex int
	LastLogTerm  int

	// VoteResp
	Granted bool

	// AppendEntries
	PrevLogIndex int
	PrevLogTerm  int
	Entries      []Entry
	LeaderCommit int

	// AppendResp
	Success    bool
	MatchIndex int
}

func (m Msg) String() string {
	switch m.Kind {
	case MTimeout:
		return fmt.Sprintf("Timeout n%d", m.To)
	case MRequestVote:
		return fmt.Sprintf("RequestVote n%d->n%d term=%d last=%d@%d",
			m.From, m.To, m.Term, m.LastLogIndex, m.LastLogTerm)
	case MVoteResp:
		return fmt.Sprintf("VoteResp n%d->n%d term=%d granted=%v",
			m.From, m.To, m.Term, m.Granted)
	case MAppend:
		return fmt.Sprintf("AppendEntries n%d->n%d term=%d prev=%d@%d entries=%v commit=%d",
			m.From, m.To, m.Term, m.PrevLogIndex, m.PrevLogTerm, m.Entries, m.LeaderCommit)
	case MAppendResp:
		return fmt.Sprintf("AppendResp n%d->n%d term=%d ok=%v match=%d",
			m.From, m.To, m.Term, m.Success, m.MatchIndex)
	}
	return "?"
}

// Node is one simulated Raft server. All fields are plain data; the node only
// mutates in response to Handle being called by the Simulator.
type Node struct {
	ID        int
	Role      Role
	Term      int
	VotedFor  int // -1 = none
	Log       []Entry
	CommitIdx int
	LeaderID  int // -1 = unknown

	votes      map[int]bool // candidates: votes received this term
	nextIndex  []int        // leader: next log index to send each peer
	matchIndex []int        // leader: highest replicated index per peer

	// Safety instrumentation consumed by the Simulator's checker.
	TruncatedCommitted bool          // set if a committed entry was ever overwritten
	PendingCommit      *CommitNotice // set when the leader advances CommitIdx
}

// NewNode creates a follower with an empty log.
func NewNode(id, clusterSize int) *Node {
	return &Node{
		ID:         id,
		Role:       Follower,
		VotedFor:   -1,
		LeaderID:   -1,
		votes:      map[int]bool{},
		nextIndex:  make([]int, clusterSize),
		matchIndex: make([]int, clusterSize),
	}
}

func (n *Node) lastLogIndex() int { return len(n.Log) }

func (n *Node) lastLogTerm() int {
	if len(n.Log) == 0 {
		return 0
	}
	return n.Log[len(n.Log)-1].Term
}

func (n *Node) termAt(index int) int {
	if index <= 0 || index > len(n.Log) {
		return 0
	}
	return n.Log[index-1].Term
}

func (n *Node) becomeFollower(term int) {
	n.Role = Follower
	n.Term = term
	n.VotedFor = -1
	n.votes = map[int]bool{}
}

// Handle processes one inbound message and returns outbound messages. It never
// blocks and never touches the network; the Simulator routes the returns.
func (n *Node) Handle(m Msg, majority int) []Msg {
	switch m.Kind {
	case MTimeout:
		return n.onTimeout()
	case MRequestVote:
		return n.onRequestVote(m)
	case MVoteResp:
		return n.onVoteResp(m, majority)
	case MAppend:
		return n.onAppendEntries(m)
	case MAppendResp:
		return n.onAppendResp(m, majority)
	}
	return nil
}

func (n *Node) onTimeout() []Msg {
	if n.Role == Leader {
		return nil // leaders do not time out
	}
	n.Role = Candidate
	n.Term++
	n.VotedFor = n.ID
	n.LeaderID = -1
	n.votes = map[int]bool{n.ID: true}
	out := make([]Msg, 0, len(n.nextIndex)-1)
	for peer := range n.nextIndex {
		if peer == n.ID {
			continue
		}
		out = append(out, Msg{
			Kind: MRequestVote, From: n.ID, To: peer, Term: n.Term,
			LastLogIndex: n.lastLogIndex(), LastLogTerm: n.lastLogTerm(),
		})
	}
	return out
}

func (n *Node) onRequestVote(m Msg) []Msg {
	if m.Term < n.Term {
		return []Msg{{Kind: MVoteResp, From: n.ID, To: m.From, Term: n.Term, Granted: false}}
	}
	if m.Term > n.Term {
		n.becomeFollower(m.Term)
	}
	upToDate := m.LastLogTerm > n.lastLogTerm() ||
		(m.LastLogTerm == n.lastLogTerm() && m.LastLogIndex >= n.lastLogIndex())
	granted := upToDate && (n.VotedFor == -1 || n.VotedFor == m.From)
	if granted {
		n.VotedFor = m.From
	}
	return []Msg{{Kind: MVoteResp, From: n.ID, To: m.From, Term: n.Term, Granted: granted}}
}

func (n *Node) onVoteResp(m Msg, majority int) []Msg {
	if m.Term > n.Term {
		n.becomeFollower(m.Term)
		return nil
	}
	if n.Role != Candidate || m.Term != n.Term {
		return nil
	}
	if m.Granted {
		n.votes[m.From] = true
	}
	if len(n.votes) < majority {
		return nil
	}
	// Win the election. No automatic heartbeat: AppendEntries are sent on
	// client writes and explicit Heartbeat actions, keeping every message
	// an explicit event in the trace.
	n.Role = Leader
	n.LeaderID = n.ID
	for peer := range n.nextIndex {
		n.nextIndex[peer] = n.lastLogIndex() + 1
		n.matchIndex[peer] = 0
	}
	n.matchIndex[n.ID] = n.lastLogIndex()
	return nil
}

func (n *Node) onAppendEntries(m Msg) []Msg {
	if m.Term < n.Term {
		return []Msg{{Kind: MAppendResp, From: n.ID, To: m.From, Term: n.Term,
			Success: false, MatchIndex: n.lastLogIndex()}}
	}
	if m.Term > n.Term || n.Role != Follower {
		n.becomeFollower(m.Term)
	}
	n.LeaderID = m.From

	// Consistency check for the prefix preceding the new entries.
	if m.PrevLogIndex > n.lastLogIndex() ||
		n.termAt(m.PrevLogIndex) != m.PrevLogTerm {
		return []Msg{{Kind: MAppendResp, From: n.ID, To: m.From, Term: n.Term,
			Success: false, MatchIndex: n.lastLogIndex()}}
	}

	// Append entries, truncating any uncommitted conflicting suffix. A
	// conflict at or below CommitIdx is a safety violation and is reported
	// via the TruncatedCommitted flag on the node for the checker.
	for j, e := range m.Entries {
		idx := m.PrevLogIndex + 1 + j
		if idx <= len(n.Log) {
			if n.Log[idx-1].Term == e.Term {
				continue
			}
			if idx <= n.CommitIdx {
				n.TruncatedCommitted = true
			}
			n.Log = n.Log[:idx-1]
		}
		n.Log = append(n.Log, m.Entries[j:]...)
		break
	}

	if m.LeaderCommit > n.CommitIdx {
		if last := n.lastLogIndex(); m.LeaderCommit > last {
			n.CommitIdx = last
		} else {
			n.CommitIdx = m.LeaderCommit
		}
	}
	return []Msg{{Kind: MAppendResp, From: n.ID, To: m.From, Term: n.Term,
		Success: true, MatchIndex: m.PrevLogIndex + len(m.Entries)}}
}

func (n *Node) onAppendResp(m Msg, majority int) []Msg {
	if m.Term > n.Term {
		n.becomeFollower(m.Term)
		return nil
	}
	if n.Role != Leader || m.Term != n.Term {
		return nil
	}
	if !m.Success {
		if n.nextIndex[m.From] > 1 {
			n.nextIndex[m.From]--
		}
		return []Msg{n.appendFor(m.From)}
	}
	n.matchIndex[m.From] = m.MatchIndex
	if n.nextIndex[m.From] < m.MatchIndex+1 {
		n.nextIndex[m.From] = m.MatchIndex + 1
	}
	// Advance commit index: highest N such that a majority stores N and
	// log[N] is from the current term (Raft 5.4.2).
	for idx := n.lastLogIndex(); idx > n.CommitIdx; idx-- {
		if n.Log[idx-1].Term != n.Term {
			continue
		}
		count := 0
		for peer := range n.matchIndex {
			if n.matchIndex[peer] >= idx {
				count++
			}
		}
		if count >= majority {
			n.CommitIdx = idx
			n.PendingCommit = &CommitNotice{Index: idx, Term: n.Term}
			break
		}
	}
	return nil
}

// CommitNotice is set on a leader when it advances CommitIdx; the Simulator
// consumes it to record commit evidence.
type CommitNotice struct {
	Index int
	Term  int
}

func (n *Node) appendFor(peer int) Msg {
	prev := n.nextIndex[peer] - 1
	entries := make([]Entry, len(n.Log[prev:]))
	copy(entries, n.Log[prev:])
	return Msg{
		Kind: MAppend, From: n.ID, To: peer, Term: n.Term,
		PrevLogIndex: prev, PrevLogTerm: n.termAt(prev),
		Entries: entries, LeaderCommit: n.CommitIdx,
	}
}

func (n *Node) broadcastAppend() []Msg {
	out := make([]Msg, 0, len(n.nextIndex)-1)
	for peer := range n.nextIndex {
		if peer == n.ID {
			continue
		}
		out = append(out, n.appendFor(peer))
	}
	return out
}

// AppendClientCmd appends a client command to the leader's log and returns the
// replication messages to broadcast. Returns nil if not leader.
func (n *Node) AppendClientCmd(cmd string) []Msg {
	if n.Role != Leader {
		return nil
	}
	n.Log = append(n.Log, Entry{Term: n.Term, Cmd: cmd})
	n.matchIndex[n.ID] = n.lastLogIndex()
	return n.broadcastAppend()
}
