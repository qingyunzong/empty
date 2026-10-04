// Package verify independently re-checks the results of package checker.
// It deliberately re-derives everything from the raw spec with its own
// code: layered enumeration of event sequences for bounded safety, explicit
// unrolling of fair cycles, and mutual-reachability SCC decomposition for
// the no-fair-cycle evidence.
package verify

import (
	"errors"
	"fmt"
	"sort"

	"faircheck/checker"
)

// table is verify's own compiled view of a spec (bitmask based).
type table struct {
	states []string
	events []string
	init   int
	step   [][]int // step[state][event] = bitmask of targets
	bad    []bool
	goal   []bool
}

func compile(spec checker.Spec) *table {
	t := &table{states: spec.States, events: spec.Events}
	sidx := make(map[string]int, len(spec.States))
	for i, s := range spec.States {
		sidx[s] = i
	}
	eidx := make(map[string]int, len(spec.Events))
	for i, e := range spec.Events {
		eidx[e] = i
	}
	t.init = sidx[spec.Initial]
	t.step = make([][]int, len(spec.States))
	for i := range t.step {
		t.step[i] = make([]int, len(spec.Events))
	}
	for _, tr := range spec.Transitions {
		t.step[sidx[tr.From]][eidx[tr.Event]] |= 1 << sidx[tr.To]
	}
	t.bad = make([]bool, len(spec.States))
	for _, b := range spec.Bad {
		t.bad[sidx[b]] = true
	}
	t.goal = make([]bool, len(spec.States))
	for _, g := range spec.Goal {
		t.goal[sidx[g]] = true
	}
	return t
}

// LayeredMinViolation enumerates event sequences layer by layer (length
// 0,1,...,budget), in event ID order within each layer, tracking the set of
// reachable states (subset construction). It returns the first sequence
// whose reachable set contains a bad state: the shortest violating
// sequence, ties broken by event ID order. This independently confirms the
// counterexample length and the budget boundary reported by checker.
func LayeredMinViolation(spec checker.Spec, budget int) ([]string, bool) {
	tb := compile(spec)
	for depth := 0; depth <= budget; depth++ {
		if seq, ok := tb.enumAtDepth(depth); ok {
			return seq, true
		}
	}
	return nil, false
}

func (tb *table) enumAtDepth(depth int) ([]string, bool) {
	dead := map[[2]int]bool{} // (state set, remaining depth) fully explored, no hit
	var rec func(curSet, remaining int, path []string) ([]string, bool)
	rec = func(curSet, remaining int, path []string) ([]string, bool) {
		if remaining == 0 {
			for s := 0; s < len(tb.states); s++ {
				if curSet&(1<<s) != 0 && tb.bad[s] {
					return append([]string{}, path...), true
				}
			}
			return nil, false
		}
		if curSet == 0 {
			return nil, false
		}
		key := [2]int{curSet, remaining}
		if dead[key] {
			return nil, false
		}
		for e := 0; e < len(tb.events); e++ {
			next := 0
			for s := 0; s < len(tb.states); s++ {
				if curSet&(1<<s) != 0 {
					next |= tb.step[s][e]
				}
			}
			if next == 0 {
				continue
			}
			if seq, ok := rec(next, remaining-1, append(path, tb.events[e])); ok {
				return seq, true
			}
		}
		dead[key] = true
		return nil, false
	}
	return rec(1<<tb.init, depth, nil)
}

