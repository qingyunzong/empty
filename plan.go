package formal

// Plan computes the target allocation for one scheduling round. It is a pure
// function of in: the same input always yields the same plan, so callers may
// invoke it concurrently from multiple scheduler goroutines.
//
// Semantics, in decreasing importance: quota guarantees are honored (and
// borrowed capacity reclaimed for them, preferring to reclaim from sibling
// subtrees first), higher priority tiers are filled before lower ones, the
// completed work lost to preemption is minimized, and remaining ties break
// in stable fairness order (priority, arrival, ID). Gang jobs are placed
// atomically; running non-preemptible jobs are always kept.
func Plan(in Input, opts *Options) (*Result, error) {
	p, err := prepare(in)
	if err != nil {
		return nil, err
	}
	maxCells := int64(DefaultMaxExactCells)
	if opts != nil && opts.MaxExactCells > 0 {
		maxCells = opts.MaxExactCells
	}
	var taken []bool
	if p.capLeft < maxCells && int64(len(p.jobs)) <= maxCells/(p.capLeft+1) {
		taken = solveExact(p)
	} else {
		taken = solveGreedy(p)
	}
	return p.assemble(taken), nil
}

// solveExact is a 0/1 knapsack over the lexicographic score, processed in
// reverse canonical order. On exact score ties it prefers taking the current
// (earlier, fairer) job, which yields the canonical-best optimum because all
// not-yet-processed jobs tie-break later.
func solveExact(p *prepared) []bool {
	n := len(p.jobs)
	cells := int(p.capLeft) + 1
	stride := p.stride
	prev := make([]int64, cells*stride)
	take := make([][]bool, n)
	for i := n - 1; i >= 0; i-- {
		cur := make([]int64, cells*stride)
		copy(cur, prev)
		tk := make([]bool, cells)
		u := int(p.units[i])
		d := p.delta[i]
		for c := 0; c+u < cells; c++ {
			src := c * stride
			dst := (c + u) * stride
			if geqDelta(prev[src:src+stride], d, cur[dst:dst+stride]) {
				addDelta(cur[dst:dst+stride], prev[src:src+stride], d)
				tk[c+u] = true
			}
		}
		take[i] = tk
		prev = cur
	}
	taken := make([]bool, n)
	c := int(p.capLeft)
	for i := 0; i < n; i++ {
		if take[i][c] {
			taken[i] = true
			c -= int(p.units[i])
		}
	}
	return taken
}

// geqDelta reports whether base+delta is lexicographically >= cur.
func geqDelta(base, delta, cur []int64) bool {
	for k := range cur {
		lhs := base[k] + delta[k]
		if lhs != cur[k] {
			return lhs > cur[k]
		}
	}
	return true
}

func addDelta(dst, base, delta []int64) {
	for k := range dst {
		dst[k] = base[k] + delta[k]
	}
}

// solveGreedy is the large-instance fallback: first place every job covered
// by its own queue's guarantee (these always fit together because leaf
// guarantees sum to at most the root guarantee), then fill remaining
// capacity in canonical fairness order.
func solveGreedy(p *prepared) []bool {
	taken := make([]bool, len(p.jobs))
	left := p.capLeft
	for i := range p.jobs {
		if p.prot0[i] && p.units[i] <= left {
			taken[i] = true
			left -= p.units[i]
		}
	}
	for i := range p.jobs {
		if !taken[i] && p.units[i] <= left {
			taken[i] = true
			left -= p.units[i]
		}
	}
	return taken
}

// assemble diffs the chosen target set against the current cluster state.
func (p *prepared) assemble(taken []bool) *Result {
	plan := &Result{Score: p.scoreOf(taken)}
	plan.Allocated = append(plan.Allocated, p.mandated...)
	for i, j := range p.jobs {
		if !taken[i] {
			if j.Running {
				plan.Preempt = append(plan.Preempt, j)
			}
			continue
		}
		plan.Allocated = append(plan.Allocated, j)
		if !j.Running {
			plan.Start = append(plan.Start, j)
		}
	}
	sortCanonical(plan.Allocated)
	return plan
}
