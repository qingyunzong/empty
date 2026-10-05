package permset

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Def is one version of a named definition.
type Def struct {
	Name    string   // definition name
	Expr    string   // source expression text
	Version int      // 1-based, bumped on every (re)computation
	Value   Set      // canonical evaluated value
	Wit     WSet     // witnessed value (per-segment provenance)
	Refs    []string // direct dependencies, sorted

	node node // parsed AST of Expr
}

// CycleError reports a rejected definition that would close a reference
// cycle. Chain is the shortest cycle found, with Chain[0] == Chain[last].
type CycleError struct{ Chain []string }

func (e *CycleError) Error() string {
	return "circular definition rejected: " + strings.Join(e.Chain, " -> ")
}

// Env holds versioned named set definitions and their dependency graph.
type Env struct {
	defs       map[string]*Def
	hist       map[string][]Def
	dependents map[string]map[string]bool
}

// NewEnv returns an empty definition environment.
func NewEnv() *Env {
	return &Env{
		defs:       map[string]*Def{},
		hist:       map[string][]Def{},
		dependents: map[string]map[string]bool{},
	}
}

func validName(s string) bool {
	if s == "" || s == "min" || s == "max" || !isAlpha(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		if !isAlpha(s[i]) && !isDigit(s[i]) {
			return false
		}
	}
	return true
}

// Define parses expr and installs it as the next version of name. It
// returns the names of dependent definitions that were recomputed as a
// consequence (the transitive dependent closure, in evaluation order).
//
// The definition is rejected with *Error on a syntax problem, with
// *UndefinedError on unknown references, and with *CycleError (carrying
// the shortest reference chain) if it would close a cycle. On rejection
// the environment is left unchanged.
func (e *Env) Define(name, expr string) ([]string, error) {
	if !validName(name) {
		return nil, fmt.Errorf("invalid set name %q", name)
	}
	n, refs, err := parse(expr)
	if err != nil {
		return nil, err
	}
	for _, r := range refs {
		if _, ok := e.defs[r]; !ok && r != name {
			return nil, &UndefinedError{Name: r}
		}
	}
	if chain := shortestCycle(e.defs, name, refs); chain != nil {
		return nil, &CycleError{Chain: chain}
	}
	wit, err := evalNode(n, e.resolve)
	if err != nil {
		return nil, err
	}
	version := 1
	if old, ok := e.defs[name]; ok {
		version = old.Version + 1
		for _, r := range old.Refs {
			delete(e.dependents[r], name)
		}
	}
	d := &Def{Name: name, Expr: expr, Version: version, Value: wit.Set(), Wit: wit, Refs: refs, node: n}
	for _, r := range refs {
		if e.dependents[r] == nil {
			e.dependents[r] = map[string]bool{}
		}
		e.dependents[r][name] = true
	}
	e.defs[name] = d
	e.hist[name] = append(e.hist[name], *d)
	return e.propagate(name), nil
}

// propagate recomputes the transitive dependent closure of name, layer by
// layer so that every definition is re-evaluated only after its own
// dependencies. Each recomputed definition gets a new version; its
// previous version stays in the history as an immutable snapshot.
func (e *Env) propagate(name string) []string {
	seen := map[string]bool{name: true}
	frontier := []string{name}
	var order []string
	for len(frontier) > 0 {
		var next []string
		for _, x := range frontier {
			for dep := range e.dependents[x] {
				if !seen[dep] {
					seen[dep] = true
					next = append(next, dep)
				}
			}
		}
		slices.Sort(next)
		order = append(order, next...)
		frontier = next
	}
	for _, dep := range order {
		d := e.defs[dep]
		wit, err := evalNode(d.node, e.resolve)
		if err != nil { // unreachable: graph is acyclic and refs exist
			panic(fmt.Sprintf("permset: propagate %q: %v", dep, err))
		}
		d.Version++
		d.Value = wit.Set()
		d.Wit = wit
		e.hist[dep] = append(e.hist[dep], *d)
	}
	return order
}

