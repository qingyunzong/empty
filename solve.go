package recipe

// Result is the outcome of Solve.
type Result struct {
	Found   bool  // a feasible recipe was found
	Optimal bool  // search completed: Found/Cost are proven optimal
	Counts  []int // best recipe (valid only if Found)
	Eval    Eval  // exact totals of Counts
	Order   []int // legal processing order certificate for Counts
	Lower   Rat   // best proven lower bound on the optimal cost
	Upper   Rat   // incumbent cost (valid only if Found)
	Nodes   int64 // search nodes visited
}

// Solve minimizes (cost, types) lexicographically over integer recipes
// 0..MaxUnits per ingredient, at most MaxTypes distinct ingredients,
// satisfying weight and nutrient intervals in both scenarios, mutex and
// precedence constraints. budget is the maximum number of search nodes;
// a negative budget means unlimited. If the budget is exhausted the
// result carries the best known cost bounds: Lower <= optimum <= Upper.
func Solve(in *Instance, budget int64) Result {
	s := &solver{in: in, budget: budget}
	n := len(in.Ingredients)
	counts := make([]int, n)
	nut := [NumScenarios][]Rat{
		make([]Rat, in.NumNutrients()),
		make([]Rat, in.NumNutrients()),
	}
	for k := range nut[0] {
		nut[0][k] = Zero()
		nut[1][k] = Zero()
	}
	s.search(0, counts, Zero(), Zero(), nut, 0)

	res := Result{Found: s.found, Optimal: !s.exhausted, Nodes: s.nodes}
	if s.found {
		res.Counts = s.bestCounts
		res.Eval = s.bestEval
		res.Upper = s.bestEval.Cost
		res.Order, _ = in.TopoOrder(s.bestCounts)
	}
	switch {
	case !s.exhausted && s.found:
		res.Lower = s.bestEval.Cost
	case s.lbSet:
		res.Lower = s.lb
		if s.found && s.bestEval.Cost.Cmp(s.lb) < 0 {
			res.Lower = s.bestEval.Cost
		}
	default:
		res.Lower = Zero()
	}
	return res
}

type solver struct {
	in         *Instance
	budget     int64
	nodes      int64
	exhausted  bool
	bestCounts []int
	bestEval   Eval
	found      bool
	lb         Rat
	lbSet      bool
}

func (s *solver) cut(lb Rat) {
	if !s.lbSet || lb.Cmp(s.lb) < 0 {
		s.lb = lb
		s.lbSet = true
	}
}

