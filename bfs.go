package petri

// Certificate witnesses a reachability query. If the target is reachable,
// Path is a shortest transition-index trajectory from the initial marking and
// States the corresponding markings (including both endpoints). If the target
// is unreachable, Closure holds the complete set of reachable markings.
type Certificate struct {
	Reachable bool
	Path      []int
	States    []Marking
	Closure   []Marking
}

// Search runs BFS from initial looking for target, deduplicating visited
// markings. It returns a shortest-trajectory certificate, or the full
// reachable closure when target is unreachable.
func (n *Net) Search(initial, target Marking) Certificate {
	if initial == target {
		return Certificate{Reachable: true, States: []Marking{initial}}
	}
	type node struct {
		m     Marking
		depth int
	}
	parent := map[Marking]Marking{}
	parentVia := map[Marking]int{}
	visited := map[Marking]bool{initial: true}
	var closure []Marking
	queue := []node{{m: initial}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		closure = append(closure, cur.m)
		for _, s := range n.Successors(cur.m) {
			if visited[s.Next] {
				continue
			}
			visited[s.Next] = true
			parent[s.Next] = cur.m
			parentVia[s.Next] = s.Trans
			if s.Next == target {
				cert := Certificate{Reachable: true}
				for m := target; m != initial; m = parent[m] {
					cert.Path = append(cert.Path, parentVia[m])
					cert.States = append(cert.States, m)
				}
				cert.States = append(cert.States, initial)
				for l, r := 0, len(cert.Path)-1; l < r; l, r = l+1, r-1 {
					cert.Path[l], cert.Path[r] = cert.Path[r], cert.Path[l]
				}
				for l, r := 0, len(cert.States)-1; l < r; l, r = l+1, r-1 {
					cert.States[l], cert.States[r] = cert.States[r], cert.States[l]
				}
				return cert
			}
			queue = append(queue, node{m: s.Next, depth: cur.depth + 1})
		}
	}
	return Certificate{Reachable: false, Closure: closure}
}

// Closure enumerates every marking reachable from initial, deduplicated.
func (n *Net) Closure(initial Marking) []Marking {
	visited := map[Marking]bool{initial: true}
	out := []Marking{initial}
	queue := []Marking{initial}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, s := range n.Successors(cur) {
			if !visited[s.Next] {
				visited[s.Next] = true
				out = append(out, s.Next)
				queue = append(queue, s.Next)
			}
		}
	}
	return out
}