// CheckLasso unrolls the lasso: it replays the prefix and then the cycle
// `unroll` times, validating every step against the state table, and checks
// on one period of the cycle that (a) no goal state is visited and (b) the
// fairness condition holds — every event enabled at every state of the
// cycle is fired inside the cycle.
func CheckLasso(spec checker.Spec, lasso checker.Lasso, unroll int) error {
	tb := compile(spec)
	if unroll < 1 {
		unroll = 1
	}
	sidx := make(map[string]int, len(tb.states))
	for i, s := range tb.states {
		sidx[s] = i
	}
	eidx := make(map[string]int, len(tb.events))
	for i, e := range tb.events {
		eidx[e] = i
	}
	checkStep := func(from, event, to string) error {
		f, ok := sidx[from]
		if !ok {
			return fmt.Errorf("unknown state %q", from)
		}
		e, ok := eidx[event]
		if !ok {
			return fmt.Errorf("unknown event %q", event)
		}
		t, ok := sidx[to]
		if !ok {
			return fmt.Errorf("unknown state %q", to)
		}
		if tb.step[f][e]&(1<<t) == 0 {
			return fmt.Errorf("no transition %s -%s-> %s", from, event, to)
		}
		return nil
	}

	prefix, cycle := lasso.Prefix, lasso.Cycle
	if len(prefix.States) == 0 || len(prefix.States) != len(prefix.Events)+1 {
		return errors.New("malformed prefix")
	}
	if prefix.States[0] != spec.Initial {
		return fmt.Errorf("prefix starts at %q, not initial state %q", prefix.States[0], spec.Initial)
	}
	for i, ev := range prefix.Events {
		if err := checkStep(prefix.States[i], ev, prefix.States[i+1]); err != nil {
			return fmt.Errorf("prefix step %d: %w", i, err)
		}
	}
	if len(cycle.Events) == 0 || len(cycle.States) != len(cycle.Events)+1 {
		return errors.New("malformed cycle")
	}
	if cycle.States[0] != cycle.States[len(cycle.States)-1] {
		return errors.New("cycle does not return to its start state")
	}
	if prefix.States[len(prefix.States)-1] != cycle.States[0] {
		return errors.New("prefix does not end at the cycle start")
	}
	for k := 0; k < unroll; k++ {
		for i, ev := range cycle.Events {
			if err := checkStep(cycle.States[i], ev, cycle.States[i+1]); err != nil {
				return fmt.Errorf("cycle step %d (unrolling %d): %w", i, k, err)
			}
		}
	}
	period := cycle.States[:len(cycle.States)-1]
	for _, s := range period {
		if tb.goal[sidx[s]] {
			return fmt.Errorf("cycle visits goal state %q", s)
		}
	}
	used := make(map[string]bool, len(cycle.Events))
	for _, ev := range cycle.Events {
		used[ev] = true
	}
	for e := 0; e < len(tb.events); e++ {
		continuous := true
		for _, s := range period {
			if tb.step[sidx[s]][e] == 0 {
				continuous = false
				break
			}
		}
		if continuous && !used[tb.events[e]] {
			return fmt.Errorf("unfair cycle: event %q is continuously enabled but never fired", tb.events[e])
		}
	}
	return nil
}

// CheckNoFairCycle independently decides whether a reachable fair cycle
// exists, using its own reachability and subset enumeration. It returns a
// witnessing state set when one exists; checker.FairViolation must agree.
func CheckNoFairCycle(spec checker.Spec) ([]string, bool) {
	tb := compile(spec)
	gf := tb.reachableGoalFree()
	for bits := 1; bits < (1 << len(gf)); bits++ {
		var set []int
		for i, s := range gf {
			if bits&(1<<i) != 0 {
				set = append(set, s)
			}
		}
		if tb.hostsFairCycle(set) {
			names := make([]string, len(set))
			for i, s := range set {
				names[i] = tb.states[s]
			}
			return names, true
		}
	}
	return nil, false
}

// CheckSCCEvidence validates the "no fair cycle" evidence with an
// independent SCC decomposition via mutual reachability: the evidence must
// cover exactly the SCCs of the reachable goal-free subgraph, every claimed
// reason must check out, and no SCC may secretly host a fair cycle.
func CheckSCCEvidence(spec checker.Spec, evidence []checker.SCCEvidence) error {
	tb := compile(spec)
	gf := tb.reachableGoalFree()
	sccs := tb.sccs(gf)
	if len(evidence) != len(sccs) {
		return fmt.Errorf("evidence covers %d SCCs, expected %d", len(evidence), len(sccs))
	}
	used := make([]bool, len(sccs))
	for _, ev := range evidence {
		idx := -1
		for i, scc := range sccs {
			if !used[i] && stringSetEq(ev.States, scc) {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("evidence states %v do not match any SCC", ev.States)
		}
		used[idx] = true
		if err := tb.checkEvidenceEntry(ev); err != nil {
			return err
		}
	}
	for _, scc := range sccs {
		var set []int
		sidx := make(map[string]int, len(tb.states))
		for i, s := range tb.states {
			sidx[s] = i
		}
		for _, name := range scc {
			set = append(set, sidx[name])
		}
		if tb.hostsFairCycle(set) {
			return fmt.Errorf("SCC %v hosts a fair cycle but evidence claims none", scc)
		}
	}
	return nil
}

func (tb *table) reachableGoalFree() []int {
	n := len(tb.states)
	reach := make([]bool, n)
	var dfs func(s int)
	dfs = func(s int) {
		if reach[s] {
			return
		}
		reach[s] = true
		for e := range tb.events {
			m := tb.step[s][e]
			for m != 0 {
				t := m & -m
				m &^= t
				dfs(bitIndex(t))
			}
		}
	}
	dfs(tb.init)
	var gf []int
	for s := 0; s < n; s++ {
		if reach[s] && !tb.goal[s] {
			gf = append(gf, s)
		}
	}
	return gf
}

// sccs computes SCCs of the subgraph induced by states as mutual
// reachability classes (independent of checker's Tarjan).
func (tb *table) sccs(states []int) [][]string {
	inSet := make([]bool, len(tb.states))
	for _, s := range states {
		inSet[s] = true
	}
	reach := func(from int) map[int]bool {
		seen := map[int]bool{from: true}
		stack := []int{from}
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for e := range tb.events {
				m := tb.step[cur][e]
				for m != 0 {
					t := m & -m
					m &^= t
					nxt := bitIndex(t)
					if inSet[nxt] && !seen[nxt] {
						seen[nxt] = true
						stack = append(stack, nxt)
					}
				}
			}
		}
		return seen
	}
	assigned := make(map[int]bool)
	var sccs [][]string
	for _, s := range states {
		if assigned[s] {
			continue
		}
		fwd := reach(s)
		var scc []string
		for _, t := range states {
			if fwd[t] && reach(t)[s] {
				scc = append(scc, tb.states[t])
				assigned[t] = true
			}
		}
		sort.Strings(scc)
		sccs = append(sccs, scc)
	}
	sort.Slice(sccs, func(i, j int) bool { return sccs[i][0] < sccs[j][0] })
	return sccs
}

