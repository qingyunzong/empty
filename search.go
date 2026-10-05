package main

import (
	"math"
	"math/bits"
	"sort"
)

// searchCtx is a branch-and-bound subset search over nodes ordered by
// effective cost/weight ratio. It prunes branches that cannot become
// legal (weight majority unreachable, not enough domains reachable) or
// cannot beat the current cost bound (fractional-knapsack relaxation).
//
// In ft mode the search looks for fault-tolerant quorums: sets that stay
// legal after losing any single member. Fault tolerance of a set Q is
// decided incrementally and is equivalent to
//   - weight(Q) - heaviest member >= majority threshold, and
//   - domains(Q) >= minDomains, plus one more domain if any member is
//     the only representative of its domain.
//
// Per-domain membership counts are maintained along the recursion so the
// check is O(domains) per node instead of O(n^2) per leaf.
type searchCtx struct {
	in         *Instance
	cons       Constraints
	ft         bool
	ord        []int
	nodeDom    []int
	effCost    []int64 // per-node effective cost (0 for free nodes)
	suffixW    []int64
	suffixDom  []uint64
	suffixTopW [][]int64 // per suffix: weights sorted descending
	frac       [][]int   // per suffix: positive-weight nodes by cost/weight ratio
	counts     []int     // per-domain included-member counts
	best       int64
	accept     func(mask uint64) bool
	visit      func(mask uint64, cost int64)
	steps      int64
	maxSteps   int64 // 0 = unlimited
	Aborted    bool
}

func newSearchCtx(in *Instance, cons Constraints) *searchCtx {
	ctx := &searchCtx{in: in, cons: cons, best: math.MaxInt64}
	n := len(in.Nodes)
	ctx.effCost = make([]int64, n)
	for i, nd := range in.Nodes {
		ctx.effCost[i] = nd.Cost
	}
	ctx.rebuild()
	return ctx
}

// setFree makes the given nodes cost nothing (used to price a partner
// quorum by the extra cost it adds on top of an existing quorum).
func (s *searchCtx) setFree(mask uint64) {
	for m := mask; m != 0; m &= m - 1 {
		s.effCost[bits.TrailingZeros64(m)] = 0
	}
	s.rebuild()
}

func (s *searchCtx) rebuild() {
	in := s.in
	n := len(in.Nodes)
	ord := make([]int, n)
	for i := range ord {
		ord[i] = i
	}
	sort.Slice(ord, func(a, b int) bool {
		na, nb := in.Nodes[ord[a]], in.Nodes[ord[b]]
		ra := ratioKey(s.effCost[ord[a]], na.Weight)
		rb := ratioKey(s.effCost[ord[b]], nb.Weight)
		if ra != rb {
			return ra.less(rb)
		}
		return na.Weight > nb.Weight
	})
	s.ord = ord
	s.nodeDom = make([]int, n)
	for j := range in.Nodes {
		s.nodeDom[j] = in.domIdx[in.Nodes[j].Domain]
	}
	s.counts = make([]int, len(in.domNames))
	s.maxSteps = s.cons.MaxSteps
	s.suffixW = make([]int64, n+1)
	s.suffixDom = make([]uint64, n+1)
	s.suffixTopW = make([][]int64, n+1)
	for i := n - 1; i >= 0; i-- {
		w := in.Nodes[ord[i]].Weight
		s.suffixW[i] = s.suffixW[i+1] + w
		s.suffixDom[i] = s.suffixDom[i+1] | in.domainBit(ord[i])
		lst := append([]int64{w}, s.suffixTopW[i+1]...)
		sort.Slice(lst, func(a, b int) bool { return lst[a] > lst[b] })
		s.suffixTopW[i] = lst
	}
	s.frac = make([][]int, n+1)
	for i := n - 1; i >= 0; i-- {
		var lst []int
		if in.Nodes[ord[i]].Weight > 0 {
			lst = append(lst, ord[i])
		}
		lst = append(lst, s.frac[i+1]...)
		sort.Slice(lst, func(a, b int) bool {
			return ratioKey(s.effCost[lst[a]], in.Nodes[lst[a]].Weight).
				less(ratioKey(s.effCost[lst[b]], in.Nodes[lst[b]].Weight))
		})
		s.frac[i] = lst
	}
}

// ratio is a cost/weight key compared by cross-multiplication.
type ratio struct {
	num, den int64
}

func ratioKey(cost, weight int64) ratio {
	if weight == 0 {
		return ratio{math.MaxInt64, 1}
	}
	return ratio{cost, weight}
}

func (a ratio) less(b ratio) bool {
	if a.den == 1 && a.num == math.MaxInt64 {
		return false
	}
	if b.den == 1 && b.num == math.MaxInt64 {
		return true
	}
	return a.num*b.den < b.num*a.den
}

// topKWeight returns the maximum weight addable from the suffix starting
// at i when at most k more nodes may be included.
func (s *searchCtx) topKWeight(i int, k int) int64 {
	lst := s.suffixTopW[i]
	if k > len(lst) {
		k = len(lst)
	}
	var sum int64
	for _, w := range lst[:k] {
		sum += w
	}
	return sum
}

