package formal

import (
	"container/heap"
	"errors"
	"fmt"
	"sort"
)

// Action is the kind of change a node performs.
type Action string

const (
	ActionCreate Action = "create"
	ActionUpdate Action = "update"
	ActionDelete Action = "delete"
)

// Node is one resource operation in a Plan. Deps lists the IDs of nodes that
// must be applied successfully before this node may start.
type Node struct {
	ID         string
	Action     Action
	Deps       []string
	Reversible bool
}

// Plan is one attempt at a logical operation. ID identifies the logical
// operation and is stable across retries; Generation increases on every retry.
type Plan struct {
	ID         string
	Generation uint64
	Nodes      []Node
}

var (
	// ErrInvalidPlan reports malformed plan input.
	ErrInvalidPlan = errors.New("invalid plan")
	// ErrStaleGeneration reports a plan whose generation is not newer than the
	// latest generation started for the same operation ID.
	ErrStaleGeneration = errors.New("stale operation generation")
)

type compiledNode struct {
	id         string
	action     Action
	reversible bool
	deps       []*compiledNode
	dependents []*compiledNode
	depIDs     []string
	rank       int
}

type compiledPlan struct {
	id         string
	generation uint64
	nodes      []*compiledNode
	order      []*compiledNode
}

func compilePlan(p Plan) (*compiledPlan, error) {
	if p.ID == "" {
		return nil, fmt.Errorf("%w: empty plan ID", ErrInvalidPlan)
	}
	if p.Generation == 0 {
		return nil, fmt.Errorf("%w: generation must be positive", ErrInvalidPlan)
	}
	if len(p.Nodes) == 0 {
		return nil, fmt.Errorf("%w: no nodes", ErrInvalidPlan)
	}

	cp := &compiledPlan{id: p.ID, generation: p.Generation}
	byID := make(map[string]*compiledNode, len(p.Nodes))
	for _, n := range p.Nodes {
		if n.ID == "" {
			return nil, fmt.Errorf("%w: empty node ID", ErrInvalidPlan)
		}
		if _, exists := byID[n.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate node %q", ErrInvalidPlan, n.ID)
		}
		switch n.Action {
		case ActionCreate, ActionUpdate, ActionDelete:
		default:
			return nil, fmt.Errorf("%w: node %q has unknown action %q", ErrInvalidPlan, n.ID, n.Action)
		}
		cn := &compiledNode{
			id:         n.ID,
			action:     n.Action,
			reversible: n.Reversible,
			depIDs:     append([]string(nil), n.Deps...),
		}
		byID[n.ID] = cn
		cp.nodes = append(cp.nodes, cn)
	}

	for _, cn := range cp.nodes {
		seen := make(map[string]struct{}, len(cn.depIDs))
		for _, depID := range cn.depIDs {
			if depID == cn.id {
				return nil, fmt.Errorf("%w: node %q depends on itself", ErrInvalidPlan, cn.id)
			}
			if _, dup := seen[depID]; dup {
				return nil, fmt.Errorf("%w: node %q lists dependency %q twice", ErrInvalidPlan, cn.id, depID)
			}
			seen[depID] = struct{}{}
			dep, ok := byID[depID]
			if !ok {
				return nil, fmt.Errorf("%w: node %q depends on unknown node %q", ErrInvalidPlan, cn.id, depID)
			}
			cn.deps = append(cn.deps, dep)
			dep.dependents = append(dep.dependents, cn)
		}
	}

	remaining := make(map[*compiledNode]int, len(cp.nodes))
	ready := &idHeap{}
	heap.Init(ready)
	for _, cn := range cp.nodes {
		remaining[cn] = len(cn.deps)
		if len(cn.deps) == 0 {
			heap.Push(ready, cn)
		}
	}

	for ready.Len() > 0 {
		cn := heap.Pop(ready).(*compiledNode)
		rank := 0
		for _, dep := range cn.deps {
			if dep.rank+1 > rank {
				rank = dep.rank + 1
			}
		}
		cn.rank = rank
		cp.order = append(cp.order, cn)
		for _, dep := range cn.dependents {
			remaining[dep]--
			if remaining[dep] == 0 {
				heap.Push(ready, dep)
			}
		}
	}

	if len(cp.order) != len(cp.nodes) {
		var cyclic []string
		for _, cn := range cp.nodes {
			if remaining[cn] > 0 {
				cyclic = append(cyclic, cn.id)
			}
		}
		sort.Strings(cyclic)
		return nil, fmt.Errorf("%w: dependency cycle involving %v", ErrInvalidPlan, cyclic)
	}

	return cp, nil
}

type idHeap []*compiledNode

func (h idHeap) Len() int           { return len(h) }
func (h idHeap) Less(i, j int) bool { return h[i].id < h[j].id }
func (h idHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *idHeap) Push(x any)        { *h = append(*h, x.(*compiledNode)) }
func (h *idHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}
