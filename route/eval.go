package route

import (
	"fmt"
	"math"
	"strings"
)

// Step is the per-edge ledger entry of an evaluated path.
type Step struct {
	From, To   string
	Toll, Time int
	Dist       int
	FuelBefore int // fuel held at From after refuel there
	RefuelAt   int // units bought at From before this edge
	RefuelCost int
	FuelAfter  int // fuel on arrival at To (before refuel there)
	CumToll    int // cumulative toll after paying this edge
	RebateHere int // rebate redeemed on arrival at To (0 if none)
	PaidCum    int // running paid total after this edge (coupon applied at end)
}

// EvalResult is the exact cost of one concrete path.
type EvalResult struct {
	OK         bool
	Reason     string // why infeasible, if !OK
	Path       []string
	Steps      []Step
	TollSum    int
	FuelCost   int
	Rebate     int // redeemed rebate (0 or Rebate.Amount)
	RebateAt   string
	CouponID   string // applied coupon (mutually exclusive: at most one)
	CouponDisc int
	Paid       int // TollSum + FuelCost - Rebate - CouponDisc
	Time       int
	RefuelPlan []int // units bought per position in Path
}

// better reports whether a is lexicographically better than b (paid, then time).
func better(aPaid, aTime, bPaid, bTime int) bool {
	return aPaid < bPaid || (aPaid == bPaid && aTime < bTime)
}

// EvalPath evaluates a concrete node path exactly.
//
// Fuel feasibility and the cheapest refuel plan for this exact path are
// computed by a small DP over (position, fuel). The rebate is redeemed once,
// at the first designated station reached after the cumulative toll threshold
// is met; it is a path-level event, never a negative edge. Coupons depend on
// the traveled edge set and are mutually exclusive, so the best eligible
// coupon (if any) is applied.
func (n *Network) EvalPath(path []int) EvalResult {
	res := EvalResult{Path: n.PathNodeIDs(path)}
	if len(path) < 2 {
		res.Reason = "path needs at least 2 nodes"
		return res
	}
	edges := make([]int, len(path)-1)
	var edgeMask uint64
	for i := 0; i+1 < len(path); i++ {
		ei, ok := n.edgeIdx[[2]int{path[i], path[i+1]}]
		if !ok {
			res.Reason = fmt.Sprintf("no edge %s->%s", n.NodeID(path[i]), n.NodeID(path[i+1]))
			return res
		}
		edges[i] = ei
		edgeMask |= 1 << uint(ei)
	}
	// Fuel DP. cur[f] = min refuel cost so far to arrive at the current
	// position with f fuel (before refuel there).
	C := n.Fuel.Capacity
	const inf = math.MaxInt32 / 4
	cur := make([]int, C+1)
	for f := range cur {
		cur[f] = inf
	}
	cur[n.Fuel.Start] = 0
	plans := make([][]int, len(path)) // plans[i][f] = units bought at pos i to hold f
	for i := 0; i < len(path); i++ {
		v := path[i]
		best := make([]int, C+1)
		bought := make([]int, C+1)
		if price, ok := n.FuelPriceAt(v); ok {
			for f := range best {
				best[f] = inf
			}
			for g := 0; g <= C; g++ {
				if cur[g] >= inf {
					continue
				}
				for f := g; f <= C; f++ {
					if c := cur[g] + (f-g)*price; c < best[f] {
						best[f] = c
						bought[f] = f - g
					}
				}
			}
		} else {
			copy(best, cur)
		}
		plans[i] = bought
		cur = best
		if i == len(path)-1 {
			break
		}
		e := n.Edges[edges[i]]
		next := make([]int, C+1)
		for f := range next {
			next[f] = inf
		}
		for f := e.Dist; f <= C; f++ {
			if best[f] < inf {
				next[f-e.Dist] = best[f]
			}
		}
		cur = next
	}
	arrFuel, arrCost := -1, inf
	for f := 0; f <= C; f++ {
		if cur[f] < arrCost {
			arrCost = cur[f]
			arrFuel = f
		}
	}
	if arrFuel < 0 {
		res.Reason = "fuel infeasible"
		return res
	}
	res.FuelCost = arrCost
	// Recover the refuel plan backwards: if position i holds f after refuel,
	// it arrived with f-plan[i]; the previous position held that plus dist.
	plan := make([]int, len(path))
	fuelAt := make([]int, len(path))
	f := arrFuel
	for i := len(path) - 1; i >= 0; i-- {
		plan[i] = plans[i][f]
		fuelAt[i] = f
		if i > 0 {
			f = f - plan[i] + n.Edges[edges[i-1]].Dist
		}
	}
	res.RefuelPlan = plan

	// Simulate tolls, rebate redemption and the per-edge ledger.
	threshold, amount, hasRebate := n.RebateInfo()
	cum, paid := 0, 0
	rebateDone := false
	for i := 0; i+1 < len(path); i++ {
		e := n.Edges[edges[i]]
		st := Step{
			From: n.NodeID(path[i]), To: n.NodeID(path[i+1]),
			Toll: e.Toll, Time: e.Time, Dist: e.Dist,
			RefuelAt: plan[i], FuelBefore: fuelAt[i],
		}
		if plan[i] > 0 {
			price, _ := n.FuelPriceAt(path[i])
			st.RefuelCost = plan[i] * price
		}
		paid += st.RefuelCost + e.Toll
		cum += e.Toll
		st.CumToll = cum
		st.FuelAfter = fuelAt[i] - e.Dist
		if to := path[i+1]; hasRebate && !rebateDone && cum >= threshold && n.IsStation(to) {
			rebateDone = true
			paid -= amount
			st.RebateHere = amount
			res.Rebate = amount
			res.RebateAt = n.NodeID(to)
		}
		st.PaidCum = paid
		res.Steps = append(res.Steps, st)
		res.TollSum += e.Toll
		res.Time += e.Time
	}
	// Coupons: mutually exclusive, eligible by traveled edge set.
	bestDisc, bestID := 0, ""
	for ci, c := range n.Coupons {
		if n.couponReq[ci]&^edgeMask == 0 && c.Discount > bestDisc {
			bestDisc, bestID = c.Discount, c.ID
		}
	}
	res.CouponID, res.CouponDisc = bestID, bestDisc
	res.Paid = paid - bestDisc
	res.OK = true
	return res
}

