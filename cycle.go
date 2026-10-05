package petri

// LassoCertificate witnesses a fair infinite run: firing Prefix from the
// initial marking reaches a state on Cycle, and repeating Cycle forever is a
// fair run — every transition either fires in the cycle or is not fireable at
// some state of the cycle (so it is not perpetually neglected).
type LassoCertificate struct {
	Found  bool
	Prefix []int
	Cycle  []int
	// PrefixStates and CycleStates are the visited markings for replay
	// verification; CycleStates[0] == CycleStates[last].
	PrefixStates []Marking
	CycleStates  []Marking
}

// graph holds an enumerated reachable graph.
type graph struct {
	states []Marking
	adj    [][]Step
	index  map[Marking]int
}

func (n *Net) buildGraph(initial Marking) *graph {
	g := &graph{index: map[Marking]int{}}
	add := func(m Marking) int {
		if i, ok := g.index[m]; ok {
			return i
		}
		i := len(g.states)
		g.states = append(g.states, m)
		g.adj = append(g.adj, nil)
		g.index[m] = i
		return i
	}
	add(initial)
	queue := []Marking{initial}
	expanded := map[Marking]bool{}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if expanded[cur] {
			continue
		}
		expanded[cur] = true
		ci := g.index[cur]
		for _, s := range n.Successors(cur) {
			add(s.Next)
			g.adj[ci] = append(g.adj[ci], s)
			if !expanded[s.Next] {
				queue = append(queue, s.Next)
			}
		}
	}
	return g
}

// sccs computes strongly connected components via Tarjan's algorithm.
func (g *graph) sccs() [][]int {
	const unvisited = -1
	index := make([]int, len(g.states))
	low := make([]int, len(g.states))
	onStack := make([]bool, len(g.states))
	for i := range index {
		index[i] = unvisited
	}
	var stack []int
	counter := 0
	var out [][]int
	var strongconnect func(v int)
	strongconnect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for _, s := range g.adj[v] {
			w := g.index[s.Next]
			if index[w] == unvisited {
				strongconnect(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] {
				if index[w] < low[v] {
					low[v] = index[w]
				}
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
			out = append(out, comp)
		}
	}
	for v := range g.states {
		if index[v] == unvisited {
			strongconnect(v)
		}
	}
	return out
}

// pathWithin BFS-routes from state a to state b using only edges whose
// endpoints both lie in allowed; returns the transition sequence.
func (g *graph) pathWithin(a, b int, allowed []bool) ([]int, bool) {
	if a == b {
		return nil, true
	}
	prev := make([]int, len(g.states))
	via := make([]int, len(g.states))
	seen := make([]bool, len(g.states))
	seen[a] = true
	queue := []int{a}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, s := range g.adj[cur] {
			nx := g.index[s.Next]
			if !allowed[nx] || seen[nx] {
				continue
			}
			seen[nx] = true
			prev[nx] = cur
			via[nx] = s.Trans
			if nx == b {
				var path []int
				for x := b; x != a; x = prev[x] {
					path = append(path, via[x])
				}
				for l, r := 0, len(path)-1; l < r; l, r = l+1, r-1 {
					path[l], path[r] = path[r], path[l]
				}
				return path, true
			}
			queue = append(queue, nx)
		}
	}
	return nil, false
}

// FairCycle searches for a fair infinite run reachable from initial and
// returns it as a lasso (prefix + cycle) certificate.
func (n *Net) FairCycle(initial Marking) LassoCertificate {
	g := n.buildGraph(initial)
	// BFS distances from initial, to anchor cycles near the initial state.
	dist := make([]int, len(g.states))
	for i := range dist {
		dist[i] = -1
	}
	dist[g.index[initial]] = 0
	queue := []int{g.index[initial]}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, s := range g.adj[cur] {
			nx := g.index[s.Next]
			if dist[nx] < 0 {
				dist[nx] = dist[cur] + 1
				queue = append(queue, nx)
			}
		}
	}
	for _, comp := range g.sccs() {
		inComp := make([]bool, len(g.states))
		selfLoop := false
		for _, v := range comp {
			inComp[v] = true
		}
		for _, v := range comp {
			for _, s := range g.adj[v] {
				if g.index[s.Next] == v {
					selfLoop = true
				}
			}
		}
		if len(comp) < 2 && !selfLoop {
			continue
		}
		// Anchor the cycle at the component state closest to initial.
		start := comp[0]
		for _, v := range comp[1:] {
			if dist[v] >= 0 && (dist[start] < 0 || dist[v] < dist[start]) {
				start = v
			}
		}
		// Build a cycle through start that fires every transition fireable
		// anywhere in the component. Transitions never fireable in the
		// component are disabled at every cycle state, so the run is fair.
		cur := start
		var cycle []int
		for ti := range n.Transitions {
			target := -1
			for _, v := range comp {
				for _, s := range g.adj[v] {
					if s.Trans == ti {
						target = v
						break
					}
				}
				if target >= 0 {
					break
				}
			}
			if target < 0 {
				continue
			}
			seg, ok := g.pathWithin(cur, target, inComp)
			if !ok {
				continue
			}
			cycle = append(cycle, seg...)
			cycle = append(cycle, ti)
			next, _ := n.Transitions[ti].Fire(g.states[target])
			cur = g.index[next]
		}
		seg, ok := g.pathWithin(cur, start, inComp)
		if !ok || (len(cycle) == 0 && len(seg) == 0) {
			continue
		}
		cycle = append(cycle, seg...)
		prefix, _ := g.pathWithin(g.index[initial], start, allAllowed(len(g.states)))
		cert := LassoCertificate{Found: true, Prefix: prefix, Cycle: cycle}
		cert.PrefixStates, cert.CycleStates = n.replay(initial, prefix, cycle)
		return cert
	}
	return LassoCertificate{}
}

func allAllowed(k int) []bool {
	out := make([]bool, k)
	for i := range out {
		out[i] = true
	}
	return out
}

// replay applies prefix then cycle from initial, returning visited states.
func (n *Net) replay(initial Marking, prefix, cycle []int) ([]Marking, []Marking) {
	m := initial
	pre := []Marking{m}
	for _, ti := range prefix {
		m, _ = n.Transitions[ti].Fire(m)
		pre = append(pre, m)
	}
	cyc := []Marking{m}
	for _, ti := range cycle {
		m, _ = n.Transitions[ti].Fire(m)
		cyc = append(cyc, m)
	}
	return pre, cyc
}

// IsFairCycle checks the fairness condition of a cycle: every transition
// either fires in the cycle or is not fireable at at least one cycle state.
func (n *Net) IsFairCycle(cycleStates []Marking, cycle []int) bool {
	fired := make([]bool, len(n.Transitions))
	for _, ti := range cycle {
		fired[ti] = true
	}
	for ti := range n.Transitions {
		if fired[ti] {
			continue
		}
		disabledSomewhere := false
		for _, m := range cycleStates {
			fireable := false
			for _, f := range n.Fireable(m) {
				if f == ti {
					fireable = true
					break
				}
			}
			if !fireable {
				disabledSomewhere = true
				break
			}
		}
		if !disabledSomewhere {
			return false
		}
	}
	return true
}
