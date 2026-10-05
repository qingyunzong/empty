package petri

// This file is the deliberately naive cross-check implementation. It
// re-derives the firing semantics on its own and deduplicates states by
// linear scan instead of a hash map, so it can be validated against the
// optimized BFS in bfs.go.

func naiveEnabled(t *Transition, m Marking) bool {
	if t.Guard != nil && !t.Guard(m) {
		return false
	}
	for p := 0; p < MaxPlaces; p++ {
		if t.Consume[p] > m[p] {
			return false
		}
	}
	return true
}

func naiveFire(t *Transition, m Marking) (Marking, bool) {
	if !naiveEnabled(t, m) {
		return Marking{}, false
	}
	var next Marking
	for p := 0; p < MaxPlaces; p++ {
		next[p] = m[p] - t.Consume[p]
	}
	for p := 0; p < MaxPlaces; p++ {
		if t.Reset[p] {
			next[p] = 0
		}
	}
	for p := 0; p < MaxPlaces; p++ {
		sum := next[p] + t.Produce[p]
		if sum > Capacity {
			return Marking{}, false
		}
		next[p] = sum
	}
	return next, true
}

func naiveFireable(n *Net, m Marking) []int {
	top := -1 << 30
	for i := range n.Transitions {
		if naiveEnabled(&n.Transitions[i], m) && n.Transitions[i].Priority > top {
			top = n.Transitions[i].Priority
		}
	}
	var out []int
	for i := range n.Transitions {
		t := &n.Transitions[i]
		if naiveEnabled(t, m) && t.Priority == top {
			if _, ok := naiveFire(t, m); ok {
				out = append(out, i)
			}
		}
	}
	return out
}

func containsMarking(list []Marking, m Marking) bool {
	for _, x := range list {
		if x == m {
			return true
		}
	}
	return false
}

// NaiveClosure is the naive counterpart of Closure: BFS with linear-scan
// deduplication.
func (n *Net) NaiveClosure(initial Marking) []Marking {
	seen := []Marking{initial}
	queue := []Marking{initial}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, i := range naiveFireable(n, cur) {
			next, _ := naiveFire(&n.Transitions[i], cur)
			if !containsMarking(seen, next) {
				seen = append(seen, next)
				queue = append(queue, next)
			}
		}
	}
	return seen
}

// NaiveShortestDistance returns the length of a shortest firing sequence from
// initial to target, or -1 if unreachable. Plain level-by-level BFS.
func (n *Net) NaiveShortestDistance(initial, target Marking) int {
	if initial == target {
		return 0
	}
	seen := []Marking{initial}
	type item struct {
		m Marking
		d int
	}
	queue := []item{{initial, 0}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, i := range naiveFireable(n, cur.m) {
			next, _ := naiveFire(&n.Transitions[i], cur.m)
			if next == target {
				return cur.d + 1
			}
			if !containsMarking(seen, next) {
				seen = append(seen, next)
				queue = append(queue, item{next, cur.d + 1})
			}
		}
	}
	return -1
}