// Ledger renders the per-edge cost process of an evaluated path.
func (r EvalResult) Ledger() string {
	if !r.OK {
		return "infeasible: " + r.Reason
	}
	var b strings.Builder
	fmt.Fprintf(&b, "path: %s\n", strings.Join(r.Path, " -> "))
	for i, s := range r.Steps {
		fmt.Fprintf(&b, "  edge %d %s->%s: toll=%d time=%d dist=%d", i+1, s.From, s.To, s.Toll, s.Time, s.Dist)
		if s.RefuelAt > 0 {
			fmt.Fprintf(&b, " | refuel@%s +%d units cost=%d", s.From, s.RefuelAt, s.RefuelCost)
		}
		fmt.Fprintf(&b, " | fuel %d->%d | cumToll=%d", s.FuelBefore, s.FuelAfter, s.CumToll)
		if s.RebateHere > 0 {
			fmt.Fprintf(&b, " | REBATE -%d redeemed at %s", s.RebateHere, s.To)
		}
		fmt.Fprintf(&b, " | paidSoFar=%d\n", s.PaidCum)
	}
	fmt.Fprintf(&b, "  totals: tolls=%d fuel=%d", r.TollSum, r.FuelCost)
	if r.Rebate > 0 {
		fmt.Fprintf(&b, " rebate=-%d(@%s)", r.Rebate, r.RebateAt)
	}
	if r.CouponDisc > 0 {
		fmt.Fprintf(&b, " coupon %s=-%d", r.CouponID, r.CouponDisc)
	}
	fmt.Fprintf(&b, " => paid=%d time=%d\n", r.Paid, r.Time)
	return b.String()
}
