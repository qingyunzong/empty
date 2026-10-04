package permset

import (
	"fmt"
	"slices"
	"sort"
)

// CycleError is returned by Define when the new definition would introduce
// a cyclic reference. Chain is the shortest cycle through the defined name,
// e.g. ["A", "B", "C", "A"] means A depends on B, B on C, and C on A.
type CycleError struct {
	Chain []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("cyclic definition rejected: %s", joinChain(e.Chain))
}

func joinChain(chain []string) string {
	out := ""
	for i, s := range chain {
		if i > 0 {
			out += " -> "
		}
		out += s
	}
	return out
}

// UndefinedError is returned when an expression references a name that has
// not been defined.
type UndefinedError struct {
	Name string
}

func (e *UndefinedError) Error() string {
	return fmt.Sprintf("undefined set %q", e.Name)
}

// Version is one immutable version of a named-set definition. Snapshot
// holds the canonical intervals the definition evaluated to at define
// time; it is preserved even after later corrections of this set or its
// dependencies.
type Version struct {
	Num      int
	Expr     string
	Deps     []string
	Snapshot []Interval

	node node
}

type definition struct {
	versions []*Version
}

func (d *definition) latest() *Version { return d.versions[len(d.versions)-1] }

// Registry holds versioned named-set definitions and their cached current
// values. The zero value is not ready for use; call NewRegistry.
type Registry struct {
	defs    map[string]*definition
	current map[string][]Segment

	// EvalCount counts definition-body evaluations (cache misses). It is
	// exported so callers and tests can observe propagation scope; reset
	// it freely.
	EvalCount int
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{
		defs:    make(map[string]*definition),
		current: make(map[string][]Segment),
	}
}

// Define parses expr and installs it as a new version of name. References
// must already be defined. A definition that would create a reference
// cycle is rejected with a *CycleError carrying the shortest chain, and
// the registry is left unchanged. On success the new version is evaluated
// eagerly (its Snapshot is frozen), and only the reverse-dependency
// closure of name is recomputed; unrelated cached values are untouched.
func (r *Registry) Define(name, expr string) (*Version, error) {
	n, err := parse(expr)
	if err != nil {
		return nil, err
	}
	refs := collectRefs(n)
	for _, dep := range refs {
		if r.defs[dep] == nil {
			return nil, &UndefinedError{Name: dep}
		}
	}
	if chain := r.shortestCycle(name, refs); chain != nil {
		return nil, &CycleError{Chain: chain}
	}
	d := r.defs[name]
	if d == nil {
		d = &definition{}
		r.defs[name] = d
	}
	ver := &Version{Num: len(d.versions) + 1, Expr: expr, Deps: refs, node: n}
	d.versions = append(d.versions, ver)

	delete(r.current, name)
	segs, err := r.evalCurrent(name)
	if err != nil {
		return nil, err
	}
	ver.Snapshot = Canonical(segs)

	// Propagate the correction only to the dependency closure.
	closure := r.reverseClosure(name)
	for _, dep := range closure {
		delete(r.current, dep)
	}
	for _, dep := range closure {
		if _, err := r.evalCurrent(dep); err != nil {
			return nil, err
		}
	}
	return ver, nil
}

// shortestCycle returns the shortest chain name -> ... -> name that the
// new edges name -> refs would close, or nil if acyclic. Multi-source BFS
// from all refs over existing dependency edges guarantees minimality.
func (r *Registry) shortestCycle(name string, refs []string) []string {
	prev := map[string]string{}
	visited := map[string]bool{name: true}
	var queue []string
	for _, dep := range refs {
		if dep == name {
			return []string{name, name}
		}
		if !visited[dep] {
			visited[dep] = true
			prev[dep] = name
			queue = append(queue, dep)
		}
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, dep := range r.defs[cur].latest().Deps {
			if dep == name {
				var mid []string
				for x := cur; x != name; x = prev[x] {
					mid = append(mid, x)
				}
				slices.Reverse(mid)
				chain := append([]string{name}, mid...)
				return append(chain, name)
			}
			if !visited[dep] {
				visited[dep] = true
				prev[dep] = cur
				queue = append(queue, dep)
			}
		}
	}
	return nil
}

// reverseClosure returns the sorted set of names that transitively depend
// on name (excluding name itself), based on current versions.
func (r *Registry) reverseClosure(name string) []string {
	rev := map[string][]string{}
	for n, d := range r.defs {
		for _, dep := range d.latest().Deps {
			rev[dep] = append(rev[dep], n)
		}
	}
	visited := map[string]bool{name: true}
	queue := []string{name}
	var out []string
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, nxt := range rev[cur] {
			if !visited[nxt] {
				visited[nxt] = true
				out = append(out, nxt)
				queue = append(queue, nxt)
			}
		}
	}
	sort.Strings(out)
	return out
}

