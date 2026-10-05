package taint

import (
	"fmt"
	"sort"
	"strings"
)

// CtxSet is the set of contexts in which a value is tainted.
type CtxSet map[string]bool

func (c CtxSet) clone() CtxSet {
	n := make(CtxSet, len(c))
	for k, v := range c {
		n[k] = v
	}
	return n
}

func (c CtxSet) union(o CtxSet) CtxSet {
	n := c.clone()
	for k, v := range o {
		n[k] = n[k] || v
	}
	return n
}

func (c CtxSet) minus(contexts []string) CtxSet {
	n := c.clone()
	for _, ctx := range contexts {
		delete(n, ctx)
	}
	return n
}

func (c CtxSet) equal(o CtxSet) bool {
	if len(c) != len(o) {
		return false
	}
	for k, v := range c {
		if o[k] != v {
			return false
		}
	}
	return true
}

func (c CtxSet) String() string {
	var xs []string
	for k, v := range c {
		if v {
			xs = append(xs, k)
		}
	}
	sort.Strings(xs)
	return "{" + strings.Join(xs, ",") + "}"
}

// State is the abstract taint state at a program point: per-variable taint
// plus the implicit taint inherited from enclosing branch conditions.
type State struct {
	Vars     map[string]CtxSet
	Implicit CtxSet
}

func newState() *State { return &State{Vars: map[string]CtxSet{}, Implicit: CtxSet{}} }

func (s *State) clone() *State {
	n := &State{Vars: make(map[string]CtxSet, len(s.Vars)), Implicit: s.Implicit.clone()}
	for k, v := range s.Vars {
		n.Vars[k] = v.clone()
	}
	return n
}

// join computes the least upper bound (pointwise union).
func join(a, b *State) *State {
	n := &State{Vars: map[string]CtxSet{}, Implicit: a.Implicit.union(b.Implicit)}
	for k, v := range a.Vars {
		n.Vars[k] = v.clone()
	}
	for k, v := range b.Vars {
		if cur, ok := n.Vars[k]; ok {
			n.Vars[k] = cur.union(v)
		} else {
			n.Vars[k] = v.clone()
		}
	}
	return n
}

func (s *State) equal(o *State) bool {
	if !s.Implicit.equal(o.Implicit) || len(s.Vars) != len(o.Vars) {
		return false
	}
	for k, v := range s.Vars {
		w, ok := o.Vars[k]
		if !ok || !v.equal(w) {
			return false
		}
	}
	return true
}

func (s *State) String() string {
	var parts []string
	for k, v := range s.Vars {
		parts = append(parts, fmt.Sprintf("%s:%s", k, v))
	}
	sort.Strings(parts)
	return fmt.Sprintf("implicit=%s vars=[%s]", s.Implicit, strings.Join(parts, " "))
}

// Leak is a sink reached by tainted data in the sink's context.
type Leak struct {
	SinkID  string
	Context string
	Vars    []string // sink arguments carrying the taint
	ViaCond bool     // taint arrives (also) via a branch condition
}

// LeakPath is one concrete path through the expanded graph that leaks.
type LeakPath struct {
	Leak
	Nodes  []string // node ids entry -> sink
	Events []string // human-readable taint events along the path
}

func (lp LeakPath) String() string {
	return fmt.Sprintf("sink %s (context %s, vars %s): %s",
		lp.SinkID, lp.Context, strings.Join(lp.Vars, ","), strings.Join(lp.Nodes, " -> "))
}

// Analyzer runs the fixed-point taint analysis.
type Analyzer struct {
	prog     *Program
	universe []string
	full     CtxSet
	In       map[string]*State
	Out      map[string]*State
}

// NewAnalyzer prepares an analyzer for p.
func NewAnalyzer(p *Program) *Analyzer {
	a := &Analyzer{prog: p, universe: p.universe(), full: CtxSet{}}
	for _, c := range a.universe {
		a.full[c] = true
	}
	return a
}

func (a *Analyzer) taintOf(s *State, vars []string) CtxSet {
	t := CtxSet{}
	for _, v := range vars {
		if c, ok := s.Vars[v]; ok {
			t = t.union(c)
		}
	}
	return t
}

// transfer applies the effect of n to state in, returning a new state.
func (a *Analyzer) transfer(n *Node, in *State) *State {
	out := in.clone()
	switch n.Kind {
	case KindSource:
		out.Vars[n.Var] = a.full.clone()
	case KindAssign:
		out.Vars[n.Var] = a.taintOf(in, n.Uses).union(in.Implicit)
	case KindSanitize:
		t := a.taintOf(in, []string{n.Arg}).union(in.Implicit)
		out.Vars[n.Var] = t.minus(n.Contexts)
	case KindBranch:
		out.Implicit = in.Implicit.union(a.taintOf(in, n.Uses))
	case KindSink:
		// sinks observe state but do not modify it
	}
	return out
}

