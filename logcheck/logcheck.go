// Package logcheck checks prefix consistency of delivery logs replicated
// across nodes. It provides a full all-pairs comparison model and an
// incremental checker that supports appending entries without rescanning
// the whole history; both are meant to be cross-checked against each other.
package logcheck

import (
	"errors"
	"fmt"
	"sort"
)

// Status describes the liveness of a node.
type Status string

const (
	StatusAlive   Status = "alive"
	StatusCrashed Status = "crashed"
	StatusUnknown Status = "unknown"
)

// ParseStatus parses a status string. An unrecognized value is an error;
// it is never silently mapped to a fault.
func ParseStatus(s string) (Status, error) {
	switch Status(s) {
	case StatusAlive, StatusCrashed, StatusUnknown:
		return Status(s), nil
	default:
		return "", fmt.Errorf("invalid node status %q (want alive|crashed|unknown)", s)
	}
}

// Entry is one delivered record in a node's history log.
type Entry struct {
	Seq   int64  `json:"seq"`
	Value string `json:"value"`
}

// Node is one replica: its identity, liveness status and delivery log.
type Node struct {
	ID     string  `json:"id"`
	Status Status  `json:"status"`
	Log    []Entry `json:"log"`
}

// Verdict is the outcome of a consistency check.
type Verdict string

const (
	// VerdictOK means all logs are prefix-consistent and every short
	// prefix is explained (crashed node) or explicitly not a fault
	// (unknown-status node).
	VerdictOK Verdict = "OK"
	// VerdictConflict means two logs diverge: neither is a prefix of the
	// other. A crashed node is allowed a short prefix, never a
	// diverging entry.
	VerdictConflict Verdict = "CONFLICT"
	// VerdictShortPrefix means logs are prefix-consistent but an alive
	// node trails the longest log: it should have delivered more.
	VerdictShortPrefix Verdict = "SHORT_PREFIX"
)

// Conflict pinpoints the earliest divergence between two logs.
type Conflict struct {
	Index   int    // zero-based position of the earliest diverging entry
	SourceA string // lexicographically smaller node ID of the pair
	SourceB string
	EntryA  Entry
	EntryB  Entry
}

// ShortNote records a node whose log is a strict prefix of the longest
// log, and whether that is acceptable.
type ShortNote struct {
	NodeID  string
	Len     int
	MaxLen  int
	Status  Status
	Allowed bool // crashed: allowed; unknown: not counted as a fault
}

// Report is the result of a consistency check.
type Report struct {
	Verdict  Verdict
	Conflict *Conflict // set iff Verdict == VerdictConflict
	Short    []ShortNote
}

// FullReport runs the all-pairs comparison model over nodes and returns
// the consistency report. Node order in the input does not matter; node
// IDs must be unique.
func FullReport(nodes []*Node) (Report, error) {
	if err := validateNodes(nodes); err != nil {
		return Report{}, err
	}
	sorted := sortedNodes(nodes)

	// All-pairs: find the earliest divergence and, among pairs diverging
	// there, the lexicographically smallest pair of sources.
	best := -1
	var conflict *Conflict
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			a, b := sorted[i], sorted[j]
			d := divergence(a.Log, b.Log)
			if d < 0 {
				continue
			}
			if best == -1 || d < best {
				best = d
				conflict = &Conflict{
					Index:   d,
					SourceA: a.ID,
					SourceB: b.ID,
					EntryA:  a.Log[d],
					EntryB:  b.Log[d],
				}
			}
		}
	}

	rep := Report{}
	if conflict != nil {
		rep.Verdict = VerdictConflict
		rep.Conflict = conflict
		return rep, nil
	}

	rep.Verdict = VerdictOK
	rep.Short = shortNotes(sorted)
	for _, n := range rep.Short {
		if n.Status == StatusAlive {
			rep.Verdict = VerdictShortPrefix
			break
		}
	}
	return rep, nil
}

// divergence returns the first index at which a and b hold different
// entries, or -1 if one log is a prefix of the other.
func divergence(a, b []Entry) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return -1
}

// shortNotes classifies nodes whose log is shorter than the longest log.
// A crashed node's short prefix is allowed; an unknown-status node's short
// prefix is explicitly not counted as a fault; an alive node's short
// prefix is a fault.
func shortNotes(sorted []*Node) []ShortNote {
	maxLen := 0
	for _, n := range sorted {
		if len(n.Log) > maxLen {
			maxLen = len(n.Log)
		}
	}
	var notes []ShortNote
	for _, n := range sorted {
		if len(n.Log) == maxLen {
			continue
		}
		notes = append(notes, ShortNote{
			NodeID:  n.ID,
			Len:     len(n.Log),
			MaxLen:  maxLen,
			Status:  n.Status,
			Allowed: n.Status != StatusAlive,
		})
	}
	return notes
}

func validateNodes(nodes []*Node) error {
	if len(nodes) == 0 {
		return errors.New("no nodes")
	}
	seen := map[string]bool{}
	for _, n := range nodes {
		if n == nil {
			return errors.New("nil node")
		}
		if n.ID == "" {
			return errors.New("empty node ID")
		}
		if seen[n.ID] {
			return fmt.Errorf("duplicate node ID %q", n.ID)
		}
		seen[n.ID] = true
		switch n.Status {
		case StatusAlive, StatusCrashed, StatusUnknown:
		default:
			return fmt.Errorf("node %q: invalid status %q", n.ID, n.Status)
		}
		for i := 1; i < len(n.Log); i++ {
			if n.Log[i].Seq <= n.Log[i-1].Seq {
				return fmt.Errorf("node %q: log not strictly increasing at index %d", n.ID, i)
			}
		}
	}
	return nil
}

