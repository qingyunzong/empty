package recipe

import "testing"

// lcg is a deterministic pseudo-random generator for test instances.
type lcg struct{ x uint64 }

func (l *lcg) next() uint64 {
	l.x = l.x*6364136223846793005 + 1442695040888963407
	return l.x >> 33
}
func (l *lcg) intn(n int) int { return int(l.next() % uint64(n)) }

// randInstance builds a deterministic small instance with fractional
// costs/nutrients, optional mutex pairs and a priori acyclic precedence
// edges (only i -> j with i < j).
func randInstance(seed uint64, nIng, nNut, maxUnits int) *Instance {
	r := &lcg{x: seed*2654435761 + 1}
	in := &Instance{
		NutrientNames: make([]string, nNut),
		WeightMin:     Zero(),
		WeightMax:     RatFromInt(1000),
		NutMin:        make([]Rat, nNut),
		NutMax:        make([]Rat, nNut),
		MaxTypes:      8,
		MaxUnits:      maxUnits,
	}
	for k := 0; k < nNut; k++ {
		in.NutMin[k] = NewRat(int64(2+r.intn(5)), 1)
		in.NutMax[k] = RatFromInt(400)
	}
	for i := 0; i < nIng; i++ {
		ing := Ingredient{
			Name:   string(rune('A' + i)),
			Cost:   NewRat(int64(1+r.intn(9)), int64(1+r.intn(3))),
			Weight: NewRat(int64(1+r.intn(5)), 1),
		}
		for s := 0; s < NumScenarios; s++ {
			ing.Nut[s] = make([]Rat, nNut)
			for k := 0; k < nNut; k++ {
				ing.Nut[s][k] = NewRat(int64(r.intn(5)), int64(1+r.intn(2)))
			}
		}
		in.Ingredients = append(in.Ingredients, ing)
	}
	for i := 0; i < nIng; i++ {
		for j := i + 1; j < nIng; j++ {
			switch r.intn(20) {
			case 0:
				in.Mutex = append(in.Mutex, [2]int{i, j})
			case 1:
				in.Precedence = append(in.Precedence, [2]int{i, j})
			}
		}
	}
	if err := in.Validate(); err != nil {
		panic(err)
	}
	return in
}

// TestSmallScaleEnumerationCrossCheck compares the branch-and-bound
// solver against the independent brute-force enumerator on many small
// randomized instances (including mutex and precedence constraints).
func TestSmallScaleEnumerationCrossCheck(t *testing.T) {
	for seed := uint64(1); seed <= 60; seed++ {
		nIng := 3 + int(seed%3)
		nNut := 1 + int(seed%3)
		in := randInstance(seed, nIng, nNut, 3)
		res := Solve(in, -1)
		best, ev, found := BruteForce(in)
		if res.Found != found {
			t.Fatalf("seed %d: solver found=%v, brute found=%v", seed, res.Found, found)
		}
		if !res.Optimal {
			t.Fatalf("seed %d: unlimited budget must prove optimality", seed)
		}
		if !found {
			continue
		}
		if res.Eval.Cost.Cmp(ev.Cost) != 0 || res.Eval.Types != ev.Types {
			t.Fatalf("seed %d: solver (%s,%d) != brute (%s,%d)",
				seed, res.Eval.Cost, res.Eval.Types, ev.Cost, ev.Types)
		}
		if err := in.CheckFeasible(res.Counts); err != nil {
			t.Fatalf("seed %d: solver returned infeasible recipe: %v", seed, err)
		}
		if err := in.CheckFeasible(best); err != nil {
			t.Fatalf("seed %d: brute returned infeasible recipe: %v", seed, err)
		}
		if !in.VerifyOrder(res.Counts, res.Order) {
			t.Fatalf("seed %d: invalid processing-order certificate", seed)
		}
		if res.Lower.Cmp(res.Upper) != 0 {
			t.Fatalf("seed %d: completed search must have Lower==Upper, got %s vs %s",
				seed, res.Lower, res.Upper)
		}
	}
}

