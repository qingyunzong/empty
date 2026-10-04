package checker

import (
	"fmt"
	"math/bits"
	"sort"
)

// Lasso is an infinite counterexample to the liveness property "goal states
// are visited infinitely often": a finite Prefix from the initial state,
// then a Cycle repeated forever. The cycle stays in goal-free states and is
// fair: every event that is continuously enabled (enabled at every state of
// the cycle) is fired inside the cycle.
type Lasso struct {
	Prefix Trace `json:"prefix"`
	Cycle  Trace `json:"cycle"`
}

// SCCEvidence explains why one strongly connected component of the reachable
// goal-free subgraph cannot host a fair cycle. Together the entries are the
// complete evidence that no fair violation exists.
type SCCEvidence struct {
	States       []string `json:"states"`
	Kind         string   `json:"kind"` // "trivial" | "unfair"
	WitnessEvent string   `json:"witness_event,omitempty"`
	Detail       string   `json:"detail"`
}

// FairViolation looks for a reachable fair cycle in the goal-free subgraph.
// On success it returns the shortest lasso (minimizing prefix+cycle length,
// then prefix length, then event ID order). On failure it returns complete
// SCC evidence: every SCC of the reachable goal-free subgraph with the
// reason it cannot host a fair cycle.
//
// A state set W hosts a fair cycle iff W is strongly connected, contains a
// cycle, and every event enabled at every state of W is fired on some edge
// inside W (then a closed walk visiting all of W and firing all those
// events exists, and it is fair). It suffices to inspect maximal SCCs for
// existence; subsets are still enumerated to find the shortest witness.
func (m *Model) FairViolation() (Lasso, []SCCEvidence, bool) {
	gf := m.reachableMask() &^ m.goalMask()
	if lasso, ok := m.bestLasso(gf); ok {
		return lasso, nil, true
	}
	return Lasso{}, m.sccEvidence(gf), false
}

func (m *Model) reachableMask() int {
	n := m.NumStates()
	visited := make([]bool, n)
	init := m.InitState()
	visited[init] = true
	queue := []int{init}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for e := 0; e < m.NumEvents(); e++ {
			for _, nxt := range m.delta[cur][e] {
				if !visited[nxt] {
					visited[nxt] = true
					queue = append(queue, nxt)
				}
			}
		}
	}
	mask := 0
	for s := 0; s < n; s++ {
		if visited[s] {
			mask |= 1 << s
		}
	}
	return mask
}

func (m *Model) goalMask() int {
	mask := 0
	for s := 0; s < m.NumStates(); s++ {
		if m.goal[s] {
			mask |= 1 << s
		}
	}
	return mask
}

// enabledEverywhere lists events enabled at every state of mask.
func (m *Model) enabledEverywhere(mask int) []int {
	var out []int
	for e := 0; e < m.NumEvents(); e++ {
		ok := true
		for s := 0; s < m.NumStates(); s++ {
			if mask&(1<<s) != 0 && len(m.delta[s][e]) == 0 {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, e)
		}
	}
	return out
}

// internalEdgeFires reports whether some edge firing e stays inside mask.
func (m *Model) internalEdgeFires(mask, e int) bool {
	for s := 0; s < m.NumStates(); s++ {
		if mask&(1<<s) == 0 {
			continue
		}
		for _, t := range m.delta[s][e] {
			if mask&(1<<t) != 0 {
				return true
			}
		}
	}
	return false
}

// reachesWithin reports whether from can reach any state of targets using
// only states of mask (zero or more steps).
func (m *Model) reachesWithin(mask, from, targets int) bool {
	seen := 1 << from
	stack := []int{from}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if targets&(1<<cur) != 0 {
			return true
		}
		for e := 0; e < m.NumEvents(); e++ {
			for _, nxt := range m.delta[cur][e] {
				if mask&(1<<nxt) != 0 && seen&(1<<nxt) == 0 {
					seen |= 1 << nxt
					stack = append(stack, nxt)
				}
			}
		}
	}
	return false
}

