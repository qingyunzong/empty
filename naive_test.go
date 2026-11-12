package dataeng

import "sort"

// naiveEval is an intentionally simple per-path interpreter used only by the
// tests to cross-check the production engine. It re-parses the expression,
// then walks each full path independently: for every surviving input node it
// builds the candidate list from scratch, applies the positional predicate to
// that list alone, and only merges afterwards. It performs no incremental
// dedup, so descendant overlaps are handled by the final union step.
func naiveEval(expr string, virtualRoot *Node) ([]int, error) {
	sel, err := Compile(expr)
	if err != nil {
		return nil, err
	}

	order := map[int]int{}
	assignPreorder(virtualRoot, 0, order)

	seen := map[int]bool{}
	var ids []int
	for i := range sel.paths {
		for _, node := range naivePath(sel.paths[i].steps, virtualRoot) {
			if !seen[node.ID] {
				seen[node.ID] = true
				ids = append(ids, node.ID)
			}
		}
	}

	sort.SliceStable(ids, func(i, j int) bool { return order[ids[i]] < order[ids[j]] })
	return ids, nil
}

// naivePath runs one complete path by straightforward recursion over steps.
func naivePath(steps []step, node *Node) []*Node {
	if len(steps) == 0 {
		return nil
	}

	var from []*Node
	if steps[0].axis == descendantAxis {
		from = naiveDescendants(node)
	} else {
		from = append(from, node.Children...)
	}

	var current []*Node
	for _, candidate := range from {
		if matchesName(&steps[0], candidate) {
			current = append(current, candidate)
		}
	}
	current = naivePredicate(&steps[0], current)

	for stepIndex := 1; stepIndex < len(steps); stepIndex++ {
		st := &steps[stepIndex]
		var next []*Node
		for _, input := range current {
			// Rebuild the candidate set for this single input node.
			var pool []*Node
			if st.axis == descendantAxis {
				pool = naiveDescendants(input)
			} else {
				pool = append(pool, input.Children...)
			}

			var candidates []*Node
			for _, candidate := range pool {
				if matchesName(st, candidate) {
					candidates = append(candidates, candidate)
				}
			}
			next = append(next, naivePredicate(st, candidates)...)
		}
		current = next
		if len(current) == 0 {
			return nil
		}
	}
	return current
}

// naiveDescendants returns every strict descendant of node in document
// preorder; node itself is excluded.
func naiveDescendants(node *Node) []*Node {
	var out []*Node
	var walk func(n *Node)
	walk = func(n *Node) {
		for _, child := range n.Children {
			out = append(out, child)
			walk(child)
		}
	}
	walk(node)
	return out
}

func matchesName(st *step, node *Node) bool {
	return st.any || node.Tag == st.name
}

// naivePredicate applies the position predicate to one input node's
// candidate set in isolation.
func naivePredicate(st *step, candidates []*Node) []*Node {
	switch st.pred.kind {
	case noneKind:
		return candidates
	case indexKind:
		if st.pred.index > len(candidates) || st.pred.index < 1 {
			return nil
		}
		return []*Node{candidates[st.pred.index-1]}
	case lastKind:
		if len(candidates) == 0 {
			return nil
		}
		return []*Node{candidates[len(candidates)-1]}
	default:
		return candidates
	}
}
