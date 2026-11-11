package batchresp

import "sort"

// tarjanFrame is the per-node bookkeeping for an iterative Tarjan
// strongly-connected-components traversal.
type tarjanFrame struct {
	id      string
	next    int
	index   int
	lowLink int
	onStack bool
}

// detectCycles finds every dependency cycle using Tarjan's SCC
// algorithm. Iteration is sorted by Content-ID, so output is independent
// of segment arrival order.
func (g *Group) detectCycles() []Cycle {
	ids := make([]string, 0, len(g.segments))
	for id := range g.segments {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	frames := make(map[string]*tarjanFrame, len(ids))
	stack := make([]string, 0, len(ids))
	nextIndex := 0
	var cycles []Cycle

	neighbors := func(id string) []string {
		deps := make([]string, 0, len(g.segments[id].deps))
		for dep := range g.segments[id].deps {
			if _, ok := g.segments[dep]; ok {
				deps = append(deps, dep)
			}
		}
		sort.Strings(deps)
		return deps
	}

	for _, root := range ids {
		if _, seen := frames[root]; seen {
			continue
		}
		frames[root] = &tarjanFrame{id: root, index: nextIndex, lowLink: nextIndex, onStack: true}
		nextIndex++
		stack = append(stack, root)
		work := []*tarjanFrame{frames[root]}

		for len(work) > 0 {
			frame := work[len(work)-1]
			adj := neighbors(frame.id)
			if frame.next < len(adj) {
				dep := adj[frame.next]
				frame.next++
				other, seen := frames[dep]
				if !seen {
					other = &tarjanFrame{
						id:      dep,
						index:   nextIndex,
						lowLink: nextIndex,
						onStack: true,
					}
					frames[dep] = other
					nextIndex++
					stack = append(stack, dep)
					work = append(work, other)
					continue
				}
				if other.onStack && other.index < frame.lowLink {
					frame.lowLink = other.index
				}
				continue
			}

			if frame.lowLink == frame.index {
				members := []string{}
				for {
					top := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					frames[top].onStack = false
					members = append(members, top)
					if top == frame.id {
						break
					}
				}
				if cycle := g.normalizeCycle(members); cycle != nil {
					cycles = append(cycles, *cycle)
				}
			}

			work = work[:len(work)-1]
			if len(work) > 0 {
				parent := work[len(work)-1]
				if frame.lowLink < parent.lowLink {
					parent.lowLink = frame.lowLink
				}
			}
		}
	}

	sort.Slice(cycles, func(i, j int) bool {
		return cycles[i].Members[0] < cycles[j].Members[0]
	})
	return cycles
}

// normalizeCycle converts an SCC into a reported cycle. SCCs with more
// than one member are cycles; a singleton is only cyclic when it has a
// self edge. Members are reported in sorted order so the result does not
// depend on arrival order or SCC traversal order.
func (g *Group) normalizeCycle(members []string) *Cycle {
	sorted := append([]string(nil), members...)
	sort.Strings(sorted)
	if len(sorted) == 1 {
		if _, selfEdge := g.segments[sorted[0]].deps[sorted[0]]; !selfEdge {
			return nil
		}
		return &Cycle{Members: sorted}
	}
	return &Cycle{Members: sorted}
}