// minAddCost lower-bounds the extra cost needed to gain `need` more
// weight from the suffix starting at i, via the fractional-knapsack
// relaxation (items taken by best cost/weight ratio, the last one
// fractional). Returns math.MaxInt64 when the suffix weight is short.
func (s *searchCtx) minAddCost(i int, need int64) int64 {
	var add int64
	for _, j := range s.frac[i] {
		nd := s.in.Nodes[j]
		c := s.effCost[j]
		if c == 0 {
			need -= nd.Weight
		} else if nd.Weight >= need {
			return add + (c*need+nd.Weight-1)/nd.Weight
		} else {
			add += c
			need -= nd.Weight
		}
		if need <= 0 {
			return add
		}
	}
	return math.MaxInt64
}

// seed greedily includes nodes in ratio order until the quorum is valid,
// then records the prefix through visit so it becomes both an initial
// solution and an initial cost bound.
func (s *searchCtx) seed() {
	var mask uint64
	var cost, weight int64
	var doms uint64
	size := 0
	for _, j := range s.ord {
		if size < s.cons.MaxSize {
			nd := s.in.Nodes[j]
			mask |= uint64(1) << uint(j)
			cost += s.effCost[j]
			weight += nd.Weight
			doms |= s.in.domainBit(j)
			size++
		}
		ok := weight*2 > s.in.TotalWeight && bits.OnesCount64(doms) >= s.cons.MinDomains
		if ok && s.ft {
			ok = s.in.FTLegal(mask, s.cons)
		}
		if ok && (s.accept == nil || s.accept(mask)) {
			s.visit(mask, cost)
			return
		}
	}
}

