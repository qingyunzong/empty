package effectcheck

import "fmt"

// Incremental keeps analysis state between edits. After a function body
// is replaced via ReplaceFunc, only the affected part of the call graph
// is re-analyzed; the result is identical to a full re-analysis.
type Incremental struct {
	st *state
}

// NewIncremental runs a full analysis and returns the reusable state.
func NewIncremental(prog *Program) *Incremental {
	st := newState(prog)
	st.analyzeAll()
	return &Incremental{st: st}
}

// Result returns the current analysis result.
func (in *Incremental) Result() *Result { return in.st.result() }

// Recomputed reports how many times each function was re-evaluated by the
// most recent ReplaceFunc call. Functions absent from the map were proven
// unaffected and not touched.
func (in *Incremental) Recomputed() map[string]int {
	out := make(map[string]int, len(in.st.recomputed))
	for k, v := range in.st.recomputed {
		out[k] = v
	}
	return out
}

// ReplaceFunc swaps in a new version of an existing function (same name
// and parameter list) and incrementally re-analyzes the program.
func (in *Incremental) ReplaceFunc(fn *Func) error {
	st := in.st
	old := st.funcs[fn.Name]
	if old == nil {
		return fmt.Errorf("effectcheck: ReplaceFunc: unknown function %q", fn.Name)
	}
	if !equalStrings(old.Params, fn.Params) {
		return fmt.Errorf("effectcheck: ReplaceFunc: cannot change signature of %q", fn.Name)
	}
	for i, f := range st.prog.Funcs {
		if f.Name == fn.Name {
			st.prog.Funcs[i] = fn
			break
		}
	}
	st.funcs[fn.Name] = fn
	st.buildDirect(fn.Name)
	st.rebuildCallers()
	st.recomputed = map[string]int{}

	// Only fn's own facts changed, so only its SCC must be re-evaluated.
	// Callers are re-evaluated lazily below, only if a callee component's
	// published effects actually changed.
	dirty := map[string]bool{fn.Name: true}

	sccs := st.sccs()
	sccOf := map[string]int{}
	for i, scc := range sccs {
		for _, n := range scc {
			sccOf[n] = i
		}
	}
	changedSCC := map[int]bool{}
	for i, scc := range sccs {
		need := false
		for _, n := range scc {
			if dirty[n] {
				need = true
				break
			}
		}
		if !need {
			// Recompute only if a callee component actually changed.
			for _, n := range scc {
				for _, cs := range st.direct[n].calls {
					if j, ok := sccOf[cs.callee]; ok && j != i && changedSCC[j] {
						need = true
						break
					}
				}
				if need {
					break
				}
			}
		}
		if !need {
			continue
		}
		before := map[string]*EffectSet{}
		for _, n := range scc {
			before[n] = st.effects[n]
		}
		st.fixedPoint(scc)
		for _, n := range scc {
			if !st.effects[n].Equal(before[n]) {
				changedSCC[i] = true
				break
			}
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