func (m *Model) stronglyConnected(mask int) bool {
	if mask == 0 {
		return false
	}
	first := bits.TrailingZeros(uint(mask))
	if !m.reachesWithin(mask, first, mask) {
		return false
	}
	for s := 0; s < m.NumStates(); s++ {
		if mask&(1<<s) != 0 && !m.reachesWithin(mask, s, 1<<first) {
			return false
		}
	}
	return true
}

func (m *Model) hasCycle(mask int) bool {
	if mask == 0 {
		return false
	}
	if mask&(mask-1) == 0 { // singleton: needs a self-loop
		s := bits.TrailingZeros(uint(mask))
		for e := 0; e < m.NumEvents(); e++ {
			for _, t := range m.delta[s][e] {
				if t == s {
					return true
				}
			}
		}
		return false
	}
	return m.stronglyConnected(mask)
}

// feasibleFairSet reports whether mask hosts a fair cycle.
func (m *Model) feasibleFairSet(mask int) bool {
	if mask == 0 || !m.stronglyConnected(mask) || !m.hasCycle(mask) {
		return false
	}
	for _, e := range m.enabledEverywhere(mask) {
		if !m.internalEdgeFires(mask, e) {
			return false
		}
	}
	return true
}

func (m *Model) bestLasso(gf int) (Lasso, bool) {
	var best Lasso
	found := false
	for mask := 1; mask < (1 << m.NumStates()); mask++ {
		if mask&^gf != 0 || !m.feasibleFairSet(mask) {
			continue
		}
		for s0 := 0; s0 < m.NumStates(); s0++ {
			if mask&(1<<s0) == 0 {
				continue
			}
			prefix, ok := m.shortestPath(s0)
			if !ok {
				continue
			}
			cycle, ok := m.shortestFairWalk(mask, s0)
			if !ok {
				continue
			}
			cand := Lasso{Prefix: prefix, Cycle: cycle}
			if !found || m.lassoLess(cand, best) {
				best, found = cand, true
			}
		}
	}
	return best, found
}

func (m *Model) lassoLess(a, b Lasso) bool {
	la := len(a.Prefix.Events) + len(a.Cycle.Events)
	lb := len(b.Prefix.Events) + len(b.Cycle.Events)
	if la != lb {
		return la < lb
	}
	if len(a.Prefix.Events) != len(b.Prefix.Events) {
		return len(a.Prefix.Events) < len(b.Prefix.Events)
	}
	if c := m.compareEventNames(a.Prefix.Events, b.Prefix.Events); c != 0 {
		return c < 0
	}
	return m.compareEventNames(a.Cycle.Events, b.Cycle.Events) < 0
}

