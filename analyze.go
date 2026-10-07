// Package effectcheck infers effect sets (region reads/writes and raised
// exceptions) for every function of a program. Recursive and mutually
// recursive functions are solved by least fixed point iteration over the
// call graph's strongly connected components. Function-local regions must
// not escape through return statements; violations are reported as
// diagnostics carrying their source path.
package effectcheck

import (
	"fmt"
	"sort"
)

// Diagnostic is a single analysis finding with a source location.
type Diagnostic struct {
	P   Pos
	Msg string
}

func (d Diagnostic) String() string { return d.P.String() + ": " + d.Msg }

// Result is the outcome of effect analysis: the externally observable
// effect set of every function, plus all diagnostics.
type Result struct {
	Effects     map[string]*EffectSet
	Diagnostics []Diagnostic
}

// Analyze performs a whole-program effect analysis.
func Analyze(prog *Program) *Result {
	st := newState(prog)
	st.analyzeAll()
	return st.result()
}

type callSite struct {
	callee string
	args   []string
}

// directEffects are the facts derived from a function body alone, before
// folding in callee effects.
type directEffects struct {
	eff    *EffectSet
	calls  []callSite
	locals map[string]bool
}

type state struct {
	prog       *Program
	funcs      map[string]*Func
	direct     map[string]*directEffects
	effects    map[string]*EffectSet // published (locals masked) per function
	callers    map[string]map[string]bool
	diags      map[string][]Diagnostic
	recomputed map[string]int // eval count per function, for incrementality stats
}

func newState(prog *Program) *state {
	st := &state{
		prog:       prog,
		funcs:      map[string]*Func{},
		direct:     map[string]*directEffects{},
		effects:    map[string]*EffectSet{},
		callers:    map[string]map[string]bool{},
		diags:      map[string][]Diagnostic{},
		recomputed: map[string]int{},
	}
	for _, f := range prog.Funcs {
		st.funcs[f.Name] = f
		st.effects[f.Name] = NewEffectSet()
	}
	return st
}

func (st *state) analyzeAll() {
	for _, f := range st.prog.Funcs {
		st.buildDirect(f.Name)
	}
	st.rebuildCallers()
	for _, scc := range st.sccs() {
		st.fixedPoint(scc)
	}
}

// buildDirect derives the body-local facts and per-function diagnostics.
func (st *state) buildDirect(name string) {
	fn := st.funcs[name]
	d := &directEffects{eff: NewEffectSet(), locals: map[string]bool{}}
	var diags []Diagnostic

	known := map[string]bool{}
	for _, g := range st.prog.Globals {
		known[g] = true
	}
	for _, p := range fn.Params {
		if known[p] {
			diags = append(diags, Diagnostic{fn.P, fmt.Sprintf("parameter %q shadows a global region", p)})
		}
		known[p] = true
	}
	for _, s := range fn.Body {
		if rd, ok := s.(*RegionDecl); ok {
			if known[rd.Name] {
				diags = append(diags, Diagnostic{rd.P, fmt.Sprintf("local region %q shadows or duplicates an existing region", rd.Name)})
			}
			d.locals[rd.Name] = true
			known[rd.Name] = true
		}
	}

	checkRegion := func(r string, p Pos) {
		if !known[r] {
			diags = append(diags, Diagnostic{p, fmt.Sprintf("unknown region %q", r)})
		}
	}

	for _, s := range fn.Body {
		switch s := s.(type) {
		case *RegionDecl:
		case *ReadStmt:
			checkRegion(s.Region, s.P)
			d.eff.AddRead(s.Region)
		case *WriteStmt:
			checkRegion(s.Region, s.P)
			d.eff.AddWrite(s.Region)
		case *ThrowStmt:
			d.eff.AddThrow(s.Exn)
		case *CallStmt:
			callee := st.funcs[s.Callee]
			switch {
			case callee == nil:
				diags = append(diags, Diagnostic{s.P, fmt.Sprintf("call to unknown function %q", s.Callee)})
			case len(s.Args) != len(callee.Params):
				diags = append(diags, Diagnostic{s.P, fmt.Sprintf("call to %s takes %d args, got %d", s.Callee, len(callee.Params), len(s.Args))})
			}
			for _, a := range s.Args {
				checkRegion(a, s.P)
			}
			d.calls = append(d.calls, callSite{callee: s.Callee, args: s.Args})
		case *ReturnStmt:
			checkRegion(s.Region, s.P)
			if d.locals[s.Region] {
				diags = append(diags, Diagnostic{s.P, fmt.Sprintf("local region %q escapes function %q via return", s.Region, name)})
			}
		}
	}
	st.direct[name] = d
	st.diags[name] = diags
}

