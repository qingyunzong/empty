package statever

import "sort"

// Lasso represents an infinite counterexample as a reachable finite prefix
// plus a cycle repeated forever.
type Lasso struct {
	Prefix []Step // trace from the initial state to the cycle entry
	Cycle  []Step // non-empty closed walk; last To == first From
}

// Events returns the event-ID sequence of the full trace (prefix then cycle).
func (l *Lasso) Events() []int {
	out := make([]int, 0, len(l.Prefix)+len(l.Cycle))
	for _, s := range l.Prefix {
		out = append(out, s.Event)
	}
	for _, s := range l.Cycle {
		out = append(out, s.Event)
	}
	return out
}

// SCCEvidence describes one strongly connected component for the global
// (unbounded) fairness analysis.
type SCCEvidence struct {
	ID                   int
	States               []string
	ContainsBad          bool
	HasFairCycle         bool
	ReachableFromInitial bool
	ReachableFromBad     bool // reachable from some bad state reachable from initial
}

// FairResult is the outcome of the fairness analysis.
type FairResult struct {
	// Violation is the shortest fair infinite violation (prefix + cycle),
	// or nil if none exists.
	Violation *Lasso
	// Evidence is the complete SCC decomposition. When Violation is nil it
	// proves globally that no fair infinite violation exists — unlike the
	// bounded check, this is not limited to any step budget.
	Evidence []SCCEvidence
	// BadReachable reports whether any bad state is reachable at all.
	BadReachable bool
}

// scc computes strongly connected components via Tarjan's algorithm.
// Returns components (each a list of state indices) and the component id
// per state.
func scc(m *Model) (comps [][]int, compOf []int) {
	n := m.NumStates()
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	compOf = make([]int, n)
	for i := range compOf {
		index[i] = -1
		compOf[i] = -1
	}
	var stack []int
	counter := 0
	var strongconnect func(v int)
	strongconnect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for ev := 0; ev < m.NumEvents(); ev++ {
			for _, w := range m.Next(v, ev) {
				if index[w] == -1 {
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
		}
		if low[v] == index[v] {
			var comp []int
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				compOf[w] = len(comps)
				comp = append(comp, w)
				if w == v {
					break
				}
			}
			sort.Ints(comp)
			comps = append(comps, comp)
		}
	}
	for v := 0; v < n; v++ {
		if index[v] == -1 {
			strongconnect(v)
		}
	}
	return comps, compOf
}

// fairWalk reports whether a closed walk is fair: every event that is
// enabled at every state of the walk (continuously ready) must occur in it.
func fairWalk(m *Model, statesMask, eventsMask int) bool {
	for ev := 0; ev < m.NumEvents(); ev++ {
		continuous := true
		for s := 0; s < m.NumStates(); s++ {
			if statesMask&(1<<s) != 0 && !m.Enabled(s, ev) {
				continuous = false
				break
			}
		}
		if continuous && eventsMask&(1<<ev) == 0 {
			return false
		}
	}
	return true
}

// minFairCycle finds the shortest fair closed walk of length >= 1 starting
// and ending at start, staying inside allowed[state]. Ties are broken by
// event-ID order. Returns nil if no fair closed walk exists at start.
//
// BFS runs over (current state, visited-states mask, used-events mask):
// at most 8 * 2^8 * 2^5 nodes, so it is exact and terminates quickly.
func minFairCycle(m *Model, start int, allowed []bool) []Step {
	type key struct {
		cur, sm, em int
	}
	type parent struct {
		prev  key
		event int
		to    int
	}
	startKey := key{start, 1 << start, 0}
	parents := map[key]parent{}
	queue := []key{startKey}
	seen := map[key]bool{startKey: true}
	depth := 0
	for len(queue) > 0 {
		var nextLevel []key
		for _, cur := range queue {
			if depth >= 1 && cur.cur == start && fairWalk(m, cur.sm, cur.em) {
				// Reconstruct walk from parent chain.
				var rev []Step
				k := cur
				for k != startKey {
					p := parents[k]
					rev = append(rev, Step{From: p.prev.cur, Event: p.event, To: p.to})
					k = p.prev
				}
				for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
					rev[i], rev[j] = rev[j], rev[i]
				}
				return rev
			}
			for ev := 0; ev < m.NumEvents(); ev++ {
				for _, dst := range m.Next(cur.cur, ev) {
					if !allowed[dst] {
						continue
					}
					nk := key{dst, cur.sm | (1 << dst), cur.em | (1 << ev)}
					if !seen[nk] {
						seen[nk] = true
						parents[nk] = parent{prev: cur, event: ev, to: dst}
						nextLevel = append(nextLevel, nk)
					}
				}
			}
		}
		queue = nextLevel
		depth++
	}
	return nil
}

// shortestPrefixViaBad finds the shortest trace from the initial state to
// target that visits at least one bad state along the way (including the
// initial or target state). Ties broken by event-ID order. nil if none.
func shortestPrefixViaBad(m *Model, target int) []Step {
	init := m.InitialIndex()
	type node struct {
		state   int
		seenBad bool
	}
	type item struct {
		node
		path []Step
	}
	start := node{init, m.IsBad(init)}
	visited := map[node]bool{start: true}
	queue := []item{{node: start}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.state == target && cur.seenBad {
			return cur.path
		}
		for ev := 0; ev < m.NumEvents(); ev++ {
			for _, dst := range m.Next(cur.state, ev) {
				nk := node{dst, cur.seenBad || m.IsBad(dst)}
				if visited[nk] {
					continue
				}
				visited[nk] = true
				path := make([]Step, len(cur.path)+1)
				copy(path, cur.path)
				path[len(cur.path)] = Step{From: cur.state, Event: ev, To: dst}
				queue = append(queue, item{node: nk, path: path})
			}
		}
	}
	return nil
}