// shortestCycle returns the shortest reference chain from name back to
// name after tentatively adding edges name -> refs, or nil if the graph
// stays acyclic. BFS over existing definitions guarantees the chain is
// the shortest one.
func shortestCycle(defs map[string]*Def, name string, refs []string) []string {
	prev := map[string]string{}
	queue := make([]string, 0, len(refs))
	for _, r := range refs {
		if _, ok := prev[r]; !ok {
			prev[r] = name
			queue = append(queue, r)
		}
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == name {
			if prev[name] == name {
				return []string{name, name}
			}
			var rev []string
			for at := prev[name]; at != name; at = prev[at] {
				rev = append(rev, at)
			}
			slices.Reverse(rev)
			return append(append([]string{name}, rev...), name)
		}
		d, ok := defs[cur]
		if !ok {
			continue
		}
		for _, r := range d.Refs {
			if _, seen := prev[r]; !seen {
				prev[r] = cur
				queue = append(queue, r)
			}
		}
	}
	return nil
}

// resolve looks up a name for evaluation, labeling every segment of the
// referenced value with the name itself as provenance.
func (e *Env) resolve(name string) (WSet, error) {
	d, ok := e.defs[name]
	if !ok {
		return WSet{}, &UndefinedError{Name: name}
	}
	raw := make([]Segment, len(d.Wit.segs))
	for i, s := range d.Wit.segs {
		raw[i] = Segment{Lo: s.Lo, Hi: s.Hi, Sources: []string{name}}
	}
	return WSet{segs: canonSegs(raw)}, nil
}

// Eval parses and evaluates an expression in this environment, returning
// the witnessed result: each segment carries the source expressions that
// produced it.
func (e *Env) Eval(src string) (WSet, error) {
	n, refs, err := parse(src)
	if err != nil {
		return WSet{}, err
	}
	for _, r := range refs {
		if _, ok := e.defs[r]; !ok {
			return WSet{}, &UndefinedError{Name: r}
		}
	}
	return evalNode(n, e.resolve)
}

// Get returns the latest version of a definition.
func (e *Env) Get(name string) (Def, bool) {
	d, ok := e.defs[name]
	if !ok {
		return Def{}, false
	}
	return *d, true
}

// Snapshot returns the preserved historical version of a definition.
func (e *Env) Snapshot(name string, version int) (Def, bool) {
	for _, d := range e.hist[name] {
		if d.Version == version {
			return d, true
		}
	}
	return Def{}, false
}

// Versions returns every preserved version of a definition, oldest first.
func (e *Env) Versions(name string) []Def {
	return slices.Clone(e.hist[name])
}

// Verify recomputes every definition from scratch in topological order
// and compares the fresh values and witnesses against the cached ones.
// It returns nil when the incrementally maintained state matches a full
// recomputation.
func (e *Env) Verify() error {
	names := make([]string, 0, len(e.defs))
	for name := range e.defs {
		names = append(names, name)
	}
	slices.Sort(names)
	state := map[string]int{}
	var order []string
	var visit func(n string)
	visit = func(n string) {
		if state[n] != 0 {
			return
		}
		state[n] = 1
		for _, r := range e.defs[n].Refs {
			visit(r)
		}
		state[n] = 2
		order = append(order, n)
	}
	for _, n := range names {
		visit(n)
	}
	vals := map[string]WSet{}
	var errs []string
	for _, n := range order {
		d := e.defs[n]
		w, err := evalNode(d.node, func(name string) (WSet, error) {
			vw, ok := vals[name]
			if !ok {
				return WSet{}, &UndefinedError{Name: name}
			}
			raw := make([]Segment, len(vw.segs))
			for i, s := range vw.segs {
				raw[i] = Segment{Lo: s.Lo, Hi: s.Hi, Sources: []string{name}}
			}
			return WSet{segs: canonSegs(raw)}, nil
		})
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", n, err))
			continue
		}
		vals[n] = w
		if !w.Set().Equal(d.Value) || !equalWSets(w, d.Wit) {
			errs = append(errs, fmt.Sprintf("definition %q (version %d) diverges from full recomputation", n, d.Version))
		}
	}
	if len(errs) > 0 {
		return errors.New("permset: verify failed: " + strings.Join(errs, "; "))
	}
	return nil
}

func equalWSets(a, b WSet) bool {
	return slices.EqualFunc(a.segs, b.segs, func(x, y Segment) bool {
		return x.Lo == y.Lo && x.Hi == y.Hi && slices.Equal(x.Sources, y.Sources)
	})
}
