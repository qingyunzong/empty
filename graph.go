// Package dagcalc evaluates derived metrics organized as a DAG.
// Metrics are integer expressions (add/sub/mul and conditionals) over
// source inputs and other metrics. Input corrections are applied in
// batches: each Commit republishes all affected values atomically
// under a new version, recomputing only the closure of metrics whose
// active dependencies actually changed.
package dagcalc

import (
	"fmt"
	"sort"
	"sync"
)

// CommitRecord describes one committed batch of input updates.
type CommitRecord struct {
	Version       uint64   // version published by this commit
	ChangedInputs []string // inputs whose value actually changed, sorted
	Recomputed    []string // metrics recomputed in this commit, sorted
}

// MetricInfo is a point-in-time description of a metric.
type MetricInfo struct {
	Name    string
	Value   int64
	Version uint64   // version at which the metric was last recomputed
	Deps    []string // active dependencies from the last evaluation, sorted
}

type metric struct {
	expr    Expr
	value   int64
	version uint64
	deps    map[string]bool
}

// Graph is a versioned DAG of derived metrics over named inputs.
// It is safe for concurrent use.
type Graph struct {
	mu      sync.RWMutex
	inputs  map[string]int64
	metrics map[string]*metric
	order   []string // cached topological order, nil when dirty
	version uint64
	history []CommitRecord
}

// New returns an empty graph.
func New() *Graph {
	return &Graph{
		inputs:  make(map[string]int64),
		metrics: make(map[string]*metric),
	}
}

// AddMetric registers a derived metric. References to names that are
// neither metrics nor committed inputs resolve to implicit zero inputs.
func (g *Graph) AddMetric(name string, expr Expr) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.metrics[name]; ok {
		return fmt.Errorf("dagcalc: metric %q already exists", name)
	}
	if _, ok := g.inputs[name]; ok {
		return fmt.Errorf("dagcalc: %q is already an input", name)
	}
	g.metrics[name] = &metric{expr: expr}
	g.order = nil
	return nil
}

// Commit applies a batch of input updates and publishes the resulting
// metric values atomically under a new version. Only metrics whose
// active dependencies actually changed value are recomputed; if a
// recomputed metric keeps its previous value, its own dependents are
// left untouched. Updates naming a metric are rejected.
func (g *Graph) Commit(updates map[string]int64) (CommitRecord, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	for name := range updates {
		if _, ok := g.metrics[name]; ok {
			return CommitRecord{}, fmt.Errorf("dagcalc: cannot update metric %q", name)
		}
	}
	if g.order == nil {
		order, err := g.topoOrder()
		if err != nil {
			return CommitRecord{}, err
		}
		g.order = order
	}

	g.version++
	rec := CommitRecord{Version: g.version}
	changed := make(map[string]bool)
	for name, v := range updates {
		if old, ok := g.inputs[name]; !ok || old != v {
			g.inputs[name] = v
			changed[name] = true
			rec.ChangedInputs = append(rec.ChangedInputs, name)
		}
	}
	sort.Strings(rec.ChangedInputs)

	env := make(map[string]int64, len(g.inputs)+len(g.metrics))
	for name, v := range g.inputs {
		env[name] = v
	}
	for name, m := range g.metrics {
		env[name] = m.value
	}

	initial := g.version == 1
	for _, name := range g.order {
		m := g.metrics[name]
		dirty := initial
		if !dirty {
			for dep := range m.deps {
				if changed[dep] {
					dirty = true
					break
				}
			}
		}
		if !dirty {
			continue
		}
		used := make(map[string]bool)
		v := m.expr.eval(env, used)
		m.deps = used
		m.version = g.version
		rec.Recomputed = append(rec.Recomputed, name)
		if v != m.value || initial {
			m.value = v
			env[name] = v
			changed[name] = true
		}
	}
	sort.Strings(rec.Recomputed)
	g.history = append(g.history, rec)
	return rec, nil
}

// FullEvaluate recomputes every metric from scratch using the current
// inputs, without mutating the graph. It is the reference against
// which incremental commits can be verified.
func (g *Graph) FullEvaluate() (map[string]int64, error) {
	g.mu.RLock()
	order := g.order
	g.mu.RUnlock()
	if order == nil {
		var err error
		order, err = g.topoOrder()
		if err != nil {
			return nil, err
		}
	}

	g.mu.RLock()
	defer g.mu.RUnlock()
	env := make(map[string]int64, len(g.inputs)+len(g.metrics))
	for name, v := range g.inputs {
		env[name] = v
	}
	out := make(map[string]int64, len(g.metrics))
	for _, name := range order {
		v := g.metrics[name].expr.eval(env, nil)
		env[name] = v
		out[name] = v
	}
	return out, nil
}

// Version returns the version of the latest committed batch.
func (g *Graph) Version() uint64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.version
}

// Get returns the current value of a metric or input.
func (g *Graph) Get(name string) (int64, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if m, ok := g.metrics[name]; ok {
		return m.value, true
	}
	v, ok := g.inputs[name]
	return v, ok
}

// Snapshot atomically returns the current version and all metric
// values published under it.
func (g *Graph) Snapshot() (uint64, map[string]int64) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	values := make(map[string]int64, len(g.metrics))
	for name, m := range g.metrics {
		values[name] = m.value
	}
	return g.version, values
}

// MetricInfo returns the current state of a metric.
func (g *Graph) MetricInfo(name string) (MetricInfo, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	m, ok := g.metrics[name]
	if !ok {
		return MetricInfo{}, false
	}
	deps := make([]string, 0, len(m.deps))
	for d := range m.deps {
		deps = append(deps, d)
	}
	sort.Strings(deps)
	return MetricInfo{Name: name, Value: m.value, Version: m.version, Deps: deps}, true
}

// History returns the records of all committed batches.
func (g *Graph) History() []CommitRecord {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]CommitRecord, len(g.history))
	copy(out, g.history)
	return out
}

// topoOrder returns metric names sorted so that every metric appears
// after the metrics it statically references.
func (g *Graph) topoOrder() ([]string, error) {
	const (
		white = iota
		gray
		black
	)
	color := make(map[string]int, len(g.metrics))
	order := make([]string, 0, len(g.metrics))
	var visit func(name string) error
	visit = func(name string) error {
		switch color[name] {
		case gray:
			return fmt.Errorf("dagcalc: cycle detected at metric %q", name)
		case black:
			return nil
		}
		color[name] = gray
		deps := make(map[string]bool)
		g.metrics[name].expr.staticDeps(deps)
		for dep := range deps {
			if _, ok := g.metrics[dep]; ok {
				if err := visit(dep); err != nil {
					return err
				}
			}
		}
		color[name] = black
		order = append(order, name)
		return nil
	}
	for name := range g.metrics {
		if err := visit(name); err != nil {
			return nil, err
		}
	}
	return order, nil
}
