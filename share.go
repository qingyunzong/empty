package formal

// FairShares computes the hierarchical fair share of every queue for the
// given per-queue demands (in cluster units). Each node's guarantee acts as
// its weight: a subtree first satisfies its own guaranteed demand, and idle
// capacity is borrowed by siblings within a subtree before it crosses
// branches. The result is informational (e.g. for monitoring UIs); the
// planner itself does not depend on it.
//
// Every queue with demand d and guarantee g receives at least min(d, g)
// whenever the tree is valid for the capacity.
func FairShares(t *Tree, capacity float64, demand map[string]float64) (map[string]float64, error) {
	if err := t.Validate(int64(capacity)); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	var walk func(n *Node, path string, avail float64)
	walk = func(n *Node, path string, avail float64) {
		if n.IsLeaf() {
			d := demand[path]
			if avail < d {
				out[path] = avail
			} else {
				out[path] = d
			}
			return
		}
		weights := make([]float64, len(n.Children))
		caps := make([]float64, len(n.Children))
		for i, c := range n.Children {
			weights[i] = float64(c.Guarantee)
			caps[i] = subtreeDemand(c, childPath(path, c.Name), demand)
		}
		allot := waterFill(weights, caps, avail)
		for i, c := range n.Children {
			walk(c, childPath(path, c.Name), allot[i])
		}
	}
	name := t.Root.Name
	if len(t.Root.Children) > 0 {
		name = ""
	}
	walk(t.Root, name, capacity)
	return out, nil
}

func childPath(parent, name string) string {
	if parent == "" {
		return name
	}
	return parent + "/" + name
}

func subtreeDemand(n *Node, path string, demand map[string]float64) float64 {
	if n.IsLeaf() {
		return demand[path]
	}
	var sum float64
	for _, c := range n.Children {
		sum += subtreeDemand(c, childPath(path, c.Name), demand)
	}
	return sum
}

// waterFill distributes avail among the entries proportionally to weights,
// each capped by caps. Unused share of capped entries is redistributed.
func waterFill(weights, caps []float64, avail float64) []float64 {
	out := make([]float64, len(weights))
	active := make([]bool, len(weights))
	var totalWeight float64
	for i, w := range weights {
		if caps[i] > 0 && w > 0 {
			active[i] = true
			totalWeight += w
		}
	}
	remaining := avail
	for totalWeight > 0 && remaining > 0 {
		unit := remaining / totalWeight
		progress := false
		for i := range weights {
			if !active[i] {
				continue
			}
			share := unit * weights[i]
			if share >= caps[i] {
				out[i] = caps[i]
				remaining -= caps[i]
				active[i] = false
				totalWeight -= weights[i]
				progress = true
			}
		}
		if !progress {
			for i := range weights {
				if active[i] {
					out[i] = unit * weights[i]
				}
			}
			break
		}
	}
	return out
}