func (tb *table) checkEvidenceEntry(ev checker.SCCEvidence) error {
	sidx := make(map[string]int, len(tb.states))
	for i, s := range tb.states {
		sidx[s] = i
	}
	var set []int
	for _, name := range ev.States {
		s, ok := sidx[name]
		if !ok {
			return fmt.Errorf("evidence mentions unknown state %q", name)
		}
		set = append(set, s)
	}
	inSet := make([]bool, len(tb.states))
	for _, s := range set {
		inSet[s] = true
	}
	switch ev.Kind {
	case "trivial":
		if len(set) != 1 {
			return fmt.Errorf("SCC %v marked trivial but has %d states", ev.States, len(set))
		}
		s := set[0]
		for e := range tb.events {
			if tb.step[s][e]&(1<<s) != 0 {
				return fmt.Errorf("SCC %v marked trivial but has a self-loop", ev.States)
			}
		}
	case "unfair":
		eidx := -1
		for i, e := range tb.events {
			if e == ev.WitnessEvent {
				eidx = i
			}
		}
		if eidx < 0 {
			return fmt.Errorf("evidence mentions unknown event %q", ev.WitnessEvent)
		}
		for _, s := range set {
			if tb.step[s][eidx] == 0 {
				return fmt.Errorf("witness event %q not enabled at every state of %v", ev.WitnessEvent, ev.States)
			}
		}
		for _, s := range set {
			if tb.step[s][eidx]&bitMaskOf(inSet) != 0 {
				return fmt.Errorf("witness event %q has an internal edge in %v", ev.WitnessEvent, ev.States)
			}
		}
	default:
		return fmt.Errorf("unexpected evidence kind %q", ev.Kind)
	}
	return nil
}

// hostsFairCycle reports whether the given state set hosts a fair cycle:
// strongly connected, contains a cycle, and every event enabled at every
// state of the set is fired on some edge inside the set.
func (tb *table) hostsFairCycle(set []int) bool {
	inSet := make([]bool, len(tb.states))
	for _, s := range set {
		inSet[s] = true
	}
	reach := func(from int) map[int]bool {
		seen := map[int]bool{from: true}
		stack := []int{from}
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for e := range tb.events {
				m := tb.step[cur][e]
				for m != 0 {
					t := m & -m
					m &^= t
					nxt := bitIndex(t)
					if inSet[nxt] && !seen[nxt] {
						seen[nxt] = true
						stack = append(stack, nxt)
					}
				}
			}
		}
		return seen
	}
	for _, s := range set {
		r := reach(s)
		for _, t := range set {
			if !r[t] {
				return false
			}
		}
	}
	hasCycle := len(set) >= 2
	if len(set) == 1 {
		s := set[0]
		for e := range tb.events {
			if tb.step[s][e]&(1<<s) != 0 {
				hasCycle = true
			}
		}
	}
	if !hasCycle {
		return false
	}
	inner := bitMaskOf(inSet)
	for e := range tb.events {
		enabledAll := true
		for _, s := range set {
			if tb.step[s][e] == 0 {
				enabledAll = false
				break
			}
		}
		if !enabledAll {
			continue
		}
		fired := false
		for _, s := range set {
			if tb.step[s][e]&inner != 0 {
				fired = true
			}
		}
		if !fired {
			return false
		}
	}
	return true
}

func bitIndex(bit int) int {
	i := 0
	for bit > 1 {
		bit >>= 1
		i++
	}
	return i
}

func bitMaskOf(inSet []bool) int {
	mask := 0
	for i, ok := range inSet {
		if ok {
			mask |= 1 << i
		}
	}
	return mask
}

func stringSetEq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	as := append([]string{}, a...)
	bs := append([]string{}, b...)
	sort.Strings(as)
	sort.Strings(bs)
	for i := range as {
		if as[i] != bs[i] {
			return false
		}
	}
	return true
}