// TestExtremalBoundary checks acceptance exactly at interval endpoints
// and at the 0/30 unit extremes, with exact fractional arithmetic.
func TestExtremalBoundary(t *testing.T) {
	mk := func(nutMin, nutMax Rat, maxUnits int) *Instance {
		return &Instance{
			Ingredients: []Ingredient{{
				Name:   "A",
				Cost:   NewRat(1, 3),
				Weight: NewRat(1, 2),
				Nut:    [NumScenarios][]Rat{{NewRat(3, 2)}, {NewRat(3, 2)}},
			}},
			NutrientNames: []string{"protein"},
			WeightMin:     Zero(),
			WeightMax:     RatFromInt(15),
			NutMin:        []Rat{nutMin},
			NutMax:        []Rat{nutMax},
			MaxTypes:      8,
			MaxUnits:      maxUnits,
		}
	}
	// Exactly 30 units hit nutrient min == max == 45 and weight 15.
	in := mk(NewRat(45, 1), NewRat(45, 1), 30)
	res := Solve(in, -1)
	if !res.Found || res.Counts[0] != 30 {
		t.Fatalf("want exactly 30 units, got found=%v counts=%v", res.Found, res.Counts)
	}
	if res.Eval.Cost.Cmp(RatFromInt(10)) != 0 {
		t.Fatalf("cost should be exactly 10, got %s", res.Eval.Cost)
	}
	if res.Eval.Weight.Cmp(RatFromInt(15)) != 0 {
		t.Fatalf("weight should be exactly 15, got %s", res.Eval.Weight)
	}
	// One unit above the cap: 31 units needed, only 30 allowed.
	in2 := mk(NewRat(93, 2), RatFromInt(1000), 30)
	if res2 := Solve(in2, -1); res2.Found {
		t.Fatalf("infeasible instance solved: %v", res2.Counts)
	}
	if _, _, found := BruteForce(in2); found {
		t.Fatal("brute force disagrees on infeasibility")
	}
	// Zero units is feasible when all minimums are zero.
	in3 := mk(Zero(), RatFromInt(1000), 30)
	res3 := Solve(in3, -1)
	if !res3.Found || res3.Eval.Types != 0 || res3.Eval.Cost.Cmp(Zero()) != 0 {
		t.Fatalf("empty recipe should win: %+v", res3.Eval)
	}
}

// TestTwoScenarios ensures a recipe must satisfy BOTH potency scenarios:
// the cheap ingredient that only works in scenario 1 must not be chosen.
func TestTwoScenarios(t *testing.T) {
	in := &Instance{
		Ingredients: []Ingredient{
			{Name: "cheap", Cost: RatFromInt(1), Weight: RatFromInt(1),
				Nut: [NumScenarios][]Rat{{RatFromInt(4)}, {NewRat(1, 2)}}},
			{Name: "steady", Cost: RatFromInt(2), Weight: RatFromInt(1),
				Nut: [NumScenarios][]Rat{{RatFromInt(2)}, {RatFromInt(2)}}},
		},
		NutrientNames: []string{"vitamin"},
		WeightMin:     Zero(),
		WeightMax:     RatFromInt(100),
		NutMin:        []Rat{RatFromInt(6)},
		NutMax:        []Rat{RatFromInt(1000)},
		MaxTypes:      8,
		MaxUnits:      30,
	}
	// 6 units of "cheap" satisfy scenario 1 (24 >= 6) but fail scenario 2 (3 < 6).
	if err := in.CheckFeasible([]int{6, 0}); err == nil {
		t.Fatal("cheap-only recipe must be rejected (fails scenario 2)")
	}
	res := Solve(in, -1)
	if !res.Found {
		t.Fatal("instance is feasible")
	}
	// Optimum: 3 x steady (cost 6) beats 12 x cheap (cost 12).
	if res.Counts[0] != 0 || res.Counts[1] != 3 || res.Eval.Cost.Cmp(RatFromInt(6)) != 0 {
		t.Fatalf("want 3x steady cost 6, got counts=%v cost=%s", res.Counts, res.Eval.Cost)
	}
	// Dual-scenario ratios of the reported recipe.
	if res.Eval.Nut[0][0].Cmp(RatFromInt(6)) != 0 || res.Eval.Nut[1][0].Cmp(RatFromInt(6)) != 0 {
		t.Fatalf("scenario totals wrong: %s / %s", res.Eval.Nut[0][0], res.Eval.Nut[1][0])
	}
}

