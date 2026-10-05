// Package dom implements a versioned control-flow graph whose entry
// dominator tree is maintained across edge insertions and deletions.
//
// Every mutation commits a new immutable Version; previously returned
// versions stay readable and keep answering queries with their original
// results. Nodes not reachable from the entry are tracked separately and
// excluded from the dominator tree.
package dom

import (
	"fmt"
	"sort"
	"strings"
)

// Graph is a mutable control-flow graph. Mutations append new versions;
// the graph itself is only a builder, all queries go through Version.
type Graph struct {
	entry    string
	nodes    map[string]bool
	edges    map[string]map[string]bool
	versions []*Version
}

// New returns a graph whose only node is the entry.
func New(entry string) *Graph {
	g := &Graph{
		entry: entry,
		nodes: map[string]bool{entry: true},
		edges: map[string]map[string]bool{},
	}
	g.versions = append(g.versions, g.analyze())
	return g
}

// AddNode inserts an (initially unreachable) node and commits a version.
func (g *Graph) AddNode(n string) *Version {
	if !g.nodes[n] {
		g.nodes[n] = true
		g.commit()
	}
	return g.Latest()
}

// AddEdge inserts the edge from->to (creating endpoints if needed) and
// commits a new version. Re-adding an existing edge is a no-op.
func (g *Graph) AddEdge(from, to string) *Version {
	g.nodes[from] = true
	g.nodes[to] = true
	if g.edges[from] == nil {
		g.edges[from] = map[string]bool{}
	}
	if !g.edges[from][to] {
		g.edges[from][to] = true
		g.commit()
	}
	return g.Latest()
}

// RemoveEdge deletes the edge from->to and commits a new version.
// Removing a missing edge is a no-op.
func (g *Graph) RemoveEdge(from, to string) *Version {
	if g.edges[from][to] {
		delete(g.edges[from], to)
		g.commit()
	}
	return g.Latest()
}

func (g *Graph) commit() {
	g.versions = append(g.versions, g.analyze())
}

// Latest returns the most recently committed version.
func (g *Graph) Latest() *Version { return g.versions[len(g.versions)-1] }

// Versions returns every committed version, oldest first.
func (g *Graph) Versions() []*Version {
	return append([]*Version(nil), g.versions...)
}

// Version is an immutable snapshot of the graph together with its
// dominator analysis. All query results are precomputed at commit time,
// so old versions remain readable forever.
type Version struct {
	seq         int
	entry       string
	nodes       []string // sorted, all known nodes
	succ        map[string][]string
	pred        map[string][]string
	reachable   map[string]bool
	unreachable []string // sorted
	idom        map[string]string
	depth       map[string]int
	domSets     map[string]map[string]bool
	children    map[string][]string // dominator-tree children, sorted
	df          map[string]map[string]bool
}

func (g *Graph) analyze() *Version {
	v := &Version{
		seq:       len(g.versions),
		entry:     g.entry,
		succ:      map[string][]string{},
		pred:      map[string][]string{},
		reachable: map[string]bool{},
		idom:      map[string]string{},
		depth:     map[string]int{},
		domSets:   map[string]map[string]bool{},
		children:  map[string][]string{},
		df:        map[string]map[string]bool{},
	}
	for n := range g.nodes {
		v.nodes = append(v.nodes, n)
	}
	sort.Strings(v.nodes)
	for from, tos := range g.edges {
		for to := range tos {
			v.succ[from] = append(v.succ[from], to)
			v.pred[to] = append(v.pred[to], from)
		}
	}
	for n := range g.nodes {
		sort.Strings(v.succ[n])
		sort.Strings(v.pred[n])
	}

	// Reachability from the entry; unreachable nodes are listed separately.
	queue := []string{g.entry}
	v.reachable[g.entry] = true
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		for _, m := range v.succ[n] {
			if !v.reachable[m] {
				v.reachable[m] = true
				queue = append(queue, m)
			}
		}
	}
	for _, n := range v.nodes {
		if !v.reachable[n] {
			v.unreachable = append(v.unreachable, n)
		}
	}

	// Reverse postorder of the reachable region (iterative DFS).
	rpo := reversePostOrder(g.entry, v.succ)
	rpoIndex := make(map[string]int, len(rpo))
	for i, n := range rpo {
		rpoIndex[n] = i
	}

	// Immediate dominators: Cooper-Harvey-Kennedy iterative algorithm.
	v.idom[g.entry] = g.entry
	changed := true
	for changed {
		changed = false
		for _, n := range rpo[1:] {
			newIDom := ""
			set := false
			for _, p := range v.pred[n] {
				if _, ok := v.idom[p]; !ok {
					continue // unreachable or not yet processed
				}
				if !set {
					newIDom, set = p, true
				} else {
					newIDom = intersect(newIDom, p, v.idom, rpoIndex)
				}
			}
			if set && v.idom[n] != newIDom {
				v.idom[n] = newIDom
				changed = true
			}
		}
	}

	// Dominator-tree children, depths, and full dominator sets.
	// In RPO a node's idom always precedes it, so one pass suffices.
	v.depth[g.entry] = 0
	v.domSets[g.entry] = map[string]bool{g.entry: true}
	for _, n := range rpo[1:] {
		p := v.idom[n]
		v.children[p] = append(v.children[p], n)
		v.depth[n] = v.depth[p] + 1
		ds := map[string]bool{n: true}
		for d := range v.domSets[p] {
			ds[d] = true
		}
		v.domSets[n] = ds
	}
	for p := range v.children {
		sort.Strings(v.children[p])
	}

	// Dominance frontier (Cytron et al.): for every edge into n, walk
	// the idom chain up from the predecessor until idom(n). The entry
	// is included because back edges may target it.
	for _, n := range rpo {
		for _, p := range v.reachablePreds(n) {
			for runner := p; runner != v.idom[n]; runner = v.idom[runner] {
				if v.df[runner] == nil {
					v.df[runner] = map[string]bool{}
				}
				v.df[runner][n] = true
			}
		}
	}
	// Back-edge rule: if n dominates a predecessor p of itself (loop
	// headers, self-loops), then n is in its own frontier, because n
	// dominates p without strictly dominating n. The walk above covers
	// this for non-entry nodes; the entry, whose idom is itself, needs
	// it explicitly.
	for _, n := range rpo {
		for _, p := range v.reachablePreds(n) {
			if v.domSets[p][n] {
				if v.df[n] == nil {
					v.df[n] = map[string]bool{}
				}
				v.df[n][n] = true
			}
		}
	}
	return v
}