func (st *state) rebuildCallers() {
	st.callers = map[string]map[string]bool{}
	for name, d := range st.direct {
		for _, cs := range d.calls {
			if st.funcs[cs.callee] == nil {
				continue
			}
			if st.callers[cs.callee] == nil {
				st.callers[cs.callee] = map[string]bool{}
			}
			st.callers[cs.callee][name] = true
		}
	}
}

// eval computes the published effect set of one function from its direct
// effects and the current published sets of its callees.
func (st *state) eval(name string) *EffectSet {
	d := st.direct[name]
	eff := d.eff.Clone()
	for _, cs := range d.calls {
		callee := st.funcs[cs.callee]
		if callee == nil {
			continue
		}
		sub := map[string]string{}
		for i, p := range callee.Params {
			if i < len(cs.args) {
				sub[p] = cs.args[i]
			}
		}
		eff.Union(st.effects[cs.callee].Subst(sub))
	}
	eff.Mask(d.locals)
	return eff
}

// fixedPoint iterates an SCC until its effect sets stop growing. Starting
// from the bottom (empty) sets and only ever adding effects, this
// converges to the least fixed point.
func (st *state) fixedPoint(scc []string) {
	for {
		changed := false
		for _, name := range scc {
			next := st.eval(name)
			st.recomputed[name]++
			if !next.Equal(st.effects[name]) {
				st.effects[name] = next
				changed = true
			}
		}
		if !changed {
			return
		}
	}
}

// sccs returns the strongly connected components of the call graph in
// callee-first (reverse topological) order, so each component is solved
// once with final callee values.
func (st *state) sccs() [][]string {
	index := map[string]int{}
	low := map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	var out [][]string
	counter := 0
	var visit func(v string)
	visit = func(v string) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for _, cs := range st.direct[v].calls {
			w := cs.callee
			if st.funcs[w] == nil {
				continue
			}
			if _, seen := index[w]; !seen {
				visit(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] && index[w] < low[v] {
				low[v] = index[w]
			}
		}
		if low[v] == index[v] {
			var scc []string
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				scc = append(scc, w)
				if w == v {
					break
				}
			}
			out = append(out, scc)
		}
	}
	for _, f := range st.prog.Funcs {
		if _, seen := index[f.Name]; !seen {
			visit(f.Name)
		}
	}
	return out
}

func (st *state) result() *Result {
	res := &Result{Effects: make(map[string]*EffectSet, len(st.effects))}
	for name, eff := range st.effects {
		res.Effects[name] = eff.Clone()
	}
	for _, ds := range st.diags {
		res.Diagnostics = append(res.Diagnostics, ds...)
	}
	sort.Slice(res.Diagnostics, func(i, j int) bool {
		a, b := res.Diagnostics[i], res.Diagnostics[j]
		if a.P.File != b.P.File {
			return a.P.File < b.P.File
		}
		if a.P.Line != b.P.Line {
			return a.P.Line < b.P.Line
		}
		if a.P.Col != b.P.Col {
			return a.P.Col < b.P.Col
		}
		return a.Msg < b.Msg
	})
	return res
}
