package main

import (
	"bufio"
	"fmt"
	"io"
	"sort"
	"strings"
)

// Node statuses. A crashed node is allowed to hold a shorter prefix of the
// common log. An unknown status is informational only: it must never be
// treated as a fault, nor does it excuse a divergence.
const (
	StatusOK      = "ok"
	StatusCrashed = "crashed"
	StatusUnknown = "unknown"
)

// Node is one replica's delivery log plus its reported status.
type Node struct {
	Name    string
	Status  string
	Entries []string
}

// LogSet holds every node's log. Order keeps node names sorted so all
// results are deterministic.
type LogSet struct {
	Nodes map[string]*Node
	Order []string
}

func NewLogSet() *LogSet {
	return &LogSet{Nodes: make(map[string]*Node)}
}

func (s *LogSet) node(name string) *Node {
	if n, ok := s.Nodes[name]; ok {
		return n
	}
	n := &Node{Name: name, Status: StatusUnknown}
	s.Nodes[name] = n
	i := sort.SearchStrings(s.Order, name)
	s.Order = append(s.Order, "")
	copy(s.Order[i+1:], s.Order[i:])
	s.Order[i] = name
	return n
}

// SetStatus records a node's status. Unknown statuses are rejected so a
// typo can never silently downgrade a node to "unknown".
func (s *LogSet) SetStatus(name, status string) error {
	switch status {
	case StatusOK, StatusCrashed, StatusUnknown:
		s.node(name).Status = status
		return nil
	default:
		return fmt.Errorf("invalid status %q (want ok|crashed|unknown)", status)
	}
}

// Append adds one delivered entry to a node's log.
func (s *LogSet) Append(name, value string) {
	n := s.node(name)
	n.Entries = append(n.Entries, value)
}

// Conflict reports the earliest index at which two nodes disagree, together
// with the two sources (nodes) and their conflicting values.
type Conflict struct {
	Index         int
	NodeA, NodeB  string
	ValueA, ValueB string
}

func (c Conflict) String() string {
	return fmt.Sprintf("index %d: %s=%q vs %s=%q", c.Index, c.NodeA, c.ValueA, c.NodeB, c.ValueB)
}

// better reports whether a should replace b as the reported conflict:
// earliest index wins, ties break by the lexicographically smaller pair.
func better(a, b Conflict) bool {
	if a.Index != b.Index {
		return a.Index < b.Index
	}
	if a.NodeA != b.NodeA {
		return a.NodeA < b.NodeA
	}
	return a.NodeB < b.NodeB
}

func makeConflict(idx int, x, y *Node) Conflict {
	a, b := x, y
	if b.Name < a.Name {
		a, b = b, a
	}
	return Conflict{
		Index:  idx,
		NodeA:  a.Name, NodeB: b.Name,
		ValueA: a.Entries[idx], ValueB: b.Entries[idx],
	}
}

// FullCheck is the reference model: it compares every pair of nodes over
// their overlapping prefix and returns the earliest conflict. A shorter log
// is never itself a conflict (that is what permits crashed nodes to trail).
func FullCheck(s *LogSet) (Conflict, bool) {
	var best Conflict
	found := false
	for i := 0; i < len(s.Order); i++ {
		for j := i + 1; j < len(s.Order); j++ {
			x, y := s.Nodes[s.Order[i]], s.Nodes[s.Order[j]]
			n := len(x.Entries)
			if len(y.Entries) < n {
				n = len(y.Entries)
			}
			for k := 0; k < n; k++ {
				if x.Entries[k] != y.Entries[k] {
					c := makeConflict(k, x, y)
					if !found || better(c, best) {
						best, found = c, true
					}
				}
			}
		}
	}
	return best, found
}

// IncrChecker evaluates the same property incrementally: entries are fed in
// as they are appended, and only the newly appended index is compared
// against the other nodes. Its result must always match FullCheck.
type IncrChecker struct {
	set   *LogSet
	best  Conflict
	found bool
}

func NewIncrChecker() *IncrChecker {
	return &IncrChecker{set: NewLogSet()}
}

func (c *IncrChecker) SetStatus(name, status string) error {
	return c.set.SetStatus(name, status)
}

// Append records one new entry and checks only its index against every
// other node that already has an entry there. Every pair's index-k
// comparison happens exactly once, when the later of the two appends at
// index k arrives, so no pair is ever missed.
func (c *IncrChecker) Append(name, value string) {
	n := c.set.node(name)
	idx := len(n.Entries)
	n.Entries = append(n.Entries, value)
	for _, otherName := range c.set.Order {
		if otherName == name {
			continue
		}
		o := c.set.Nodes[otherName]
		if idx < len(o.Entries) && o.Entries[idx] != value {
			cand := makeConflict(idx, n, o)
			if !c.found || better(cand, c.best) {
				c.best, c.found = cand, true
			}
		}
	}
}

func (c *IncrChecker) Result() (Conflict, bool) { return c.best, c.found }

// LogSet exposes the accumulated logs (used by reports).
func (c *IncrChecker) LogSet() *LogSet { return c.set }

// ParseLog reads directives line by line. Format:
//
//	status <node> <ok|crashed|unknown>
//	entry  <node> <value>
//
// Blank lines and #-comments are ignored. Entries for a node appear in
// delivery order.
func ParseLog(r io.Reader, apply interface {
	SetStatus(name, status string) error
	Append(name, value string)
}) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		switch fields[0] {
		case "status":
			if len(fields) != 3 {
				return fmt.Errorf("line %d: status wants 2 arguments", lineNo)
			}
			if err := apply.SetStatus(fields[1], fields[2]); err != nil {
				return fmt.Errorf("line %d: %w", lineNo, err)
			}
		case "entry":
			if len(fields) != 3 {
				return fmt.Errorf("line %d: entry wants 2 arguments", lineNo)
			}
			apply.Append(fields[1], fields[2])
		default:
			return fmt.Errorf("line %d: unknown directive %q", lineNo, fields[0])
		}
	}
	return sc.Err()
}

// Report renders the check outcome. Status is reported for context only:
// "unknown" is never labelled as a fault, and a crashed node's short prefix
// is expected, not an error.
func Report(s *LogSet, c Conflict, found bool) string {
	var b strings.Builder
	if found {
		fmt.Fprintf(&b, "CONFLICT at %s (sources: %s, %s)\n", c, c.NodeA, c.NodeB)
	} else {
		fmt.Fprintf(&b, "OK: %d node(s) prefix-consistent\n", len(s.Order))
	}
	for _, name := range s.Order {
		n := s.Nodes[name]
		fmt.Fprintf(&b, "  node %s: status=%s entries=%d\n", n.Name, n.Status, len(n.Entries))
	}
	return b.String()
}
