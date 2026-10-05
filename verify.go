package dom

import (
	"fmt"
	"sort"
	"strings"
)

// Verify independently cross-checks this version's dominator sets using
// the definitional node-deletion reachability method: d dominates n iff
// removing d from the graph makes n unreachable from the entry. It is
// O(N*(N+E)) and intended for small graphs and tests. It also re-checks
// the reachable/unreachable partition with a plain BFS. A nil return
// means the maintained analysis matches the independent recomputation.
func (v *Version) Verify() error {
	var errs []string

	// 1. Reachability partition via independent BFS.
	reach := map[string]bool{v.entry: true}
	queue := []string{v.entry}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		for _, m := range v.succ[n] {
			if !reach[m] {
				reach[m] = true
				queue = append(queue, m)
			}
		}
	}
	for _, n := range v.nodes {
		if reach[n] != v.reachable[n] {
			errs = append(errs, fmt.Sprintf("reachability mismatch for %q: maintained=%v independent=%v",
				n, v.reachable[n], reach[n]))
		}
	}

	// 2. Dominator sets via node deletion.
	for _, n := range v.nodes {
		if !reach[n] {
			if _, ok := v.domSets[n]; ok {
				errs = append(errs, fmt.Sprintf("unreachable node %q must not have a dominator set", n))
			}
			continue
		}
		want := map[string]bool{}
		for _, d := range v.nodes {
			if !reachableWithout(v, d, n) {
				want[d] = true
			}
		}
		got := v.domSets[n]
		if len(got) != len(want) || !sameSet(got, want) {
			errs = append(errs, fmt.Sprintf("dominators(%q): maintained={%s} independent={%s}",
				n, joinSorted(got), joinSorted(want)))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("version %d failed independent verification:\n%s",
			v.seq, strings.Join(errs, "\n"))
	}
	return nil
}

// reachableWithout reports whether n is reachable from the entry when
// node del (and all its edges) is removed from the graph.
func reachableWithout(v *Version, del, n string) bool {
	if n == del {
		return false
	}
	seen := map[string]bool{v.entry: true}
	queue := []string{v.entry}
	for len(queue) > 0 {
		x := queue[0]
		queue = queue[1:]
		if x == n {
			return true
		}
		if x == del {
			continue
		}
		for _, m := range v.succ[x] {
			if m != del && !seen[m] {
				seen[m] = true
				queue = append(queue, m)
			}
		}
	}
	return false
}

func sameSet(a, b map[string]bool) bool {
	for k := range a {
		if !b[k] {
			return false
		}
	}
	for k := range b {
		if !a[k] {
			return false
		}
	}
	return true
}

func joinSorted(set map[string]bool) string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}