// leakAt reports whether the sink node leaks under the given entry state.
func (a *Analyzer) leakAt(n *Node, in *State) (Leak, bool) {
	t := a.taintOf(in, n.Args)
	explicit := t[n.Context]
	implicit := in.Implicit[n.Context]
	if !explicit && !implicit {
		return Leak{}, false
	}
	var vars []string
	for _, v := range n.Args {
		if c, ok := in.Vars[v]; ok && c[n.Context] {
			vars = append(vars, v)
		}
	}
	sort.Strings(vars)
	return Leak{SinkID: n.ID, Context: n.Context, Vars: vars, ViaCond: implicit}, true
}

// Run iterates the dataflow equations to the least fixed point.
// Termination is guaranteed: states form a finite lattice (finite variables
// x finite context universe) and transfer functions are monotone.
func (a *Analyzer) Run() {
	a.In = map[string]*State{}
	a.Out = map[string]*State{}
	for _, id := range a.prog.IDs() {
		a.In[id] = newState()
		a.Out[id] = newState()
	}
	var work []string
	inWork := map[string]bool{}
	for _, id := range a.prog.IDs() {
		work = append(work, id)
		inWork[id] = true
	}
	for len(work) > 0 {
		id := work[0]
		work = work[1:]
		delete(inWork, id)
		in := newState()
		for _, p := range a.prog.Pred(id) {
			in = join(in, a.Out[p])
		}
		a.In[id] = in
		out := a.transfer(a.prog.Node(id), in)
		if !out.equal(a.Out[id]) {
			a.Out[id] = out
			for _, s := range a.prog.Succ(id) {
				if !inWork[s] {
					work = append(work, s)
					inWork[s] = true
				}
			}
		}
	}
}

// Leaks returns every sink that leaks at the fixed point.
func (a *Analyzer) Leaks() []Leak {
	var leaks []Leak
	for _, id := range a.prog.IDs() {
		n := a.prog.Node(id)
		if n.Kind != KindSink {
			continue
		}
		if l, ok := a.leakAt(n, a.In[id]); ok {
			leaks = append(leaks, l)
		}
	}
	return leaks
}

// ExpandPaths enumerates concrete execution paths from the entry to every
// leaking sink by unrolling the CFG: each node may be visited at most
// maxVisit times per path, so loops are expanded a bounded number of times.
// Taint state is replayed along each path, and every path whose replayed
// state leaks at the sink is returned.
func (a *Analyzer) ExpandPaths(maxVisit int) []LeakPath {
	if maxVisit < 1 {
		maxVisit = 1
	}
	var paths []LeakPath
	var walk func(id string, in *State, nodes, events []string, visits map[string]int)
	walk = func(id string, in *State, nodes, events []string, visits map[string]int) {
		if visits[id] >= maxVisit {
			return
		}
		n := a.prog.Node(id)
		visits = maps(visits)
		visits[id]++
		nodes = append(append([]string{}, nodes...), id)
		events = append([]string{}, events...)
		out := a.transfer(n, in)
		switch n.Kind {
		case KindSource:
			events = append(events, fmt.Sprintf("%s: source taints %s in all contexts", id, n.Var))
		case KindAssign:
			if t := out.Vars[n.Var]; len(t) > 0 {
				events = append(events, fmt.Sprintf("%s: %s tainted %s via data flow", id, n.Var, t))
			}
		case KindSanitize:
			events = append(events, fmt.Sprintf("%s: sanitize(%s) clears contexts [%s], residual %s",
				id, n.Arg, strings.Join(n.Contexts, ","), out.Vars[n.Var]))
		case KindBranch:
			if t := a.taintOf(in, n.Uses); len(t) > 0 {
				events = append(events, fmt.Sprintf("%s: branch condition tainted %s (implicit flow)", id, t))
			}
		case KindSink:
			if l, ok := a.leakAt(n, in); ok {
				paths = append(paths, LeakPath{Leak: l, Nodes: nodes, Events: events})
			}
		}
		for _, s := range a.prog.Succ(id) {
			walk(s, out, nodes, events, visits)
		}
	}
	walk(a.prog.Entry, newState(), nil, nil, map[string]int{})
	return paths
}

func maps(m map[string]int) map[string]int {
	n := make(map[string]int, len(m)+1)
	for k, v := range m {
		n[k] = v
	}
	return n
}