// TestMutex ensures mutually exclusive ingredients never co-occur, even
// when combining them would be cheapest.
func TestMutex(t *testing.T) {
	base := func() *Instance {
		return &Instance{
			Ingredients: []Ingredient{
				{Name: "A", Cost: RatFromInt(1), Weight: RatFromInt(1),
					Nut: [NumScenarios][]Rat{{RatFromInt(3)}, {RatFromInt(3)}}},
				{Name: "B", Cost: RatFromInt(1), Weight: RatFromInt(1),
					Nut: [NumScenarios][]Rat{{RatFromInt(3)}, {RatFromInt(3)}}},
				{Name: "C", Cost: RatFromInt(5), Weight: RatFromInt(1),
					Nut: [NumScenarios][]Rat{{RatFromInt(6)}, {RatFromInt(6)}}},
			},
			NutrientNames: []string{"n"},
			WeightMin:     Zero(),
			WeightMax:     RatFromInt(100),
			NutMin:        []Rat{RatFromInt(6)},
			NutMax:        []Rat{RatFromInt(1000)},
			MaxTypes:      8,
			MaxUnits:      1,
		}
	}
	noMutex := base()
	if res := Solve(noMutex, -1); !res.Found || res.Eval.Cost.Cmp(RatFromInt(2)) != 0 {
		t.Fatalf("without mutex want cost 2 (A+B), got %s", res.Eval.Cost)
	}
	withMutex := base()
	withMutex.Mutex = [][2]int{{0, 1}}
	res := Solve(withMutex, -1)
	if !res.Found || res.Eval.Cost.Cmp(RatFromInt(5)) != 0 || res.Counts[2] != 1 {
		t.Fatalf("with mutex want C only, cost 5; got counts=%v cost=%s", res.Counts, res.Eval.Cost)
	}
	if res.Counts[0] > 0 && res.Counts[1] > 0 {
		t.Fatal("mutex pair used together")
	}
	if _, _, found := BruteForce(withMutex); !found {
		t.Fatal("brute force disagrees")
	}
}

// TestPrecedenceCertificate checks the topological processing-order
// certificate and infeasibility under a precedence cycle.
func TestPrecedenceCertificate(t *testing.T) {
	mk := func() *Instance {
		return &Instance{
			Ingredients: []Ingredient{
				{Name: "X", Cost: RatFromInt(1), Weight: RatFromInt(1),
					Nut: [NumScenarios][]Rat{{RatFromInt(1), RatFromInt(0)}, {RatFromInt(1), RatFromInt(0)}}},
				{Name: "Y", Cost: RatFromInt(1), Weight: RatFromInt(1),
					Nut: [NumScenarios][]Rat{{RatFromInt(0), RatFromInt(1)}, {RatFromInt(0), RatFromInt(1)}}},
			},
			NutrientNames: []string{"p", "q"},
			WeightMin:     Zero(),
			WeightMax:     RatFromInt(100),
			NutMin:        []Rat{RatFromInt(1), RatFromInt(1)},
			NutMax:        []Rat{RatFromInt(1000), RatFromInt(1000)},
			MaxTypes:      8,
			MaxUnits:      30,
			Precedence:    [][2]int{{0, 1}}, // X before Y
		}
	}
	in := mk()
	res := Solve(in, -1)
	if !res.Found {
		t.Fatal("instance is feasible")
	}
	if !in.VerifyOrder(res.Counts, res.Order) {
		t.Fatalf("certificate rejected: order=%v", res.Order)
	}
	if len(res.Order) != 2 || res.Order[0] != 0 || res.Order[1] != 1 {
		t.Fatalf("want processing order [X Y], got %v", res.Order)
	}
	// A tampered order must fail verification.
	if in.VerifyOrder(res.Counts, []int{1, 0}) {
		t.Fatal("reversed order must fail verification")
	}
	// Adding Y -> X creates a cycle among forced ingredients: infeasible.
	cyc := mk()
	cyc.Precedence = [][2]int{{0, 1}, {1, 0}}
	if res := Solve(cyc, -1); res.Found {
		t.Fatalf("cyclic precedence solved: %v", res.Counts)
	}
	if _, _, found := BruteForce(cyc); found {
		t.Fatal("brute force disagrees on cyclic infeasibility")
	}
}