func reversePostOrder(entry string, succ map[string][]string) []string {
	visited := map[string]bool{entry: true}
	var post []string
	type frame struct {
		node string
		next int
	}
	stack := []frame{{node: entry}}
	for len(stack) > 0 {
		f := &stack[len(stack)-1]
		if f.next < len(succ[f.node]) {
			m := succ[f.node][f.next]
			f.next++
			if !visited[m] {
				visited[m] = true
				stack = append(stack, frame{node: m})
			}
		} else {
			post = append(post, f.node)
			stack = stack[:len(stack)-1]
		}
	}
	for i, j := 0, len(post)-1; i < j; i, j = i+1, j-1 {
		post[i], post[j] = post[j], post[i]
	}
	return post
}

// intersect finds the nearest common dominator of a and b using
// reverse-postorder finger numbers (Cooper-Harvey-Kennedy).
func intersect(a, b string, idom map[string]string, rpoIndex map[string]int) string {
	for a != b {
		for rpoIndex[a] > rpoIndex[b] {
			a = idom[a]
		}
		for rpoIndex[b] > rpoIndex[a] {
			b = idom[b]
		}
	}
	return a
}

func (v *Version) reachablePreds(n string) []string {
	var out []string
	for _, p := range v.pred[n] {
		if v.reachable[p] {
			out = append(out, p)
		}
	}
	return out
}

// Seq returns the commit sequence number (0 for the initial version).
func (v *Version) Seq() int { return v.seq }

// Entry returns the entry node of the graph.
func (v *Version) Entry() string { return v.entry }

// Nodes returns all known node names, sorted.
func (v *Version) Nodes() []string { return append([]string(nil), v.nodes...) }

// Reachable reports whether n is reachable from the entry.
func (v *Version) Reachable(n string) bool { return v.reachable[n] }

// Unreachable returns the sorted names of nodes not reachable from the
// entry. These nodes are excluded from the dominator tree.
func (v *Version) Unreachable() []string {
	return append([]string(nil), v.unreachable...)
}

// Dominators returns the sorted set of nodes dominating n. The second
// result is false when n is unknown or unreachable.
func (v *Version) Dominators(n string) ([]string, bool) {
	ds, ok := v.domSets[n]
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(ds))
	for d := range ds {
		out = append(out, d)
	}
	sort.Strings(out)
	return out, true
}

// Dominates reports whether d dominates n in this version.
func (v *Version) Dominates(d, n string) bool {
	return v.domSets[n][d]
}

// IDom returns the immediate dominator of n. The second result is false
// when n is the entry, unknown, or unreachable.
func (v *Version) IDom(n string) (string, bool) {
	if n == v.entry {
		return "", false
	}
	p, ok := v.idom[n]
	return p, ok
}

// Children returns the sorted dominator-tree children of n.
func (v *Version) Children(n string) []string {
	return append([]string(nil), v.children[n]...)
}

// NCD returns the nearest common dominator of a and b: their lowest
// common ancestor in the dominator tree. The second result is false
// when either node is unknown or unreachable.
func (v *Version) NCD(a, b string) (string, bool) {
	if !v.reachable[a] || !v.reachable[b] {
		return "", false
	}
	for a != b {
		if v.depth[a] < v.depth[b] {
			a, b = b, a
		}
		a = v.idom[a]
	}
	return a, true
}

// DominanceFrontier returns the sorted dominance frontier of n
// (nil when empty).
func (v *Version) DominanceFrontier(n string) []string {
	if len(v.df[n]) == 0 {
		return nil
	}
	out := make([]string, 0, len(v.df[n]))
	for m := range v.df[n] {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// Evidence renders the per-node dominator sets (the proof carried by
// this version) plus the unreachable list, in a stable text form.
func (v *Version) Evidence() string {
	var b strings.Builder
	fmt.Fprintf(&b, "version %d (entry=%s)\n", v.seq, v.entry)
	b.WriteString("dominator sets:\n")
	for _, n := range v.nodes {
		if !v.reachable[n] {
			continue
		}
		ds, _ := v.Dominators(n)
		fmt.Fprintf(&b, "  %s: {%s}\n", n, strings.Join(ds, ", "))
	}
	if len(v.unreachable) > 0 {
		fmt.Fprintf(&b, "unreachable: %s\n", strings.Join(v.unreachable, ", "))
	} else {
		b.WriteString("unreachable: (none)\n")
	}
	return b.String()
}
