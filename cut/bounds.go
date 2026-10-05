package cut

import "sort"

// ComputeBounds returns lower/upper bounds on the total budget
// (purchase + cut cost) for a job.
//
// Lower bound: every piece consumes length+kerf on its bar, so bars must
// cover S = sum(pieces)+N*kerf; inventory covers part for free; each
// purchased unit of length costs at least min(cost_i/length_i).
// Upper bound: a greedy first-fit-decreasing feasible plan.
// Upper is -1 when the greedy heuristic finds no feasible plan.
func ComputeBounds(job Job) Bounds {
	pieces := expandPieces(job)
	n := len(pieces)
	if n == 0 {
		return Bounds{0, 0}
	}
	cutMoney := n * job.CutCost
	sum := 0
	for _, p := range pieces {
		sum += p.length
	}
	need := sum + n*job.Kerf
	invTotal := 0
	for _, b := range job.Inventory {
		invTotal += b.Length
	}
	lower := cutMoney
	if rem := need - invTotal; rem > 0 && len(job.StockTypes) > 0 {
		// type minimizing cost/length, compared exactly
		bi := 0
		for i, t := range job.StockTypes {
			b := job.StockTypes[bi]
			if t.Cost*b.Length < b.Cost*t.Length {
				bi = i
			}
		}
		bt := job.StockTypes[bi]
		lower += (rem*bt.Cost + bt.Length - 1) / bt.Length
	}
	return Bounds{Lower: lower, Upper: greedyUpper(job, pieces, cutMoney)}
}

// greedyUpper tries several purchase strategies with first-fit-decreasing
// and returns the cheapest feasible total, or -1 if none works.
func greedyUpper(job Job, pieces []piece, cutMoney int) int {
	maxBars, err := normMaxBars(job)
	if err != nil {
		return -1
	}
	best := -1
	try := func(allowed []int) {
		purch, ok := greedyFFD(job, pieces, maxBars, allowed)
		if ok && (best < 0 || purch < best) {
			best = purch
		}
	}
	for ti := range job.StockTypes {
		try([]int{ti})
	}
	all := make([]int, len(job.StockTypes))
	for i := range all {
		all[i] = i
	}
	try(all)
	if best < 0 {
		return -1
	}
	return best + cutMoney
}

// greedyFFD packs pieces (already sorted desc) into inventory bars first,
// then buys bars of the allowed types (cheapest fitting first).
func greedyFFD(job Job, pieces []piece, maxBars int, allowed []int) (int, bool) {
	type obar struct{ length, used int }
	var bars []obar
	for _, b := range job.Inventory {
		bars = append(bars, obar{length: b.Length})
	}
	sort.Slice(bars, func(i, j int) bool { return bars[i].length > bars[j].length })
	open := 0 // number of bars currently open
	purchase := 0
	for _, p := range pieces {
		need := p.length + job.Kerf
		placed := false
		for i := 0; i < open; i++ {
			if bars[i].used+need <= bars[i].length {
				bars[i].used += need
				placed = true
				break
			}
		}
		if placed {
			continue
		}
		if open >= maxBars {
			return 0, false
		}
		if open < len(bars) {
			if bars[open].length < need {
				return 0, false
			}
			bars[open].used = need
			open++
			continue
		}
		// buy cheapest allowed type that fits
		chosen := -1
		for _, ti := range allowed {
			t := job.StockTypes[ti]
			if t.Length < need {
				continue
			}
			if chosen < 0 || t.Cost < job.StockTypes[chosen].Cost {
				chosen = ti
			}
		}
		if chosen < 0 {
			return 0, false
		}
		t := job.StockTypes[chosen]
		bars = append(bars, obar{length: t.Length, used: need})
		open++
		purchase += t.Cost
	}
	return purchase, true
}