// lexLess compares event-ID sequences.
func lexLess(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// walkVisitsBad reports whether any From/To state of the walk is bad.
func walkVisitsBad(m *Model, walk []Step) bool {
	if len(walk) == 0 {
		return false
	}
	if m.IsBad(walk[0].From) {
		return true
	}
	for _, s := range walk {
		if m.IsBad(s.To) {
			return true
		}
	}
	return false
}

// reachableSet returns the set of states reachable from the given seeds.
func reachableSet(m *Model, seeds []int) []bool {
	reach := make([]bool, m.NumStates())
	queue := append([]int(nil), seeds...)
	for _, s := range seeds {
		reach[s] = true
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for ev := 0; ev < m.NumEvents(); ev++ {
			for _, dst := range m.Next(cur, ev) {
				if !reach[dst] {
					reach[dst] = true
					queue = append(queue, dst)
				}
			}
		}
	}
	return reach
}

// FairCheck searches for the shortest fair infinite violation of the
// invariant: a lasso whose prefix leads from the initial state (visiting a
// bad state) into a fair cycle — one in which every continuously ready
// event occurs. The cycle repeated forever is an infinite counterexample.
//
// If no such lasso exists, the result carries the complete SCC evidence
// proving it globally (finite state table => the analysis is exact and
// covers all unbounded behaviours, unlike BoundedCheck).
func FairCheck(m *Model) FairResult {
	comps, _ := scc(m)
	init := m.InitialIndex()

	reachInit := reachableSet(m, []int{init})
	var badSeeds []int
	for s := 0; s < m.NumStates(); s++ {
		if m.IsBad(s) && reachInit[s] {
			badSeeds = append(badSeeds, s)
		}
	}
	reachBad := reachableSet(m, badSeeds)

	res := FairResult{BadReachable: len(badSeeds) > 0}

	// Per-SCC fair cycles, plus best lasso candidate.
	type candidate struct {
		lasso  *Lasso
		events []int
	}
	var best *candidate
	fairCycleAt := make([][]Step, m.NumStates()) // per start state
	for _, comp := range comps {
		allowed := make([]bool, m.NumStates())
		for _, s := range comp {
			allowed[s] = true
		}
		for _, s := range comp {
			fairCycleAt[s] = minFairCycle(m, s, allowed)
		}
	}

	for s := 0; s < m.NumStates(); s++ {
		cycle := fairCycleAt[s]
		if cycle == nil || !reachInit[s] {
			continue
		}
		cycleBad := walkVisitsBad(m, cycle)
		var prefix []Step
		if cycleBad {
			// The cycle itself visits a bad state: any shortest path to
			// the cycle entry completes the violation.
			prefix = shortestPath(m, init, s)
		} else {
			// The prefix must supply the bad state on the way to s.
			prefix = shortestPrefixViaBad(m, s)
		}
		if prefix == nil {
			continue
		}
		lasso := &Lasso{Prefix: prefix, Cycle: cycle}
		ev := lasso.Events()
		if best == nil || len(ev) < len(best.events) ||
			(len(ev) == len(best.events) && lexLess(ev, best.events)) {
			best = &candidate{lasso: lasso, events: ev}
		}
	}
	if best != nil {
		res.Violation = best.lasso
	}

	// Complete SCC evidence (valid as a global proof when Violation is nil).
	for i, comp := range comps {
		ev := SCCEvidence{ID: i}
		for _, s := range comp {
			ev.States = append(ev.States, m.StateName(s))
			if m.IsBad(s) {
				ev.ContainsBad = true
			}
			if reachInit[s] {
				ev.ReachableFromInitial = true
			}
			if reachBad[s] {
				ev.ReachableFromBad = true
			}
			if fairCycleAt[s] != nil {
				ev.HasFairCycle = true
			}
		}
		res.Evidence = append(res.Evidence, ev)
	}
	return res
}

// shortestPath is a plain BFS shortest path (event-ID tie-break) between
// two states, or nil if unreachable.
func shortestPath(m *Model, from, to int) []Step {
	if from == to {
		return []Step{}
	}
	type item struct {
		state int
		path  []Step
	}
	visited := map[int]bool{from: true}
	queue := []item{{state: from}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for ev := 0; ev < m.NumEvents(); ev++ {
			for _, dst := range m.Next(cur.state, ev) {
				if visited[dst] {
					continue
				}
				visited[dst] = true
				path := make([]Step, len(cur.path)+1)
				copy(path, cur.path)
				path[len(cur.path)] = Step{From: cur.state, Event: ev, To: dst}
				if dst == to {
					return path
				}
				queue = append(queue, item{state: dst, path: path})
			}
		}
	}
	return nil
}

// ContinuouslyEnabled returns the event indices enabled at every given state.
func ContinuouslyEnabled(m *Model, states []int) []int {
	var out []int
	for ev := 0; ev < m.NumEvents(); ev++ {
		all := true
		for _, s := range states {
			if !m.Enabled(s, ev) {
				all = false
				break
			}
		}
		if all {
			out = append(out, ev)
		}
	}
	return out
}

// compOfState is exported for tests that cross-check SCC structure.
func CompOf(m *Model) (comps [][]int, compOf []int) { return scc(m) }