func (m *Model) compareEventNames(a, b []string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		ia, ib := m.eventIdx[a[i]], m.eventIdx[b[i]]
		if ia != ib {
			if ia < ib {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

// shortestFairWalk finds the shortest closed walk from s0 that stays inside
// mask, visits every state of mask, and fires every event enabled at every
// state of mask. Such a walk is fair: any event enabled at every state it
// visits is enabled at every state of mask, hence required, hence fired.
// BFS over (state, fired-mask, seen-mask) with events in ID order gives the
// shortest walk, lexicographically smallest by event ID.
func (m *Model) shortestFairWalk(mask, s0 int) (Trace, bool) {
	required := 0
	for _, e := range m.enabledEverywhere(mask) {
		required |= 1 << e
	}
	const evShift = 3       // 3 bits: current state (<= 8 states)
	const seenShift = 3 + 5 // 5 bits: fired required events; then 8 bits: seen states
	startKey := s0 | (1<<s0)<<seenShift
	isGoal := func(key int) bool {
		return key&7 == s0 &&
			(key>>evShift)&31 == required &&
			(key>>seenShift)&255 == mask
	}
	parent := map[int]int{startKey: -1}
	parentEvent := map[int]int{}
	queue := []int{startKey}
	for len(queue) > 0 {
		key := queue[0]
		queue = queue[1:]
		cur := key & 7
		ev := (key >> evShift) & 31
		seen := (key >> seenShift) & 255
		for e := 0; e < m.NumEvents(); e++ {
			ev2 := ev
			if required&(1<<e) != 0 {
				ev2 |= 1 << e
			}
			for _, t := range m.delta[cur][e] {
				if mask&(1<<t) == 0 {
					continue
				}
				nkey := t | ev2<<evShift | (seen|1<<t)<<seenShift
				if isGoal(nkey) { // checked before visited: startKey may be re-entered
					return m.walkTrace(startKey, key, nkey, e, parent, parentEvent), true
				}
				if _, ok := parent[nkey]; ok {
					continue
				}
				parent[nkey] = key
				parentEvent[nkey] = e
				queue = append(queue, nkey)
			}
		}
	}
	return Trace{}, false
}

func (m *Model) walkTrace(startKey, lastKey, goalKey, lastEvent int, parent, parentEvent map[int]int) Trace {
	chain := []int{goalKey}
	for k := lastKey; ; k = parent[k] {
		chain = append(chain, k)
		if k == startKey {
			break
		}
	}
	var states []string
	var events []string
	for i := len(chain) - 1; i >= 0; i-- {
		states = append(states, m.Spec.States[chain[i]&7])
		if i > 0 {
			if chain[i-1] == goalKey {
				events = append(events, m.Spec.Events[lastEvent])
			} else {
				events = append(events, m.Spec.Events[parentEvent[chain[i-1]]])
			}
		}
	}
	return Trace{States: states, Events: events}
}

// sccEvidence builds the complete evidence that no reachable fair cycle
// exists: every SCC of the reachable goal-free subgraph, each with the
// reason it cannot host a fair cycle.
func (m *Model) sccEvidence(gf int) []SCCEvidence {
	var out []SCCEvidence
	for _, scc := range m.tarjan(gf) {
		mask := 0
		var names []string
		for _, s := range scc {
			mask |= 1 << s
			names = append(names, m.Spec.States[s])
		}
		switch {
		case !m.hasCycle(mask):
			out = append(out, SCCEvidence{
				States: names,
				Kind:   "trivial",
				Detail: "no internal cycle; no infinite execution stays here",
			})
		default:
			missing := -1
			for _, e := range m.enabledEverywhere(mask) {
				if !m.internalEdgeFires(mask, e) {
					missing = e
					break
				}
			}
			if missing < 0 {
				// Unreachable: bestLasso would have found this SCC feasible.
				out = append(out, SCCEvidence{
					States: names,
					Kind:   "fair",
					Detail: "admits a fair cycle (internal inconsistency)",
				})
				continue
			}
			out = append(out, SCCEvidence{
				States:       names,
				Kind:         "unfair",
				WitnessEvent: m.Spec.Events[missing],
				Detail: fmt.Sprintf("event %q is enabled at every state but never fired inside the SCC",
					m.Spec.Events[missing]),
			})
		}
	}
	return out
}

// tarjan returns the SCCs of the subgraph induced by mask, sorted by their
// smallest state index; states within each SCC are sorted.
func (m *Model) tarjan(mask int) [][]int {
	n := m.NumStates()
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	for i := range index {
		index[i] = -1
	}
	var stack []int
	counter := 0
	var sccs [][]int
	var connect func(v int)
	connect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for e := 0; e < m.NumEvents(); e++ {
			for _, w := range m.delta[v][e] {
				if mask&(1<<w) == 0 {
					continue
				}
				if index[w] == -1 {
					connect(w)
					if low[w] < low[v] {
						low[v] = low[w]
					}
				} else if onStack[w] && index[w] < low[v] {
					low[v] = index[w]
				}
			}
		}
		if low[v] == index[v] {
			var scc []int
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				scc = append(scc, w)
				if w == v {
					break
				}
			}
			sort.Ints(scc)
			sccs = append(sccs, scc)
		}
	}
	for s := 0; s < n; s++ {
		if mask&(1<<s) != 0 && index[s] == -1 {
			connect(s)
		}
	}
	sort.Slice(sccs, func(i, j int) bool { return sccs[i][0] < sccs[j][0] })
	return sccs
}
