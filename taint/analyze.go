package taint

import "sort"

// Fact is a single taint fact: variable Var at node Node carries taint
// for context Ctx.
type Fact struct {
	Node string `json:"node"`
	Var  string `json:"var"`
	Ctx  string `json:"ctx"`
}

func (f Fact) String() string { return f.Node + ":" + f.Var + "[" + f.Ctx + "]" }

// varTaint maps variable -> set of taint contexts.
type varTaint map[string]map[string]bool

// state maps node id -> varTaint (taint at the node's exit).
type state map[string]varTaint

// Leak is one concrete leak path from a source fact to a sink fact.
type Leak struct {
	Sink string `json:"sink"`
	Var  string `json:"var"`
	Ctx  string `json:"ctx"`
	Path []Fact `json:"path"` // source fact ... sink fact
}

// Result holds the outcome of an analysis run.
type Result struct {
	// Iterations is the number of full passes until the least fixpoint.
	Iterations int
	// CtrlDeps maps a branch node id to the sorted ids of nodes that are
	// control-dependent on it (implicit-flow region).
	CtrlDeps map[string][]string
	// Leaks lists every discovered leak path.
	Leaks []Leak

	final   state
	history []state // snapshot of the full state after each pass
	parents map[Fact][]Fact
}

// TaintAt returns the sorted taint contexts of variable at a node's exit.
func (r *Result) TaintAt(nodeID, variable string) []string {
	set := r.final[nodeID][variable]
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Snapshot returns the taint contexts of variable at a node after the
// i-th iteration pass (0-based), for observing state expansion.
func (r *Result) Snapshot(pass int, nodeID, variable string) []string {
	if pass < 0 || pass >= len(r.history) {
		return nil
	}
	set := r.history[pass][nodeID][variable]
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Passes returns how many state snapshots were recorded (== Iterations).
func (r *Result) Passes() int { return len(r.history) }

// Analyze runs the taint analysis to its least fixpoint and then
// reconstructs every leak path.
func (g *Graph) Analyze() *Result {
	ctrlByBranch, ctrlByNode := g.controlDependence()

	out := newState(g)
	var history []state
	iterations := 0
	for {
		iterations++
		changed := false
		for i := range g.Nodes {
			n := &g.Nodes[i]
			in := varTaint{}
			for _, p := range g.preds[n.ID] {
				mergeInto(in, out[p])
			}
			next := transfer(g, n, in, out, ctrlByNode)
			if !varTaintEqual(out[n.ID], next) {
				changed = true
				out[n.ID] = next
			}
		}
		history = append(history, cloneState(out))
		if !changed {
			break
		}
	}

	res := &Result{
		Iterations: iterations,
		CtrlDeps:   ctrlByBranch,
		final:      out,
		history:    history,
	}
	res.buildProvenance(g, ctrlByNode)
	res.findLeaks(g)
	return res
}

// transfer applies the node's transfer function to its input state.
// All functions are monotone, so chaotic iteration from the empty state
// converges to the least fixpoint.
func transfer(g *Graph, n *Node, in varTaint, out state, ctrlByNode map[string][]string) varTaint {
	res := cloneVarTaint(in)
	switch n.Kind {
	case KindSource:
		ctxs := n.Contexts
		if len(ctxs) == 0 {
			ctxs = g.Contexts
		}
		res[n.Var] = setOf(ctxs)
	case KindAssign:
		t := map[string]bool{}
		for _, u := range n.Uses {
			for c := range in[u] {
				t[c] = true
			}
		}
		// Implicit flow: tainted branch conditions controlling this node.
		for _, b := range ctrlByNode[n.ID] {
			for _, condVar := range g.byID[b].Uses {
				for c := range out[b][condVar] {
					t[c] = true
				}
			}
		}
		res[n.Var] = t
	case KindSanitize:
		cur := map[string]bool{}
		for c := range in[n.Var] {
			cur[c] = true
		}
		for _, c := range n.Contexts {
			delete(cur, c)
		}
		res[n.Var] = cur
	}
	return res
}

// controlDependence computes, for every branch node, the set of nodes
// control-dependent on it, plus the reverse mapping.
func (g *Graph) controlDependence() (byBranch, byNode map[string][]string) {
	pdom := g.postDominators()
	byBranch = map[string][]string{}
	byNode = map[string][]string{}
	for i := range g.Nodes {
		b := &g.Nodes[i]
		if b.Kind != KindBranch {
			continue
		}
		ip := ipdomOf(pdom, b.ID)
		dep := map[string]bool{}
		var stack []string
		for _, s := range g.succs[b.ID] {
			if s != ip {
				stack = append(stack, s)
			}
		}
		for len(stack) > 0 {
			x := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if x == ip || dep[x] {
				continue
			}
			dep[x] = true
			stack = append(stack, g.succs[x]...)
		}
		list := sortedKeys(dep)
		byBranch[b.ID] = list
		for _, d := range list {
			byNode[d] = append(byNode[d], b.ID)
		}
	}
	for k := range byNode {
		sort.Strings(byNode[k])
	}
	return byBranch, byNode
}

// postDominators computes pdom(n) = set of nodes that post-dominate n,
// by greatest-fixpoint iteration over the reversed CFG.
func (g *Graph) postDominators() map[string]map[string]bool {
	pdom := make(map[string]map[string]bool, len(g.Nodes))
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if len(g.succs[n.ID]) == 0 {
			pdom[n.ID] = map[string]bool{n.ID: true}
		} else {
			all := map[string]bool{}
			for j := range g.Nodes {
				all[g.Nodes[j].ID] = true
			}
			pdom[n.ID] = all
		}
	}
	for changed := true; changed; {
		changed = false
		for i := range g.Nodes {
			n := &g.Nodes[i]
			succs := g.succs[n.ID]
			if len(succs) == 0 {
				continue
			}
			inter := map[string]bool{}
			for id := range pdom[succs[0]] {
				inter[id] = true
			}
			for _, s := range succs[1:] {
				for id := range inter {
					if !pdom[s][id] {
						delete(inter, id)
					}
				}
			}
			inter[n.ID] = true
			if !setEqual(pdom[n.ID], inter) {
				pdom[n.ID] = inter
				changed = true
			}
		}
	}
	return pdom
}

// ipdomOf returns the immediate post-dominator of id, or "" if none.
func ipdomOf(pdom map[string]map[string]bool, id string) string {
	strict := map[string]bool{}
	for d := range pdom[id] {
		if d != id {
			strict[d] = true
		}
	}
	for c := range strict {
		closest := true
		for o := range strict {
			if o != c && !pdom[c][o] {
				closest = false
				break
			}
		}
		if closest {
			return c
		}
	}
	return ""
}

func newState(g *Graph) state {
	s := make(state, len(g.Nodes))
	for i := range g.Nodes {
		s[g.Nodes[i].ID] = varTaint{}
	}
	return s
}

func setOf(items []string) map[string]bool {
	s := make(map[string]bool, len(items))
	for _, it := range items {
		s[it] = true
	}
	return s
}

func mergeInto(dst, src varTaint) {
	for v, ctxs := range src {
		if dst[v] == nil {
			dst[v] = map[string]bool{}
		}
		for c := range ctxs {
			dst[v][c] = true
		}
	}
}

func cloneVarTaint(vt varTaint) varTaint {
	out := make(varTaint, len(vt))
	for v, ctxs := range vt {
		cp := make(map[string]bool, len(ctxs))
		for c := range ctxs {
			cp[c] = true
		}
		out[v] = cp
	}
	return out
}

func cloneState(s state) state {
	out := make(state, len(s))
	for id, vt := range s {
		out[id] = cloneVarTaint(vt)
	}
	return out
}

func varTaintEqual(a, b varTaint) bool {
	if len(a) != len(b) {
		return false
	}
	for v, ctxs := range a {
		if !setEqual(ctxs, b[v]) {
			return false
		}
	}
	return true
}

func setEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