// evalCurrent returns the cached current value of name, evaluating and
// caching it on a miss. Cycles are impossible because Define rejects them.
func (r *Registry) evalCurrent(name string) ([]Segment, error) {
	if segs, ok := r.current[name]; ok {
		return segs, nil
	}
	d := r.defs[name]
	if d == nil {
		return nil, &UndefinedError{Name: name}
	}
	r.EvalCount++
	segs, err := r.evalNodeWith(r.evalCurrent, d.latest().node)
	if err != nil {
		return nil, err
	}
	r.current[name] = segs
	return segs, nil
}

// evalNodeWith evaluates an AST, resolving references through resolve.
func (r *Registry) evalNodeWith(resolve func(string) ([]Segment, error), n node) ([]Segment, error) {
	switch n := n.(type) {
	case lit:
		return []Segment{{
			Interval: Interval{Lo: n.lo, Hi: n.hi},
			Sources:  []string{fmt.Sprintf("[%d,%d]", n.lo, n.hi)},
		}}, nil
	case ref:
		segs, err := resolve(n.name)
		if err != nil {
			return nil, err
		}
		out := make([]Segment, len(segs))
		for i, s := range segs {
			out[i] = Segment{Interval: s.Interval, Sources: addSource(s.Sources, n.name)}
		}
		return out, nil
	case bin:
		l, err := r.evalNodeWith(resolve, n.l)
		if err != nil {
			return nil, err
		}
		rhs, err := r.evalNodeWith(resolve, n.r)
		if err != nil {
			return nil, err
		}
		switch n.op {
		case '|':
			return combine(l, rhs, opUnion), nil
		case '&':
			return combine(l, rhs, opInter), nil
		case '-':
			return combine(l, rhs, opSub), nil
		}
	}
	return nil, fmt.Errorf("permset: unknown AST node %T", n)
}

// Eval returns the canonical current intervals of a named set.
func (r *Registry) Eval(name string) ([]Interval, error) {
	segs, err := r.evalCurrent(name)
	if err != nil {
		return nil, err
	}
	return Canonical(segs), nil
}

// EvalSegments returns the current value of a named set as provenance
// segments: each disjoint segment carries the sorted source expressions
// (named-set references and interval literals) that witness it.
func (r *Registry) EvalSegments(name string) ([]Segment, error) {
	segs, err := r.evalCurrent(name)
	if err != nil {
		return nil, err
	}
	return slices.Clone(segs), nil
}

// EvalExpr evaluates an anonymous expression against the registry's named
// sets and returns canonical intervals.
func (r *Registry) EvalExpr(expr string) ([]Interval, error) {
	segs, err := r.EvalExprSegments(expr)
	if err != nil {
		return nil, err
	}
	return Canonical(segs), nil
}

// EvalExprSegments evaluates an anonymous expression and returns
// provenance segments.
func (r *Registry) EvalExprSegments(expr string) ([]Segment, error) {
	n, err := parse(expr)
	if err != nil {
		return nil, err
	}
	for _, dep := range collectRefs(n) {
		if r.defs[dep] == nil {
			return nil, &UndefinedError{Name: dep}
		}
	}
	return r.evalNodeWith(r.evalCurrent, n)
}

// EvalExpr evaluates a name-free expression and returns canonical
// intervals.
func EvalExpr(expr string) ([]Interval, error) {
	return NewRegistry().EvalExpr(expr)
}

// Versions returns the version history of name, oldest first.
func (r *Registry) Versions(name string) []Version {
	d := r.defs[name]
	if d == nil {
		return nil
	}
	out := make([]Version, len(d.versions))
	for i, v := range d.versions {
		out[i] = *v
	}
	return out
}

// Snapshot returns the frozen canonical intervals of a specific version.
func (r *Registry) Snapshot(name string, num int) ([]Interval, error) {
	d := r.defs[name]
	if d == nil || num < 1 || num > len(d.versions) {
		return nil, fmt.Errorf("permset: no version %d of %q", num, name)
	}
	return slices.Clone(d.versions[num-1].Snapshot), nil
}

// Verify performs a full from-scratch recomputation of every named set,
// bypassing all caches, and cross-checks the results against the
// incrementally maintained current values. It returns the sorted names of
// any mismatches; an empty result means the incremental state is exact.
func (r *Registry) Verify() []string {
	fresh := map[string][]Segment{}
	var evalFresh func(name string) ([]Segment, error)
	evalFresh = func(name string) ([]Segment, error) {
		if segs, ok := fresh[name]; ok {
			return segs, nil
		}
		d := r.defs[name]
		if d == nil {
			return nil, &UndefinedError{Name: name}
		}
		segs, err := r.evalNodeWith(evalFresh, d.latest().node)
		if err != nil {
			return nil, err
		}
		fresh[name] = segs
		return segs, nil
	}
	var bad []string
	for name := range r.defs {
		fv, err := evalFresh(name)
		if err != nil {
			bad = append(bad, name)
			continue
		}
		cv, err := r.evalCurrent(name)
		if err != nil || !slices.Equal(Canonical(fv), Canonical(cv)) {
			bad = append(bad, name)
		}
	}
	sort.Strings(bad)
	return bad
}