// TestTieBreakPrefersFewerTypes: equal cost, fewer ingredient types wins.
func TestTieBreakPrefersFewerTypes(t *testing.T) {
	in := &Instance{
		Ingredients: []Ingredient{
			{Name: "A", Cost: RatFromInt(1), Weight: RatFromInt(1),
				Nut: [NumScenarios][]Rat{{RatFromInt(1)}, {RatFromInt(1)}}},
			{Name: "B", Cost: RatFromInt(1), Weight: RatFromInt(1),
				Nut: [NumScenarios][]Rat{{RatFromInt(1)}, {RatFromInt(1)}}},
			{Name: "C", Cost: RatFromInt(2), Weight: RatFromInt(1),
				Nut: [NumScenarios][]Rat{{RatFromInt(2)}, {RatFromInt(2)}}},
		},
		NutrientNames: []string{"n"},
		WeightMin:     Zero(),
		WeightMax:     RatFromInt(100),
		NutMin:        []Rat{RatFromInt(2)},
		NutMax:        []Rat{RatFromInt(1000)},
		MaxTypes:      8,
		MaxUnits:      30,
	}
	res := Solve(in, -1)
	if !res.Found || res.Eval.Cost.Cmp(RatFromInt(2)) != 0 {
		t.Fatalf("want cost 2, got %s", res.Eval.Cost)
	}
	if res.Eval.Types != 1 || res.Counts[2] != 1 {
		t.Fatalf("want single-type recipe C, got counts=%v types=%d", res.Counts, res.Eval.Types)
	}
}

// TestBudgetExhaustionBounds: with tiny node budgets the solver must
// return sound cost bounds, and the independent enumerator confirms the
// true optimum lies inside them, across many instances and budgets.
func TestBudgetExhaustionBounds(t *testing.T) {
	for seed := uint64(7); seed <= 25; seed++ {
		in := randInstance(seed*977+424242, 5, 2, 4)
		full := Solve(in, -1)
		_, ev, found := BruteForce(in)
		if full.Found != found || (found && full.Eval.Cost.Cmp(ev.Cost) != 0) {
			t.Fatalf("seed %d: solver and enumerator disagree on unlimited run", seed)
		}
		for _, budget := range []int64{0, 1, 3, 17, 64} {
			limited := Solve(in, budget)
			if limited.Lower.Sign() < 0 {
				t.Fatalf("seed %d budget %d: negative lower bound", seed, budget)
			}
			if limited.Optimal {
				continue // completed search: exactness checked above
			}
			if !found {
				continue
			}
			// Soundness: Lower <= true optimum <= Upper (if incumbent).
			if limited.Lower.Cmp(ev.Cost) > 0 {
				t.Fatalf("seed %d budget %d: lower bound %s exceeds true optimum %s",
					seed, budget, limited.Lower, ev.Cost)
			}
			if limited.Found && limited.Upper.Cmp(ev.Cost) < 0 {
				t.Fatalf("seed %d budget %d: upper bound %s below true optimum %s",
					seed, budget, limited.Upper, ev.Cost)
			}
			if limited.Found && limited.Lower.Cmp(limited.Upper) > 0 {
				t.Fatalf("seed %d budget %d: lower %s > upper %s",
					seed, budget, limited.Lower, limited.Upper)
			}
		}
	}
	in := randInstance(424242, 5, 2, 4)
	if limited := Solve(in, 3); limited.Optimal {
		t.Fatal("budget of 3 nodes must not prove optimality")
	}
}