func (s *solver) search(i int, counts []int, cost, weight Rat, nut [NumScenarios][]Rat, types int) {
	in := s.in
	s.nodes++

	// Children mutate nut in place; give this level a private copy so
	// sibling count iterations and the caller keep correct totals.
	nut = [NumScenarios][]Rat{
		append([]Rat(nil), nut[0]...),
		append([]Rat(nil), nut[1]...),
	}

	// Max-side pruning: totals only grow, so any overflow is permanent.
	if weight.Cmp(in.WeightMax) > 0 || types > in.MaxTypes {
		return
	}
	for sc := 0; sc < NumScenarios; sc++ {
		for k := 0; k < in.NumNutrients(); k++ {
			if nut[sc][k].Cmp(in.NutMax[k]) > 0 {
				return
			}
		}
	}

	// Lower bound on the cost of any completion of this node.
	add, ok := s.lbAdd(i, weight, nut)
	if !ok {
		return // minimums unreachable from here: infeasible subtree
	}
	nodeLB := cost.Add(add)
	if s.found {
		if c := nodeLB.Cmp(s.bestEval.Cost); c > 0 || (c == 0 && types >= s.bestEval.Types) {
			s.cut(nodeLB)
			return
		}
	}

	if s.budget >= 0 && s.nodes > s.budget {
		s.exhausted = true
		s.cut(nodeLB)
		return
	}

	n := len(in.Ingredients)
	if i == n {
		// Leaf: minimums, then precedence certificate.
		if weight.Cmp(in.WeightMin) < 0 {
			return
		}
		for sc := 0; sc < NumScenarios; sc++ {
			for k := 0; k < in.NumNutrients(); k++ {
				if nut[sc][k].Cmp(in.NutMin[k]) < 0 {
					return
				}
			}
		}
		if _, ok := in.TopoOrder(counts); !ok {
			return
		}
		ev := in.Evaluate(counts)
		if !s.found || betterEval(ev, s.bestEval) {
			s.found = true
			s.bestEval = ev
			s.bestCounts = append([]int(nil), counts...)
		}
		return
	}

	// Mutex: if a lower-indexed partner of ingredient i is already used,
	// ingredient i is forced to zero.
	zeroOnly := false
	for _, p := range in.Mutex {
		var partner = -1
		if p[0] == i {
			partner = p[1]
		} else if p[1] == i {
			partner = p[0]
		}
		if partner >= 0 && partner < i && counts[partner] > 0 {
			zeroOnly = true
			break
		}
	}

	ing := in.Ingredients[i]
	nk := in.NumNutrients()
	maxC := in.MaxUnits
	if zeroOnly {
		maxC = 0
	}
	for c := 0; c <= maxC; c++ {
		if c > 0 {
			// Add one more unit of ingredient i to the running totals.
			cost = cost.Add(ing.Cost)
			weight = weight.Add(ing.Weight)
			for sc := 0; sc < NumScenarios; sc++ {
				for k := 0; k < nk; k++ {
					nut[sc][k] = nut[sc][k].Add(ing.Nut[sc][k])
				}
			}
			counts[i] = c
			// Overflow only worsens with larger c: stop the count loop.
			if weight.Cmp(in.WeightMax) > 0 {
				break
			}
			overflow := false
			for sc := 0; sc < NumScenarios && !overflow; sc++ {
				for k := 0; k < nk; k++ {
					if nut[sc][k].Cmp(in.NutMax[k]) > 0 {
						overflow = true
						break
					}
				}
			}
			if overflow {
				break
			}
		}
		newTypes := types
		if c > 0 {
			newTypes++
		}
		s.search(i+1, counts, cost, weight, nut, newTypes)
		if s.exhausted {
			// Unexplored sibling subtrees are abandoned here. This
			// node's lower bound dominates every descendant's, so it
			// keeps the global lower bound sound.
			s.cut(nodeLB)
			counts[i] = 0
			return
		}
	}
	counts[i] = 0
}

// lbAdd computes a lower bound on the additional cost needed to reach
// all minimums from the current partial totals, using only ingredients
// i..n-1. For each deficit it uses the best nutrient-per-cost ratio
// among remaining ingredients (a relaxation, hence a valid bound), and
// takes the max over all deficits. It also proves infeasibility when
// even MaxUnits of every remaining ingredient cannot meet a minimum.
func (s *solver) lbAdd(i int, weight Rat, nut [NumScenarios][]Rat) (Rat, bool) {
	in := s.in
	n := len(in.Ingredients)
	nk := in.NumNutrients()
	worst := Zero()

	consider := func(deficit Rat, amount func(j int) Rat) bool {
		if deficit.Sign() <= 0 {
			return true
		}
		// Capacity check: maximum still-achievable amount.
		capTot := Zero()
		for j := i; j < n; j++ {
			capTot = capTot.Add(amount(j).MulInt(int64(in.MaxUnits)))
		}
		if capTot.Cmp(deficit) < 0 {
			return false
		}
		// Cheapest cost per unit of this nutrient among remaining ingredients.
		bestSet := false
		var best Rat
		for j := i; j < n; j++ {
			a := amount(j)
			if a.Sign() <= 0 {
				continue
			}
			c := deficit.Mul(in.Ingredients[j].Cost).Div(a)
			if !bestSet || c.Cmp(best) < 0 {
				best = c
				bestSet = true
			}
		}
		if bestSet && best.Cmp(worst) > 0 {
			worst = best
		}
		return true
	}

	if !consider(in.WeightMin.Sub(weight), func(j int) Rat { return in.Ingredients[j].Weight }) {
		return Rat{}, false
	}
	for sc := 0; sc < NumScenarios; sc++ {
		sc := sc
		for k := 0; k < nk; k++ {
			k := k
			if !consider(in.NutMin[k].Sub(nut[sc][k]), func(j int) Rat { return in.Ingredients[j].Nut[sc][k] }) {
				return Rat{}, false
			}
		}
	}
	return worst, true
}
