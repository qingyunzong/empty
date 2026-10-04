package taint

import (
	"sort"
	"strings"
)

// buildProvenance records, for every taint fact in the fixpoint state,
// the facts it was derived from. Edges point backwards (fact -> causes).
func (r *Result) buildProvenance(g *Graph, ctrlByNode map[string][]string) {
	parents := map[Fact]map[Fact]bool{}
	add := func(f, p Fact) {
		if parents[f] == nil {
			parents[f] = map[Fact]bool{}
		}
		parents[f][p] = true
	}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		for v, ctxs := range r.final[n.ID] {
			for ctx := range ctxs {
				f := Fact{Node: n.ID, Var: v, Ctx: ctx}
				switch n.Kind {
				case KindSource:
					// Root fact: taint originates here.
				case KindAssign:
					for _, u := range n.Uses {
						for _, p := range g.preds[n.ID] {
							if r.final[p][u][ctx] {
								add(f, Fact{Node: p, Var: u, Ctx: ctx})
							}
						}
					}
					for _, b := range ctrlByNode[n.ID] {
						for _, condVar := range g.byID[b].Uses {
							if r.final[b][condVar][ctx] {
								add(f, Fact{Node: b, Var: condVar, Ctx: ctx})
							}
						}
					}
				default:
					// sanitize (context survived), branch, sink, nop, entry, exit
					for _, p := range g.preds[n.ID] {
						if r.final[p][v][ctx] {
							add(f, Fact{Node: p, Var: v, Ctx: ctx})
						}
					}
				}
			}
		}
	}
	r.parents = make(map[Fact][]Fact, len(parents))
	for f, ps := range parents {
		list := make([]Fact, 0, len(ps))
		for p := range ps {
			list = append(list, p)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].String() < list[j].String() })
		r.parents[f] = list
	}
}

// findLeaks enumerates, for every sink and every endangered context,
// each simple provenance path from a source fact to the sink fact.
func (r *Result) findLeaks(g *Graph) {
	sources := map[Fact]bool{}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.Kind != KindSource {
			continue
		}
		for ctx := range r.final[n.ID][n.Var] {
			sources[Fact{Node: n.ID, Var: n.Var, Ctx: ctx}] = true
		}
	}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.Kind != KindSink {
			continue
		}
		ctxs := n.Contexts
		if len(ctxs) == 0 {
			ctxs = g.Contexts
		}
		for _, ctx := range ctxs {
			if !r.final[n.ID][n.Var][ctx] {
				continue
			}
			start := Fact{Node: n.ID, Var: n.Var, Ctx: ctx}
			for _, path := range enumPaths(start, r.parents, sources) {
				r.Leaks = append(r.Leaks, Leak{Sink: n.ID, Var: n.Var, Ctx: ctx, Path: path})
			}
		}
	}
	sort.Slice(r.Leaks, func(i, j int) bool {
		a, b := r.Leaks[i], r.Leaks[j]
		if a.Sink != b.Sink {
			return a.Sink < b.Sink
		}
		if a.Var != b.Var {
			return a.Var < b.Var
		}
		if a.Ctx != b.Ctx {
			return a.Ctx < b.Ctx
		}
		return pathString(a.Path) < pathString(b.Path)
	})
}

// enumPaths returns every simple path (no repeated fact) from a source
// fact to start, walking provenance edges backwards.
func enumPaths(start Fact, parents map[Fact][]Fact, sources map[Fact]bool) [][]Fact {
	var paths [][]Fact
	var trail []Fact
	onPath := map[Fact]bool{}
	var dfs func(f Fact)
	dfs = func(f Fact) {
		trail = append(trail, f)
		defer func() { trail = trail[:len(trail)-1] }()
		if sources[f] {
			rev := make([]Fact, len(trail))
			for i, t := range trail {
				rev[len(trail)-1-i] = t
			}
			paths = append(paths, rev)
			return
		}
		onPath[f] = true
		defer delete(onPath, f)
		for _, p := range parents[f] {
			if !onPath[p] {
				dfs(p)
			}
		}
	}
	dfs(start)
	return paths
}

func pathString(path []Fact) string {
	parts := make([]string, len(path))
	for i, f := range path {
		parts[i] = f.String()
	}
	return strings.Join(parts, " -> ")
}

// PathString renders a leak path as "n1:v[ctx] -> n2:w[ctx] -> ...".
func (l Leak) PathString() string { return pathString(l.Path) }
