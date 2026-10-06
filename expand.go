package rescheck

import (
	"fmt"
	"strings"
)

// Expanded is the result of bounded path expansion: every execution path
// of the program (loops unrolled up to a visit bound) is walked
// concretely, so violations carry exact violating paths and every block
// is annotated with the set of states observed on entry.
type Expanded struct {
	Violations []Violation
	StatesAt   map[*Block][]*State // concrete entry states observed per block
}

// Expand enumerates execution paths from the entry block. A block may
// appear at most maxVisits times on a single path, which bounds loop
// unrolling and keeps the enumeration finite.
func Expand(p *Program, maxVisits int) *Expanded {
	p.Finalize()
	ex := &Expanded{StatesAt: map[*Block][]*State{}}
	seen := map[string]bool{}
	emit := func(v Violation) {
		key := v.Kind + "|" + v.Var + "|" + v.Block + "|" + strings.Join(v.Path, ">")
		if !seen[key] {
			seen[key] = true
			ex.Violations = append(ex.Violations, v)
		}
	}

	var rec func(b *Block, s *State, visits map[*Block]int)
	rec = func(b *Block, s *State, visits map[*Block]int) {
		if visits[b] >= maxVisits {
			return
		}
		visits[b]++
		defer delete(visits, b)

		cur := s.clone()
		cur.enter(b.Label)
		ex.StatesAt[b] = append(ex.StatesAt[b], cur.clone())
		for _, ins := range b.Instrs {
			step(cur, ins, b, emit)
		}
		if len(b.Succs) == 0 {
			// Falling off the end without an explicit exit is an
			// implicit return.
			if endsWithExit(b) {
				return
			}
			step(cur, Ret(), b, emit)
			return
		}
		for _, succ := range b.Succs {
			rec(succ, cur, visits)
		}
	}
	rec(p.Entry, newState(), map[*Block]int{})
	return ex
}

// LoopHeaders returns the targets of back edges, i.e. the blocks that
// head a natural loop, found by DFS from the entry block.
func LoopHeaders(p *Program) []*Block {
	p.Finalize()
	visited := map[*Block]bool{}
	onStack := map[*Block]bool{}
	isHeader := map[*Block]bool{}
	var order []*Block

	var dfs func(b *Block)
	dfs = func(b *Block) {
		visited[b] = true
		onStack[b] = true
		for _, s := range b.Succs {
			switch {
			case onStack[s]:
				if !isHeader[s] {
					isHeader[s] = true
					order = append(order, s)
				}
			case !visited[s]:
				dfs(s)
			}
		}
		onStack[b] = false
	}
	dfs(p.Entry)
	return order
}

// stateSetKey canonicalizes a state for set comparison (Way excluded).
func stateSetKey(s *State) string {
	var sb strings.Builder
	for _, k := range sortedKeys(s.Vars) {
		fmt.Fprintf(&sb, "%s=%s;", k, s.Vars[k])
	}
	return sb.String()
}

func stateSet(states []*State) map[string]bool {
	set := map[string]bool{}
	for _, s := range states {
		set[stateSetKey(s)] = true
	}
	return set
}

// FixedPointReached reports whether expanding loops k times already
// yields every abstract state observable at loop headers, i.e. whether
// the loop fixed point is reached after k unrollings. It cross-checks
// the dataflow fixed point against concrete path expansion.
func FixedPointReached(p *Program, k int) bool {
	a := Expand(p, k)
	b := Expand(p, k+1)
	for _, h := range LoopHeaders(p) {
		sa, sb := stateSet(a.StatesAt[h]), stateSet(b.StatesAt[h])
		if len(sa) != len(sb) {
			return false
		}
		for key := range sa {
			if !sb[key] {
				return false
			}
		}
	}
	return true
}

// leq reports whether a is below b in the lattice order.
func leq(a, b Abs) bool { return a == b || a == Uninit || b == Conflict }

// CheckConsistency verifies the merge points: for every block reachable
// by expansion, the join of all concrete entry states must be
// over-approximated by the in-state computed by the dataflow analysis
// (the dataflow result may sit higher in the lattice, e.g. Conflict
// introduced at a loop head). It returns a list of human-readable
// mismatches (empty means the analyses agree).
func CheckConsistency(res *Result, ex *Expanded) []string {
	var problems []string
	for b, states := range ex.StatesAt {
		joined := states[0].clone()
		for _, s := range states[1:] {
			joinInto(joined, s)
		}
		ai := res.In[b]
		if ai == nil {
			problems = append(problems, fmt.Sprintf("block %s: reachable in expansion but not in dataflow", b.Label))
			continue
		}
		bad := false
		for _, k := range sortedKeys(joined.Vars) {
			if !leq(joined.Vars[k], ai.Vars[k]) {
				bad = true
			}
		}
		for _, k := range sortedKeys(ai.Vars) {
			if _, ok := joined.Vars[k]; !ok && ai.Vars[k] != Uninit {
				bad = true
			}
		}
		if bad {
			problems = append(problems, fmt.Sprintf("block %s: dataflow in=%s expansion join=%s",
				b.Label, formatVars(ai), formatVars(joined)))
		}
	}
	return problems
}

func formatVars(s *State) string {
	if len(s.Vars) == 0 {
		return "{}"
	}
	var parts []string
	for _, k := range sortedKeys(s.Vars) {
		parts = append(parts, fmt.Sprintf("%s:%s", k, s.Vars[k]))
	}
	return "{" + strings.Join(parts, " ") + "}"
}

// Diagnosis bundles the dataflow result, the path expansion, the merged
// violation list (concrete violating paths first), and the cross-checks.
type Diagnosis struct {
	Result       *Result
	Expanded     *Expanded
	Violations   []Violation
	Consistency  []string // empty: merge points agree between both analyses
	FixedPointOK bool     // loop headers stable under one more unrolling
}

// Diagnose runs both analyses on p and cross-checks them. maxVisits
// bounds loop unrolling during path expansion (use >= 2 for programs
// with loops).
func Diagnose(p *Program, maxVisits int) *Diagnosis {
	res := Analyze(p)
	ex := Expand(p, maxVisits)

	d := &Diagnosis{
		Result:      res,
		Expanded:    ex,
		Consistency: CheckConsistency(res, ex),
	}
	if maxVisits >= 2 {
		d.FixedPointOK = FixedPointReached(p, maxVisits-1)
	} else {
		d.FixedPointOK = true
	}

	present := map[string]bool{}
	for _, v := range ex.Violations {
		d.Violations = append(d.Violations, v)
		present[v.Kind+"|"+v.Var+"|"+v.Block] = true
	}
	// Keep analysis-only violations (their witness paths come from the
	// dataflow iteration); these can escape the bounded expansion.
	for _, v := range res.Violations {
		key := v.Kind + "|" + v.Var + "|" + v.Block
		if !present[key] {
			d.Violations = append(d.Violations, v)
		}
	}
	return d
}

// Report renders the full diagnosis.
func (d *Diagnosis) Report() string {
	var sb strings.Builder
	if len(d.Violations) == 0 {
		sb.WriteString("no violations\n")
	} else {
		fmt.Fprintf(&sb, "%d violation(s):\n", len(d.Violations))
		for _, v := range d.Violations {
			sb.WriteString("  " + v.String() + "\n")
		}
	}
	fmt.Fprintf(&sb, "merge-point consistency: %v\n", len(d.Consistency) == 0)
	for _, p := range d.Consistency {
		sb.WriteString("  " + p + "\n")
	}
	fmt.Fprintf(&sb, "loop fixed point verified: %v\n", d.FixedPointOK)
	return sb.String()
}
