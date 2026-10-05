package cfglib

import (
	"fmt"
	"sort"
	"strings"
)

// Analysis holds the dominator analysis of one immutable graph version.
// Nodes unreachable from the entry are excluded from the dominator tree and
// listed separately via Unreachable.
type Analysis struct {
	g           *Graph
	reachable   map[string]bool
	idom        map[string]string
	depth       map[string]int
	doms        map[string]map[string]bool
	df          map[string]map[string]bool
	rpo         []string
	unreachable []string
}

// Analyze computes the dominator analysis of this graph version.
func (g *Graph) Analyze() *Analysis {
	a := &Analysis{
		g:         g,
		reachable: make(map[string]bool),
		depth:     make(map[string]int),
		doms:      make(map[string]map[string]bool),
		df:        make(map[string]map[string]bool),
	}
	a.rpo = reversePostOrder(g)
	for _, n := range a.rpo {
		a.reachable[n] = true
	}
	for _, n := range g.Nodes() {
		if !a.reachable[n] {
			a.unreachable = append(a.unreachable, n)
		}
	}
	a.idom = computeIDom(g, a.rpo)
	for _, n := range a.rpo {
		a.doms[n] = make(map[string]bool)
		d := 0
		for cur := n; ; cur = a.idom[cur] {
			a.doms[n][cur] = true
			if cur == a.idom[cur] {
				break
			}
			d++
		}
		a.depth[n] = d
	}
	a.computeDF()
	return a
}

func reversePostOrder(g *Graph) []string {
	visited := map[string]bool{g.entry: true}
	var post []string
	type item struct {
		node  string
		succs []string
		idx   int
	}
	st := []item{{node: g.entry, succs: g.Successors(g.entry)}}
	for len(st) > 0 {
		f := &st[len(st)-1]
		if f.idx < len(f.succs) {
			s := f.succs[f.idx]
			f.idx++
			if !visited[s] {
				visited[s] = true
				st = append(st, item{node: s, succs: g.Successors(s)})
			}
			continue
		}
		post = append(post, f.node)
		st = st[:len(st)-1]
	}
	for i, j := 0, len(post)-1; i < j; i, j = i+1, j-1 {
		post[i], post[j] = post[j], post[i]
	}
	return post
}

func sortStrings(s []string) { sort.Strings(s) }

// computeIDom runs the Cooper-Harvey-Kennedy iterative algorithm.
func computeIDom(g *Graph, rpo []string) map[string]string {
	pos := make(map[string]int, len(rpo))
	for i, n := range rpo {
		pos[n] = i
	}
	intersect := func(b1, b2 string, idom map[string]string) string {
		f1, f2 := b1, b2
		for f1 != f2 {
			for pos[f1] > pos[f2] {
				f1 = idom[f1]
			}
			for pos[f2] > pos[f1] {
				f2 = idom[f2]
			}
		}
		return f1
	}
	idom := map[string]string{g.entry: g.entry}
	for changed := true; changed; {
		changed = false
		for _, b := range rpo[1:] {
			newIDom := ""
			for _, p := range g.Predecessors(b) {
				if _, ok := idom[p]; !ok {
					continue
				}
				if newIDom == "" {
					newIDom = p
				} else {
					newIDom = intersect(p, newIDom, idom)
				}
			}
			if newIDom != "" && idom[b] != newIDom {
				idom[b] = newIDom
				changed = true
			}
		}
	}
	return idom
}

// computeDF computes dominance frontiers with the Cytron et al. algorithm.
func (a *Analysis) computeDF() {
	for _, b := range a.rpo {
		// The classic ">= 2 predecessors" guard is only an optimization:
		// for a single-predecessor non-entry node the walk below stops
		// immediately because idom[b] is that predecessor. It must not
		// skip the entry, whose idom is itself and which may sit on a
		// cycle (back edges or a self-loop).
		for _, p := range a.g.Predecessors(b) {
			if !a.reachable[p] {
				continue
			}
			for runner := p; runner != a.idom[b]; runner = a.idom[runner] {
				a.addDF(runner, b)
			}
			if b == a.g.entry {
				// The entry is its own idom, so the walk above never
				// reaches it; yet by definition the entry lies in its
				// own frontier whenever it has a reachable predecessor.
				a.addDF(b, b)
			}
		}
	}
}

func (a *Analysis) addDF(x, n string) {
	if a.df[x] == nil {
		a.df[x] = make(map[string]bool)
	}
	a.df[x][n] = true
}

// Unreachable returns the sorted names of nodes not reachable from the entry.
// They take no part in the dominator tree.
func (a *Analysis) Unreachable() []string {
	out := make([]string, len(a.unreachable))
	copy(out, a.unreachable)
	return out
}

// Reachable reports whether n is reachable from the entry.
func (a *Analysis) Reachable(n string) bool { return a.reachable[n] }

// ImmediateDominator returns the immediate dominator of n. The second result
// is false when n is unreachable; for the entry it returns the entry itself.
func (a *Analysis) ImmediateDominator(n string) (string, bool) {
	d, ok := a.idom[n]
	return d, ok
}

// Dominators returns the sorted set of dominators of n, including n itself.
// It returns nil for unreachable nodes.
func (a *Analysis) Dominators(n string) []string {
	set, ok := a.doms[n]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sortStrings(out)
	return out
}

// DominanceFrontier returns the sorted dominance frontier of n, or nil when
// n is unreachable or its frontier is empty.
func (a *Analysis) DominanceFrontier(n string) []string {
	set := a.df[n]
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sortStrings(out)
	return out
}

// NearestCommonDominator returns the nearest common dominator of x and y.
// The second result is false when either node is unreachable.
func (a *Analysis) NearestCommonDominator(x, y string) (string, bool) {
	if !a.reachable[x] || !a.reachable[y] {
		return "", false
	}
	dx, dy := a.depth[x], a.depth[y]
	for dx > dy {
		x = a.idom[x]
		dx--
	}
	for dy > dx {
		y = a.idom[y]
		dy--
	}
	for x != y {
		x = a.idom[x]
		y = a.idom[y]
	}
	return x, true
}

// String dumps the per-node dominator evidence: reachability, immediate
// dominator, full dominator set, and dominance frontier for every node.
func (a *Analysis) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "graph version %d (entry %s)\n", a.g.Version(), a.g.Entry())
	for _, n := range a.g.Nodes() {
		if !a.reachable[n] {
			fmt.Fprintf(&b, "  %s: unreachable\n", n)
			continue
		}
		fmt.Fprintf(&b, "  %s: idom=%s doms={%s} DF={%s}\n",
			n, a.idom[n],
			strings.Join(a.Dominators(n), " "),
			strings.Join(a.DominanceFrontier(n), " "))
	}
	return b.String()
}
