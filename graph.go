package dagmetrics

import (
	"fmt"
	"sort"
)

type node struct {
	name       string
	source     bool  // true: raw input; false: derived metric
	expr       *Expr // derived nodes only
	deps       []string
	dependents []string
	value      int64
	// version at which value last changed (0 = never published)
	version int64
}

// Batch records one atomic publication: the new version, the nodes that were
// recomputed, and the nodes whose published value actually changed.
type Batch struct {
	Version    int64
	Recomputed []string // topological order
	Changed    []string // subset of Recomputed whose value differs
}

// Graph is a versioned DAG of metrics.
type Graph struct {
	nodes   map[string]*node
	order   []string // topological order, sources first
	version int64
	batches []Batch
}

// NewGraph builds a graph. sources lists raw input names; derived maps metric
// names to their expressions. Derived metrics may reference sources or other
// derived metrics; references must be acyclic.
func NewGraph(sources []string, derived map[string]*Expr) (*Graph, error) {
	g := &Graph{nodes: make(map[string]*node)}
	for _, s := range sources {
		if _, dup := g.nodes[s]; dup {
			return nil, fmt.Errorf("duplicate metric %q", s)
		}
		g.nodes[s] = &node{name: s, source: true}
	}
	for name, e := range derived {
		if _, dup := g.nodes[name]; dup {
			return nil, fmt.Errorf("duplicate metric %q", name)
		}
		set := map[string]bool{}
		e.refs(set)
		deps := make([]string, 0, len(set))
		for d := range set {
			deps = append(deps, d)
		}
		sort.Strings(deps)
		g.nodes[name] = &node{name: name, expr: e, deps: deps}
	}
	for _, n := range g.nodes {
		for _, d := range n.deps {
			dep, ok := g.nodes[d]
			if !ok {
				return nil, fmt.Errorf("metric %q references unknown %q", n.name, d)
			}
			dep.dependents = append(dep.dependents, n.name)
		}
	}
	order, err := topoSort(g.nodes)
	if err != nil {
		return nil, err
	}
	g.order = order
	// Publish the initial state (all sources zero) so every derived metric
	// holds a consistent value from the start.
	env := make(map[string]int64, len(g.nodes))
	for _, name := range g.order {
		n := g.nodes[name]
		if n.source {
			env[name] = n.value
			continue
		}
		v, err := n.expr.eval(env)
		if err != nil {
			return nil, err
		}
		n.value = v
		env[name] = v
	}
	return g, nil
}

func topoSort(nodes map[string]*node) ([]string, error) {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(nodes))
	var order []string
	var visit func(name string) error
	visit = func(name string) error {
		switch color[name] {
		case gray:
			return fmt.Errorf("cycle detected at %q", name)
		case black:
			return nil
		}
		color[name] = gray
		for _, d := range nodes[name].deps {
			if err := visit(d); err != nil {
				return err
			}
		}
		color[name] = black
		order = append(order, name)
		return nil
	}
	names := make([]string, 0, len(nodes))
	for n := range nodes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := visit(n); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// Version returns the current published version.
func (g *Graph) Version() int64 { return g.version }

// Value returns the current value of a metric and the version at which it
// last changed.
func (g *Graph) Value(name string) (int64, int64, error) {
	n, ok := g.nodes[name]
	if !ok {
		return 0, 0, fmt.Errorf("unknown metric %q", name)
	}
	return n.value, n.version, nil
}

// Batches returns the recorded publication history.
func (g *Graph) Batches() []Batch {
	out := make([]Batch, len(g.batches))
	copy(out, g.batches)
	return out
}

// Update atomically applies corrections to one or more sources and publishes
// the result under a single new version. Only the dependents of sources whose
// value actually changed are recomputed, and recomputation stops propagating
// along any edge where the value did not change (early cutoff).
func (g *Graph) Update(corrections map[string]int64) (Batch, error) {
	for name := range corrections {
		n, ok := g.nodes[name]
		if !ok {
			return Batch{}, fmt.Errorf("unknown metric %q", name)
		}
		if !n.source {
			return Batch{}, fmt.Errorf("metric %q is derived, not a source", name)
		}
	}
	g.version++
	batch := Batch{Version: g.version}

	changed := make(map[string]bool, len(corrections))
	for name, v := range corrections {
		n := g.nodes[name]
		if n.value != v {
			n.value = v
			n.version = g.version
			changed[name] = true
			batch.Changed = append(batch.Changed, name)
		}
	}

	// Walk in topological order; a derived node is recomputed only if at
	// least one of its dependencies changed value in this batch.
	for _, name := range g.order {
		n := g.nodes[name]
		if n.source {
			continue
		}
		dirty := false
		for _, d := range n.deps {
			if changed[d] {
				dirty = true
				break
			}
		}
		if !dirty {
			continue
		}
		env := make(map[string]int64, len(n.deps))
		for _, d := range n.deps {
			env[d] = g.nodes[d].value
		}
		v, err := n.expr.eval(env)
		if err != nil {
			return Batch{}, err
		}
		batch.Recomputed = append(batch.Recomputed, name)
		if n.value != v {
			n.value = v
			n.version = g.version
			changed[name] = true
			batch.Changed = append(batch.Changed, name)
		}
	}
	sort.Strings(batch.Changed)
	g.batches = append(g.batches, batch)
	return batch, nil
}

// EvaluateAll recomputes every derived metric from the current source values
// and returns a full snapshot. It does not mutate the graph; tests use it to
// cross-check incremental results.
func (g *Graph) EvaluateAll() (map[string]int64, error) {
	env := make(map[string]int64, len(g.nodes))
	for _, name := range g.order {
		n := g.nodes[name]
		if n.source {
			env[name] = n.value
			continue
		}
		v, err := n.expr.eval(env)
		if err != nil {
			return nil, err
		}
		env[name] = v
	}
	return env, nil
}

// Snapshot returns the currently published values of all metrics.
func (g *Graph) Snapshot() map[string]int64 {
	out := make(map[string]int64, len(g.nodes))
	for name, n := range g.nodes {
		out[name] = n.value
	}
	return out
}