func (s *searchCtx) recurse(i, size int, cost, weight, maxInc int64, doms, mask uint64) {
	s.steps++
	if s.maxSteps > 0 && s.steps >= s.maxSteps {
		s.Aborted = true
		return
	}
	if cost >= s.best {
		return
	}
	threshold := s.in.TotalWeight/2 + 1
	k := s.cons.MaxSize - size
	// Cardinality-capped weight cap: with at most k more nodes the final
	// weight cannot exceed weight plus the k heaviest remaining weights.
	weightCap := weight + s.topKWeight(i, k)
	// Fault-tolerant weight margin: the final quorum must keep a strict
	// majority after losing its heaviest member (at least maxInc).
	if s.ft && weightCap-maxInc < threshold {
		return
	}
	// Fractional-knapsack lower bound on the cost of the missing weight.
	margin := int64(0)
	if s.ft {
		margin = maxInc
	}
	if need := threshold + margin - weight; need > 0 {
		if add := s.minAddCost(i, need); add >= s.best-cost {
			return
		}
	}
	singletons := 0
	if s.ft {
		unfixable := false
		for d, c := range s.counts {
			if c == 1 {
				singletons++
				if s.suffixDom[i]&(uint64(1)<<uint(d)) == 0 {
					unfixable = true
				}
			}
		}
		need := s.cons.MinDomains
		if unfixable {
			need++
		}
		if bits.OnesCount64(doms|s.suffixDom[i]) < need {
			return
		}
	}
	if i == len(s.ord) {
		if s.ft {
			if weight-maxInc >= threshold &&
				bits.OnesCount64(doms) >= s.cons.MinDomains+boolInt(singletons > 0) &&
				(s.accept == nil || s.accept(mask)) {
				s.visit(mask, cost)
			}
			return
		}
		if weight*2 > s.in.TotalWeight &&
			bits.OnesCount64(doms) >= s.cons.MinDomains &&
			(s.accept == nil || s.accept(mask)) {
			s.visit(mask, cost)
		}
		return
	}
	// Even taking the heaviest remaining nodes cannot reach a majority.
	if weightCap*2 <= s.in.TotalWeight {
		return
	}
	// Even taking every remaining node cannot reach the domain minimum.
	if bits.OnesCount64(doms|s.suffixDom[i]) < s.cons.MinDomains {
		return
	}
	j := s.ord[i]
	nd := s.in.Nodes[j]
	if size < s.cons.MaxSize {
		m := maxInc
		if nd.Weight > m {
			m = nd.Weight
		}
		d := s.nodeDom[j]
		s.counts[d]++
		s.recurse(i+1, size+1, cost+s.effCost[j], weight+nd.Weight, m,
			doms|s.in.domainBit(j), mask|uint64(1)<<uint(j))
		s.counts[d]--
	}
	s.recurse(i+1, size, cost, weight, maxInc, doms, mask)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// SingleResult is the outcome of the single-quorum search.
type SingleResult struct {
	Feasible bool
	Mask     uint64
	Cost     int64
	Aborted  bool
}

// SolveSingle finds the minimum-cost legal quorum.
func SolveSingle(in *Instance, cons Constraints) SingleResult {
	ctx := newSearchCtx(in, cons)
	var res SingleResult
	ctx.visit = func(mask uint64, cost int64) {
		if cost < ctx.best {
			ctx.best = cost
			res = SingleResult{Feasible: true, Mask: mask, Cost: cost}
		}
	}
	ctx.seed()
	ctx.recurse(0, 0, 0, 0, 0, 0, 0)
	res.Aborted = ctx.Aborted
	return res
}

// SolveFTSingle finds the minimum-cost fault-tolerant quorum (legal, and
// legal after the loss of any single member).
func SolveFTSingle(in *Instance, cons Constraints) SingleResult {
	ctx := newSearchCtx(in, cons)
	ctx.ft = true
	var res SingleResult
	ctx.visit = func(mask uint64, cost int64) {
		if cost < ctx.best {
			ctx.best = cost
			res = SingleResult{Feasible: true, Mask: mask, Cost: cost}
		}
	}
	ctx.seed()
	ctx.recurse(0, 0, 0, 0, 0, 0, 0)
	res.Aborted = ctx.Aborted
	return res
}

// enumFTQuorums collects every fault-tolerant quorum with cost <= limit.
func enumFTQuorums(in *Instance, cons Constraints, limit int64) []uint64 {
	ctx := newSearchCtx(in, cons)
	ctx.ft = true
	if limit < math.MaxInt64 {
		ctx.best = limit + 1
	}
	var out []uint64
	ctx.visit = func(mask uint64, cost int64) { out = append(out, mask) }
	ctx.recurse(0, 0, 0, 0, 0, 0, 0)
	return out
}

// PairResult is the outcome of the read/write quorum-pair search.
type PairResult struct {
	Feasible   bool
	R, W       uint64
	Cost       int64 // cost of the union R ∪ W
	LowerBound int64 // proven lower bound on the optimum
	Aborted    bool  // search budget exhausted; Cost is only an upper bound
	FTQuorums  int   // fault-tolerant quorums considered
	Pairs      int64 // candidate pairs checked
}

// SolvePair finds distinct fault-tolerant quorums R and W that still
// intersect after any single node failure inside R ∪ W (equivalently
// |R ∩ W| >= 2) and minimise the union cost. It enumerates fault-tolerant
// quorums cheapest-first and pairs each new quorum with every quorum seen
// before, tightening the branch-and-bound cost limit to the best union
// cost found so far. The returned LowerBound is a proven lower bound on
// the optimum; Cost is the proven optimum unless Aborted is set.
func SolvePair(in *Instance, cons Constraints) PairResult {
	var res PairResult
	first := SolveFTSingle(in, cons)
	if !first.Feasible {
		res.Aborted = first.Aborted
		return res
	}
	// Any pair's union contains a fault-tolerant quorum, so the cheapest
	// fault-tolerant quorum is a valid lower bound on the union cost. If
	// that search was cut short, fall back to the cheapest legal quorum.
	if first.Aborted {
		res.Aborted = true
		if s := SolveSingle(in, cons); s.Feasible && !s.Aborted {
			res.LowerBound = s.Cost
		}
	} else {
		res.LowerBound = first.Cost
	}

	best := int64(math.MaxInt64)
	var bestR, bestW uint64

	// Heuristic upper bound: the cheapest partner for the cheapest
	// fault-tolerant quorum, priced by the extra cost it adds on top.
	partner := newSearchCtx(in, cons)
	partner.ft = true
	partner.setFree(first.Mask)
	partner.accept = func(mask uint64) bool {
		return mask != first.Mask &&
			bits.OnesCount64(mask&first.Mask) >= 2
	}
	var partnerMask uint64
	var partnerExtra int64
	partnerFound := false
	partner.visit = func(mask uint64, cost int64) {
		if cost < partner.best {
			partner.best = cost
			partnerMask = mask
			partnerExtra = cost
			partnerFound = true
		}
	}
	partner.seed()
	partner.recurse(0, 0, 0, 0, 0, 0, 0)
	if partner.Aborted {
		res.Aborted = true
	}
	if partnerFound {
		best = first.Cost + partnerExtra
		bestR, bestW = first.Mask, partnerMask
	}

	ctx := newSearchCtx(in, cons)
	ctx.ft = true
	ctx.best = best
	type quorumCost struct {
		mask uint64
		cost int64
	}
	var prev []quorumCost
	seen := map[uint64]bool{} // the seed prefix is reachable by the recursion too
	ctx.visit = func(mask uint64, cost int64) {
		if seen[mask] {
			return
		}
		seen[mask] = true
		for _, p := range prev {
			res.Pairs++
			inter := mask & p.mask
			if bits.OnesCount64(inter) < 2 {
				continue
			}
			if u := cost + p.cost - in.Cost(inter); u < best {
				best = u
				bestR, bestW = p.mask, mask
				ctx.best = best
			}
		}
		prev = append(prev, quorumCost{mask, cost})
	}
	ctx.seed()
	ctx.recurse(0, 0, 0, 0, 0, 0, 0)
	res.FTQuorums = len(prev)
	res.Aborted = res.Aborted || ctx.Aborted
	if best == math.MaxInt64 {
		return res
	}
	res.Feasible = true
	res.R, res.W, res.Cost = bestR, bestW, best
	return res
}
