package formal

import (
	"errors"
	"fmt"
	"sort"
)

// Node is one vertex of the hierarchical quota tree. Leaves are the queues
// that jobs are submitted to; internal nodes aggregate guarantees so that
// idle capacity is borrowed within a subtree before crossing branches.
// A Node is immutable once built, so a Tree may be shared by concurrent
// planning calls.
type Node struct {
	Name      string
	Guarantee int64
	Children  []*Node
}

// IsLeaf reports whether n is a queue (jobs may only reference leaves).
func (n *Node) IsLeaf() bool { return len(n.Children) == 0 }

// Tree is a hierarchical quota tree. Build it from a root Node and call
// Validate before planning.
type Tree struct {
	Root *Node
}

// Job is a gang-schedulable unit of work: all Members must be placed
// atomically, each consuming UnitsPerMember cluster units.
type Job struct {
	ID             string
	Queue          string // leaf path in the quota tree
	Priority       int    // higher priority is scheduled first and may preempt lower
	Members        int32  // gang size, must be >= 1
	UnitsPerMember int64  // cluster units per gang member, must be >= 1
	Running        bool   // currently allocated in the cluster
	Preemptible    bool   // a running job with Preemptible=false is never preempted
	CompletedWork  int64  // work already done; lost if the job is preempted
	Seq            uint64 // arrival order; lower arrived earlier (stable fairness)
}

// Units returns the total cluster units the gang consumes atomically.
func (j Job) Units() int64 { return int64(j.Members) * j.UnitsPerMember }

// Input is one planning round for the scheduler.
type Input struct {
	Capacity int64 // total cluster units
	Tree     *Tree
	Jobs     []Job // running and pending jobs
}

// Result is the scheduler-visible result of one planning round.
type Result struct {
	Allocated []Job // target running set, in canonical fairness order
	Start     []Job // pending jobs to start
	Preempt   []Job // running jobs to preempt
	Score     Score // objective value of the target allocation
}

// Options tunes the planner. The zero value is valid.
type Options struct {
	// MaxExactCells bounds jobs*(capacity+1) for the exact dynamic program.
	// Larger instances fall back to a deterministic greedy pass that keeps
	// every guarantee invariant but may be suboptimal on packing.
	// Zero uses DefaultMaxExactCells.
	MaxExactCells int64
}

// DefaultMaxExactCells is the default exact-DP size budget (about 2M cells).
const DefaultMaxExactCells = 2 << 20

var (
	ErrNoTree       = errors.New("quota: nil tree or root")
	ErrOverCapacity = errors.New("quota: non-preemptible running jobs exceed capacity")
)

// Validate checks the tree invariants against the cluster capacity:
// unique sibling names, non-negative guarantees, every internal node's
// guarantee covers the sum of its children's guarantees, and the root
// guarantee does not exceed capacity.
func (t *Tree) Validate(capacity int64) error {
	if t == nil || t.Root == nil {
		return ErrNoTree
	}
	if capacity < 0 {
		return fmt.Errorf("quota: negative capacity %d", capacity)
	}
	if t.Root.Guarantee > capacity {
		return fmt.Errorf("quota: root guarantee %d exceeds capacity %d", t.Root.Guarantee, capacity)
	}
	var walk func(n *Node, path string) error
	walk = func(n *Node, path string) error {
		if n.Name == "" {
			return errors.New("quota: empty node name")
		}
		if n.Guarantee < 0 {
			return fmt.Errorf("quota: node %q has negative guarantee", path)
		}
		seen := make(map[string]bool, len(n.Children))
		var childSum int64
		for _, c := range n.Children {
			if seen[c.Name] {
				return fmt.Errorf("quota: duplicate child name %q under %q", c.Name, path)
			}
			seen[c.Name] = true
			childSum += c.Guarantee
		}
		if len(n.Children) > 0 && childSum > n.Guarantee {
			return fmt.Errorf("quota: node %q guarantee %d below children sum %d", path, n.Guarantee, childSum)
		}
		for _, c := range n.Children {
			if err := walk(c, path+"/"+c.Name); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(t.Root, t.Root.Name)
}

// leafInfo describes one queue: its node and its ancestor chain, leaf first
// and root last, with depth measured in edges below the root.
type leafInfo struct {
	node      *Node
	ancestors []*Node // leaf first, root last
	depth     int
}

// leaves returns the tree's queues keyed by slash-separated path below the
// root, e.g. "org/team". A leaf root is keyed by its own name.
func (t *Tree) leaves() map[string]leafInfo {
	out := map[string]leafInfo{}
	var walk func(n *Node, path string, chain []*Node)
	walk = func(n *Node, path string, chain []*Node) {
		chain = append(chain, n)
		if n.IsLeaf() {
			rev := make([]*Node, len(chain))
			for i, a := range chain {
				rev[len(chain)-1-i] = a
			}
			out[path] = leafInfo{node: n, ancestors: rev, depth: len(chain) - 1}
			return
		}
		for _, c := range n.Children {
			childPath := path + "/" + c.Name
			if path == "" {
				childPath = c.Name
			}
			walk(c, childPath, chain)
		}
	}
	name := t.Root.Name
	if len(t.Root.Children) > 0 {
		name = ""
	}
	walk(t.Root, name, nil)
	return out
}

// validateJobs checks job fields and queue references.
func validateJobs(jobs []Job, leaves map[string]leafInfo) error {
	seen := make(map[string]bool, len(jobs))
	for _, j := range jobs {
		if j.ID == "" {
			return errors.New("quota: job with empty ID")
		}
		if seen[j.ID] {
			return fmt.Errorf("quota: duplicate job ID %q", j.ID)
		}
		seen[j.ID] = true
		_, ok := leaves[j.Queue]
		if !ok {
			return fmt.Errorf("quota: job %q references unknown queue %q", j.ID, j.Queue)
		}
		if j.Members < 1 || j.UnitsPerMember < 1 {
			return fmt.Errorf("quota: job %q has non-positive gang shape", j.ID)
		}
		if j.CompletedWork < 0 {
			return fmt.Errorf("quota: job %q has negative completed work", j.ID)
		}
	}
	return nil
}

// canonicalLess orders jobs for stable fairness: priority descending, then
// arrival order, then ID. The planner and the exhaustive verifier share this
// total order, which makes the optimal allocation unique.
func canonicalLess(a, b Job) bool {
	if a.Priority != b.Priority {
		return a.Priority > b.Priority
	}
	if a.Seq != b.Seq {
		return a.Seq < b.Seq
	}
	return a.ID < b.ID
}

func sortCanonical(jobs []Job) {
	sort.SliceStable(jobs, func(i, k int) bool { return canonicalLess(jobs[i], jobs[k]) })
}
