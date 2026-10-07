package effectcheck

// Analyzer keeps analysis state between edits so that changing one function
// body only recomputes the affected part of the call graph. The result is
// identical to a full re-analysis.
type Analyzer struct {
	prog    *Program
	callers map[string]map[string]struct{} // callee -> callers
	sums    map[string]*Summary
}

// NewAnalyzer runs a full analysis and returns an incremental analyzer
// seeded with its results.
func NewAnalyzer(p *Program) *Analyzer {
	res := Analyze(p)
	return &Analyzer{
		prog:    p,
		callers: p.callers(),
		sums:    res.Summaries,
	}
}

// UpdateFunc replaces (or adds) a function and recomputes only the summaries
// that can depend on it: the function itself and its transitive callers.
// Because summaries are rebuilt from local effects before the fixed-point
// iteration, edits that remove effects are handled as well as additions.
func (a *Analyzer) UpdateFunc(nf *Func) {
	name := nf.Name
	old := a.prog.Funcs[name]
	a.prog.Funcs[name] = nf

	if old != nil {
		for _, callee := range a.prog.callees(old) {
			delete(a.callers[callee], name)
		}
	}
	for _, callee := range a.prog.callees(nf) {
		m := a.callers[callee]
		if m == nil {
			m = make(map[string]struct{})
			a.callers[callee] = m
		}
		m[name] = struct{}{}
	}

	dirty := map[string]struct{}{}
	stack := []string{name}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, ok := dirty[n]; ok {
			continue
		}
		dirty[n] = struct{}{}
		for caller := range a.callers[n] {
			stack = append(stack, caller)
		}
	}

	for d := range dirty {
		a.sums[d] = localSummary(a.prog.Funcs[d])
	}
	for changed := true; changed; {
		changed = false
		for d := range dirty {
			f := a.prog.Funcs[d]
			for _, calleeName := range a.prog.callees(f) {
				cs, ok := a.sums[calleeName]
				if !ok {
					continue
				}
				if absorb(a.sums[d], a.prog.Funcs[calleeName], cs) {
					changed = true
				}
			}
		}
	}
}

// Result returns the current analysis result, recomputing diagnostics.
func (a *Analyzer) Result() *Result {
	return &Result{
		Summaries:   a.sums,
		Diagnostics: diagnostics(a.prog, a.sums),
	}
}

// Program returns the program currently held by the analyzer.
func (a *Analyzer) Program() *Program {
	return a.prog
}
