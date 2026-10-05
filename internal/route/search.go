package route

import "container/heap"

// label is one search state. The rebate is carried as cumulative state
// (cumNet/trig/red), never as a negative edge.
type label struct {
	node    int
	fuel    int64
	visited uint32
	prog    [MaxCoupons]uint32 // per-coupon required-edge progress
	used    int                // applied coupon id, -1 = none yet
	trig    bool               // cumulative net toll reached threshold
	red     bool               // rebate already redeemed
	cumNet  int64              // cumulative net toll (meaningful while !trig)
	cost    int64
	time    int64
	edges   []int // path so far (edge ids)
	alive   bool
	seq     int
	hidx    int
}

// SearchResult is the outcome of the finite-state search.
type SearchResult struct {
	Found      bool
	Cost       int64
	Time       int64
	Path       []int
	Sim        Simulation // exact per-edge cost process of Path
	LowerBound int64      // lower bound on the optimum
	Expansions int
	Exhausted  bool // expansion budget ran out before the queue emptied
}

// Search runs a best-first, dominance-pruned finite-state search over
// (node, fuel, visited set, coupon progress, coupon used, rebate state).
// It returns the best feasible route by (cost, time) and a lower bound.
// If budget > 0 caps expansions and the budget is hit, the best feasible
// solution found so far and the lower bound over open labels are
// returned with Exhausted=true; otherwise the solution is optimal and
// LowerBound equals Cost.
func (p *Problem) Search(budget int) SearchResult {
	adj := p.outAdj()
	bitIdx := p.bitIndex()
	tollDist := p.tollDistToEnd()
	var maxDisc int64
	for _, c := range p.Coupons {
		if c.Discount > maxDisc {
			maxDisc = c.Discount
		}
	}
	R := p.Rebate.Amount

	res := SearchResult{Found: false}
	best := &SearchResult{}

	// Admissible lower bound on any completion of l: minimum toll to
	// reach End minus the largest still-available rebate and coupon
	// discount. Fuel can only add cost, so it is ignored here.
	lbOf := func(l *label) (int64, bool) {
		d := tollDist[l.node]
		if d < 0 {
			return 0, false
		}
		lb := l.cost + d
		if !l.red {
			lb -= R
		}
		if l.used == -1 {
			lb -= maxDisc
		}
		return lb, true
	}

	// Per-node open label sets for dominance checks.
	open := make([][]*label, p.NumNodes)
	pq := &labelHeap{}
	seq := 0

	dominates := func(a, b *label) bool {
		// a dominates b: every continuation of b is matched by a.
		if a.time > b.time || a.fuel < b.fuel {
			return false
		}
		if a.visited&b.visited != a.visited {
			return false
		}
		if a.used != b.used {
			return false
		}
		for c := 0; c < len(p.Coupons); c++ {
			// a must have at least b's coupon progress (superset).
			if a.prog[c]&b.prog[c] != b.prog[c] {
				return false
			}
		}
		switch {
		case a.trig && a.red:
			// a already collected the rebate.
			if b.trig && b.red {
				return a.cost <= b.cost
			}
			// b may still collect R later; a must be cheaper even so.
			return a.cost <= b.cost-R
		case a.trig && !a.red:
			// a still has a pending rebate redemption.
			return b.trig && !b.red && a.cost <= b.cost
		default: // !a.trig
			if b.trig {
				return false
			}
			// Both untriggered. a dominates b when a is at least as
			// close to the threshold (a.cumNet >= b.cumNet: then b can
			// never trigger the rebate without a triggering it too), or
			// when a is cheaper by at least the rebate amount, so a
			// stays better even if b alone triggers the rebate.
			if a.cost > b.cost {
				return false
			}
			return a.cumNet >= b.cumNet || a.cost <= b.cost-R
		}
	}

	insert := func(l *label) bool {
		lb, ok := lbOf(l)
		if !ok {
			return false // cannot reach End at all
		}
		if best.Found && lb > best.Cost {
			return false // cannot improve on the best feasible solution
		}
		set := open[l.node]
		kept := set[:0]
		for _, o := range set {
			if !o.alive {
				continue
			}
			if dominates(o, l) {
				open[l.node] = kept
				return false
			}
			if dominates(l, o) {
				o.alive = false
				continue
			}
			kept = append(kept, o)
		}
		l.alive = true
		l.seq = seq
		seq++
		open[l.node] = append(kept, l)
		heap.Push(pq, l)
		return true
	}

	start := &label{
		node:    p.Start,
		visited: 1 << uint(p.Start),
		used:    -1,
	}
	if p.fuelConstrained() {
		start.fuel = p.Fuel.Start
	}
	// Degenerate threshold: triggered (and possibly redeemed) at start.
	if start.cumNet >= p.Rebate.Threshold {
		start.trig = true
		if len(p.Rebate.Stations) == 0 || p.isRebateStation(p.Start) {
			start.red = true
			start.cost -= R
		}
	}
	insert(start)

	recordSolution := func(l *label) {
		if !best.Found || l.cost < best.Cost || (l.cost == best.Cost && l.time < best.Time) {
			best.Found = true
			best.Cost = l.cost
			best.Time = l.time
			best.Path = append([]int(nil), l.edges...)
		}
	}

	for pq.Len() > 0 {
		if budget > 0 && res.Expansions >= budget {
			res.Exhausted = true
			break
		}
		l := heap.Pop(pq).(*label)
		if !l.alive {
			continue
		}
		if best.Found {
			if lb, ok := lbOf(l); !ok || lb > best.Cost {
				l.alive = false
				continue
			}
		}
		res.Expansions++
		if l.node == p.End {
			recordSolution(l)
			continue
		}
		u := l.node
		// Refuel transitions: buy any integer amount at a fuel station.
		if p.fuelConstrained() {
			if price, ok := p.fuelPriceAt(u); ok {
				for buy := int64(1); l.fuel+buy <= p.Fuel.Capacity; buy++ {
					nl := l.clone()
					nl.fuel += buy
					nl.cost += buy * price
					insert(nl)
				}
			}
		}
		// Edge transitions, optionally applying one earned coupon.
		for _, eid := range adj[u] {
			e := p.Edges[eid]
			bit := uint32(1) << uint(e.To)
			if l.visited&bit != 0 {
				continue // simple paths only
			}
			if popcount32(l.visited)+1 > p.MaxNodes {
				continue
			}
			if p.fuelConstrained() && l.fuel < e.Fuel {
				continue
			}
			choices := []int{-1}
			if l.used == -1 {
				for c := range p.Coupons {
					if l.prog[c] == p.fullMask(c) {
						choices = append(choices, c)
					}
				}
			}
			for _, choice := range choices {
				nl := l.clone()
				nl.node = e.To
				nl.visited |= bit
				nl.fuel -= e.Fuel
				nl.time += e.Time
				nl.edges = append(nl.edges, eid)
				toll := e.Toll
				if choice >= 0 {
					d := p.Coupons[choice].Discount
					if d > toll {
						d = toll
					}
					toll -= d
					nl.used = choice
				}
				if !nl.trig {
					nl.cumNet += toll
					if nl.cumNet >= p.Rebate.Threshold {
						nl.trig = true
					}
				}
				nl.cost += toll
				for c := range p.Coupons {
					if pos := bitIdx[eid][c]; pos >= 0 {
						nl.prog[c] |= 1 << uint(pos)
					}
				}
				// Rebate redemption on arrival (designated stations
				// only; immediate when no stations are configured).
				if nl.trig && !nl.red &&
					(len(p.Rebate.Stations) == 0 || p.isRebateStation(e.To)) {
					nl.red = true
					nl.cost -= R
				}
				insert(nl)
			}
		}
	}

	res.Found = best.Found
	res.Cost = best.Cost
	res.Time = best.Time
	res.Path = best.Path
	if res.Found {
		// Re-simulate the chosen path to get the exact per-edge cost
		// process; the simulator picks the best coupon application for
		// the path, so its cost may improve on the label's cost when
		// the budget stopped the search early.
		res.Sim = p.Simulate(res.Path)
		if res.Sim.OK {
			res.Cost = res.Sim.Cost
			res.Time = res.Sim.Time
		}
	}
	if !res.Exhausted {
		// Queue drained: the best feasible solution is optimal.
		if res.Found {
			res.LowerBound = res.Cost
		}
		return res
	}
	// Budget exhausted: lower bound over the still-open labels.
	const inf = int64(1) << 62
	lb := inf
	for _, l := range *pq {
		if !l.alive {
			continue
		}
		d := tollDist[l.node]
		if d < 0 {
			continue
		}
		cand := l.cost + d
		if !l.red {
			cand -= R
		}
		if l.used == -1 {
			cand -= maxDisc
		}
		if cand < lb {
			lb = cand
		}
	}
	if lb == inf {
		lb = res.Cost // no open label can improve
	}
	if res.Found && lb > res.Cost {
		lb = res.Cost
	}
	res.LowerBound = lb
	return res
}

func (l *label) clone() *label {
	nl := *l
	nl.edges = append([]int(nil), l.edges...)
	nl.hidx = 0
	return &nl
}

// labelHeap is a best-first priority queue ordered by (cost, time, seq).
type labelHeap []*label

func (h labelHeap) Len() int { return len(h) }
func (h labelHeap) Less(i, j int) bool {
	if h[i].cost != h[j].cost {
		return h[i].cost < h[j].cost
	}
	if h[i].time != h[j].time {
		return h[i].time < h[j].time
	}
	return h[i].seq < h[j].seq
}
func (h labelHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].hidx = i
	h[j].hidx = j
}
func (h *labelHeap) Push(x any) {
	l := x.(*label)
	l.hidx = len(*h)
	*h = append(*h, l)
}
func (h *labelHeap) Pop() any {
	old := *h
	n := len(old)
	l := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return l
}
