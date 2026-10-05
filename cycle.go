package petri

import "fmt"

// CycleCertificate witnesses a fair infinite run: a prefix leading from
// the initial marking to the cycle entry, and a cycle (closed walk) that
// can be repeated forever. The cycle is weakly fair: every transition
// fireable at any state visited on the cycle is fired somewhere on the
// cycle, so no transition stays enabled forever without firing.
type CycleCertificate struct {
	Found  bool
	Prefix []int   // transition indices from initial to Entry
	Entry  Marking // first marking of the cycle
	Cycle  []int   // closed walk of transition indices, returns to Entry
}

// Verify replays the certificate and checks the fairness condition.
func (c *CycleCertificate) Verify(n *Net, initial Marking) error {
	if !c.Found {
		return fmt.Errorf("petri: certificate claims no fair cycle")
	}
	if len(c.Cycle) == 0 {
		return fmt.Errorf("petri: empty cycle")
	}
	m := initial
	for i, t := range c.Prefix {
		next, ok := n.Fire(m, t)
		if !ok {
			return fmt.Errorf("petri: prefix step %d not fireable", i)
		}
		m = next
	}
	if m != c.Entry {
		return fmt.Errorf("petri: prefix ends at %v, want entry %v", m, c.Entry)
	}
	visited := map[Marking]bool{m: true}
	fired := map[int]bool{}
	for i, t := range c.Cycle {
		next, ok := n.Fire(m, t)
		if !ok {
			return fmt.Errorf("petri: cycle step %d not fireable", i)
		}
		fired[t] = true
		m = next
		visited[m] = true
	}
	if m != c.Entry {
		return fmt.Errorf("petri: cycle ends at %v, want entry %v", m, c.Entry)
	}
	for s := range visited {
		for _, f := range n.Fireable(s) {
			if !fired[f.Transition] {
				return fmt.Errorf("petri: unfair: transition %q fireable on cycle but never fired",
					n.Transitions[f.Transition].Name)
			}
		}
	}
	return nil
}

// edge is one labelled transition between closure states.
type edge struct {
	from, to, trans int
}

// FairCycle searches for a fair infinite run reachable from initial. It
// returns the full reachable closure and, if one exists, a prefix+cycle
// certificate. A fair infinite run exists iff some reachable, strongly
// connected component contains an edge for every transition fireable at
// its states; the certificate materialises such a run as a closed walk.
func (n *Net) FairCycle(initial Marking) (*Closure, *CycleCertificate) {
	closure, _ := n.Reach(initial, nil)
	cert := &CycleCertificate{}

	// Build the explicit reachability graph over closure state indices.
	idx := make(map[Marking]int, len(closure.States))
	for i, m := range closure.States {
		idx[m] = i
	}
	var edges []edge
	adj := make([][]edge, len(closure.States))
	for i, m := range closure.States {
		for _, f := range n.Fireable(m) {
			e := edge{from: i, to: idx[f.Next], trans: f.Transition}
			edges = append(edges, e)
			adj[i] = append(adj[i], e)
		}
	}

	for _, comp := range tarjanSCC(adj) {
		if !nontrivial(comp, edges) {
			continue
		}
		inComp := make(map[int]bool, len(comp))
		for _, s := range comp {
			inComp[s] = true
		}
		// Collect transitions fireable inside the component; each must
		// have an edge staying inside the component.
		needed := map[int]bool{}
		have := map[int]bool{}
		for _, s := range comp {
			for _, f := range n.Fireable(closure.States[s]) {
				needed[f.Transition] = true
			}
		}
		for _, e := range edges {
			if inComp[e.from] && inComp[e.to] {
				have[e.trans] = true
			}
		}
		ok := true
		for t := range needed {
			if !have[t] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		cycle := buildClosedWalk(closure, adj, inComp, comp[0], needed)
		if cycle == nil {
			continue
		}
		prefix, _ := closure.Path(closure.States[comp[0]])
		cert.Found = true
		cert.Prefix = prefix
		cert.Entry = closure.States[comp[0]]
		cert.Cycle = cycle
		return closure, cert
	}
	return closure, cert
}

// nontrivial reports whether the component contains a cycle: more than
// one state, or a single state with a self-loop.
func nontrivial(comp []int, edges []edge) bool {
	if len(comp) > 1 {
		return true
	}
	for _, e := range edges {
		if e.from == comp[0] && e.to == comp[0] {
			return true
		}
	}
	return false
}

// buildClosedWalk constructs a closed walk from start back to start,
// staying inside the component and firing every transition in needed.
func buildClosedWalk(closure *Closure, adj [][]edge, inComp map[int]bool, start int, needed map[int]bool) []int {
	pathWithin := func(from, to int) []int {
		// BFS restricted to the component; strong connectivity
		// guarantees success.
		if from == to {
			return []int{}
		}
		prev := map[int]edge{from: {from: -1, to: from, trans: -1}}
		queue := []int{from}
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			if u == to {
				var rev []int
				for cur := to; prev[cur].from >= 0; cur = prev[cur].from {
					rev = append(rev, prev[cur].trans)
				}
				for l, r := 0, len(rev)-1; l < r; l, r = l+1, r-1 {
					rev[l], rev[r] = rev[r], rev[l]
				}
				return rev
			}
			for _, e := range adj[u] {
				if !inComp[e.to] {
					continue
				}
				if _, seen := prev[e.to]; !seen {
					prev[e.to] = e
					queue = append(queue, e.to)
				}
			}
		}
		return nil
	}

	var walk []int
	cur := start
	pending := map[int]bool{}
	for t := range needed {
		pending[t] = true
	}
	for len(pending) > 0 {
		progress := false
		for t := range pending {
			// Find an in-component edge labelled t.
			found := false
			for _, e := range adj[cur] {
				if e.trans == t && inComp[e.to] {
					found = true
					walk = append(walk, t)
					cur = e.to
					break
				}
			}
			if !found {
				// Route to some state that has an outgoing t-edge.
				target := -1
				for s := range inComp {
					for _, e := range adj[s] {
						if e.trans == t && inComp[e.to] {
							target = s
							break
						}
					}
					if target >= 0 {
						break
					}
				}
				if target < 0 {
					return nil
				}
				seg := pathWithin(cur, target)
				if seg == nil {
					return nil
				}
				walk = append(walk, seg...)
				cur = target
				for _, e := range adj[cur] {
					if e.trans == t && inComp[e.to] {
						walk = append(walk, t)
						cur = e.to
						break
					}
				}
			}
			delete(pending, t)
			progress = true
		}
		if !progress {
			return nil
		}
	}
	// Close the walk back to the start state.
	seg := pathWithin(cur, start)
	if seg == nil {
		return nil
	}
	walk = append(walk, seg...)
	return walk
}

// tarjanSCC returns the strongly connected components of the graph.
func tarjanSCC(adj [][]edge) [][]int {
	n := len(adj)
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	for i := range index {
		index[i] = -1
	}
	var stack []int
	var comps [][]int
	counter := 0

	var strongconnect func(v int)
	strongconnect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for _, e := range adj[v] {
			w := e.to
			if index[w] == -1 {
				strongconnect(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] && index[w] < low[v] {
				low[v] = index[w]
			}
		}
		if low[v] == index[v] {
			var comp []int
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				comp = append(comp, w)
				if w == v {
					break
				}
			}
			comps = append(comps, comp)
		}
	}
	for v := 0; v < n; v++ {
		if index[v] == -1 {
			strongconnect(v)
		}
	}
	return comps
}