func sortedNodes(nodes []*Node) []*Node {
	out := make([]*Node, len(nodes))
	copy(out, nodes)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Checker maintains prefix-consistency state incrementally: appending
// entries to a node updates the verdict without rescanning unrelated
// logs. Report must agree with FullReport on the same data; the CLI and
// the tests cross-check the two models.
type Checker struct {
	nodes  map[string]*Node
	ids    []string       // sorted node IDs
	ref    string         // reference node: longest log, ties broken by smallest ID
	div    map[string]int // divergence index of each non-reference node vs ref, -1 if prefix-consistent
	maxLen int
}

// NewChecker builds an incremental checker from the current logs.
func NewChecker(nodes []*Node) (*Checker, error) {
	if err := validateNodes(nodes); err != nil {
		return nil, err
	}
	c := &Checker{
		nodes: map[string]*Node{},
		div:   map[string]int{},
	}
	for _, n := range nodes {
		c.nodes[n.ID] = n
		c.ids = append(c.ids, n.ID)
	}
	sort.Strings(c.ids)
	c.ref = c.pickReference()
	c.recomputeDivergences()
	c.maxLen = len(c.nodes[c.ref].Log)
	return c, nil
}

// Nodes returns the nodes in sorted-ID order.
func (c *Checker) Nodes() []*Node {
	out := make([]*Node, 0, len(c.ids))
	for _, id := range c.ids {
		out = append(out, c.nodes[id])
	}
	return out
}

// pickReference returns the ID of the longest log; ties go to the
// smallest ID.
func (c *Checker) pickReference() string {
	best := c.ids[0]
	for _, id := range c.ids[1:] {
		if len(c.nodes[id].Log) > len(c.nodes[best].Log) {
			best = id
		}
	}
	return best
}

func (c *Checker) recomputeDivergences() {
	ref := c.nodes[c.ref]
	for _, id := range c.ids {
		if id == c.ref {
			continue
		}
		c.div[id] = divergence(c.nodes[id].Log, ref.Log)
	}
}

// Append adds entries to a node's log and updates the consistency state
// incrementally. Entry sequences must strictly increase.
func (c *Checker) Append(nodeID string, entries ...Entry) error {
	n, ok := c.nodes[nodeID]
	if !ok {
		return fmt.Errorf("unknown node %q", nodeID)
	}
	if len(entries) == 0 {
		return nil
	}
	var last int64
	if len(n.Log) > 0 {
		last = n.Log[len(n.Log)-1].Seq
	} else {
		last = entries[0].Seq - 1
	}
	for _, e := range entries {
		if e.Seq <= last {
			return fmt.Errorf("node %q: entry seq %d not strictly increasing", nodeID, e.Seq)
		}
		last = e.Seq
	}

	oldLen := len(n.Log)
	n.Log = append(n.Log, entries...)

	if nodeID == c.ref {
		// The reference only grew; every other node's relation to it is
		// unchanged (prefixes stay prefixes, divergences stay put).
		c.maxLen = len(n.Log)
		return nil
	}

	if c.div[nodeID] >= 0 {
		// Already diverging from the reference before the append; the
		// earliest divergence index does not move.
	} else {
		// Compare the newly appended region against the reference.
		ref := c.nodes[c.ref]
		limit := len(n.Log)
		if len(ref.Log) < limit {
			limit = len(ref.Log)
		}
		for i := oldLen; i < limit; i++ {
			if n.Log[i] != ref.Log[i] {
				c.div[nodeID] = i
				break
			}
		}
	}

	// Reference handover: this node may now be the longest log.
	if len(n.Log) > c.maxLen || (len(n.Log) == c.maxLen && nodeID < c.ref) {
		oldRef := c.ref
		clean := c.div[nodeID] < 0 && len(n.Log) >= len(c.nodes[c.ref].Log)
		c.ref = nodeID
		c.maxLen = len(n.Log)
		delete(c.div, nodeID)
		if !clean {
			// The new reference is not a clean extension of the old one;
			// divergence indices against it must be rebuilt.
			c.recomputeDivergences()
		} else {
			// The new reference extends the old one, so every recorded
			// divergence index carries over; the old reference is now a
			// prefix of the new one.
			c.div[oldRef] = -1
		}
	}
	return nil
}

// Report derives the consistency report from the incremental state.
func (c *Checker) Report() Report {
	best := -1
	for _, d := range c.div {
		if d >= 0 && (best == -1 || d < best) {
			best = d
		}
	}
	rep := Report{}
	if best >= 0 {
		rep.Verdict = VerdictConflict
		rep.Conflict = c.conflictAt(best)
		return rep
	}
	rep.Verdict = VerdictOK
	rep.Short = shortNotes(c.Nodes())
	for _, n := range rep.Short {
		if n.Status == StatusAlive {
			rep.Verdict = VerdictShortPrefix
			break
		}
	}
	return rep
}

// conflictAt finds the lexicographically smallest pair of nodes whose
// logs first diverge at index idx. Both members of such a pair hold an
// entry at idx and the entries differ.
func (c *Checker) conflictAt(idx int) *Conflict {
	var prevID string
	var prevEntry Entry
	havePrev := false
	for _, id := range c.ids {
		log := c.nodes[id].Log
		if len(log) <= idx {
			continue
		}
		if havePrev && prevEntry != log[idx] {
			return &Conflict{
				Index:   idx,
				SourceA: prevID,
				SourceB: id,
				EntryA:  prevEntry,
				EntryB:  log[idx],
			}
		}
		if !havePrev {
			prevID, prevEntry, havePrev = id, log[idx], true
		}
	}
	return nil // unreachable when idx came from a recorded divergence
}
