package formal

// Score is the planner's lexicographic objective, compared field by field:
//
//  1. Protected[level]: units covered by quota guarantees, level 0 being the
//     job's own queue, level 1 its parent, and so on. Honoring guarantees
//     dominates everything else, and preferring coverage closer to the leaf
//     makes borrowing reclaim idle capacity from siblings before strangers.
//  2. Tier[t]: allocated units per priority tier, highest priority first.
//     This gives preemptible priorities their semantics.
//  3. KeptWork: completed work of running jobs that stay allocated, so
//     reclaiming borrowed resources minimizes lost work.
//
// Ties are broken deterministically in canonical fairness order (priority,
// arrival, ID), which makes the optimal allocation unique.
type Score struct {
	Protected []int64
	Tier      []int64
	KeptWork  int64
}

// Compare returns -1, 0 or 1 as a is worse than, equal to, or better than b.
func (a Score) Compare(b Score) int {
	if c := compareInts(a.Protected, b.Protected); c != 0 {
		return c
	}
	if c := compareInts(a.Tier, b.Tier); c != 0 {
		return c
	}
	switch {
	case a.KeptWork < b.KeptWork:
		return -1
	case a.KeptWork > b.KeptWork:
		return 1
	}
	return 0
}

func compareInts(a, b []int64) int {
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		var x, y int64
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// prepared is an Input compiled for solving: canonically ordered jobs,
// per-job score deltas, and the mandatory (non-preemptible) base.
type prepared struct {
	in       Input
	jobs     []Job // canonical order, mandatory jobs removed
	units    []int64
	delta    [][]int64 // per job, length stride
	stride   int
	levels   int
	tiers    int
	tierOf   map[int]int
	capLeft  int64
	base     Score
	mandated []Job
	prot0    []bool // job is covered by its own queue's guarantee
}

// prepare validates the input and compiles the score deltas. Every job
// contributes its units to the protection level of each ancestor whose
// guarantee prefix covers it, to its priority tier, and (when running) its
// completed work to KeptWork.
func prepare(in Input) (*prepared, error) {
	if err := in.Tree.Validate(in.Capacity); err != nil {
		return nil, err
	}
	leaves := in.Tree.leaves()
	if err := validateJobs(in.Jobs, leaves); err != nil {
		return nil, err
	}

	jobs := make([]Job, len(in.Jobs))
	copy(jobs, in.Jobs)
	sortCanonical(jobs)

	maxDepth := 0
	for _, l := range leaves {
		if l.depth > maxDepth {
			maxDepth = l.depth
		}
	}
	levels := maxDepth

	tierOf := map[int]int{}
	tiers := 0
	for _, j := range jobs {
		if _, ok := tierOf[j.Priority]; !ok {
			tierOf[j.Priority] = tiers
			tiers++
		}
	}

	p := &prepared{in: in, levels: levels, tiers: tiers, tierOf: tierOf}
	p.stride = levels + tiers + 1

	protected := protection(jobs, leaves, levels)

	var capLeft = in.Capacity
	var rest []Job
	for _, j := range jobs {
		if j.Running && !j.Preemptible {
			p.mandated = append(p.mandated, j)
			capLeft -= j.Units()
		} else {
			rest = append(rest, j)
		}
	}
	if capLeft < 0 {
		return nil, ErrOverCapacity
	}
	p.capLeft = capLeft
	p.base = Score{
		Protected: make([]int64, levels),
		Tier:      make([]int64, tiers),
	}
	for _, j := range p.mandated {
		u := j.Units()
		for lvl := 0; lvl < levels; lvl++ {
			if protected[j.ID][lvl] {
				p.base.Protected[lvl] += u
			}
		}
		p.base.Tier[tierOf[j.Priority]] += u
		if j.Running {
			p.base.KeptWork += j.CompletedWork
		}
	}

	p.jobs = rest
	p.units = make([]int64, len(rest))
	p.delta = make([][]int64, len(rest))
	p.prot0 = make([]bool, len(rest))
	for i, j := range rest {
		p.units[i] = j.Units()
		d := make([]int64, p.stride)
		for lvl := 0; lvl < levels; lvl++ {
			if protected[j.ID][lvl] {
				d[lvl] = p.units[i]
			}
		}
		d[levels+tierOf[j.Priority]] = p.units[i]
		if j.Running {
			d[levels+tiers] = j.CompletedWork
		}
		p.delta[i] = d
		p.prot0[i] = protected[j.ID][0]
	}
	return p, nil
}

// protection computes, for every non-root quota node, the canonical prefix
// of its subtree's jobs whose cumulative units fit within the node's
// guarantee. A job in the prefix of an ancestor at distance lvl from its
// queue is protected at that level. The prefix stops at the first job that
// does not fit, keeping protection deterministic and explainable. The root
// is excluded: its guarantee is the cluster itself, not a claim against
// siblings, so it must not override utilization.
func protection(jobs []Job, leaves map[string]leafInfo, levels int) map[string][]bool {
	out := make(map[string][]bool, len(jobs))
	for _, j := range jobs {
		out[j.ID] = make([]bool, levels)
	}
	byNode := map[*Node][]Job{}
	for _, j := range jobs {
		ancestors := leaves[j.Queue].ancestors
		for _, cur := range ancestors[:len(ancestors)-1] {
			byNode[cur] = append(byNode[cur], j)
		}
	}
	for n, js := range byNode {
		var cum int64
		for _, j := range js {
			if cum+j.Units() > n.Guarantee {
				break
			}
			cum += j.Units()
			lvl := levelOf(leaves[j.Queue], n)
			out[j.ID][lvl] = true
		}
	}
	return out
}

// levelOf returns the distance of ancestor n above the leaf, 0 for the leaf
// itself.
func levelOf(leaf leafInfo, n *Node) int {
	for lvl, a := range leaf.ancestors {
		if a == n {
			return lvl
		}
	}
	return -1
}

// scoreOf recomputes the full score of an allocation decision.
func (p *prepared) scoreOf(taken []bool) Score {
	s := Score{
		Protected: append([]int64(nil), p.base.Protected...),
		Tier:      append([]int64(nil), p.base.Tier...),
		KeptWork:  p.base.KeptWork,
	}
	for i := range p.jobs {
		if !taken[i] {
			continue
		}
		for k, v := range p.delta[i] {
			if k < p.levels {
				s.Protected[k] += v
			} else if k < p.levels+p.tiers {
				s.Tier[k-p.levels] += v
			} else {
				s.KeptWork += v
			}
		}
	}
	return s
}
