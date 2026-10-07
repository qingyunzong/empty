package recipe

import (
	"math/big"
	"math/rand"
	"testing"
)

func TestCrossMultiplyCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1/3", "2/7", 1},   // 7 > 6
		{"2/7", "1/3", -1},  // 6 < 7
		{"4/6", "6/9", 0},   // 36 == 36
		{"-1/2", "1/3", -1}, // -3 < 2
		{"30", "30", 0},
		{"0", "1/1000000", -1},
	}
	for _, c := range cases {
		if got := cmpRat(rat(c.a), rat(c.b)); got != c.want {
			t.Errorf("cmpRat(%s,%s)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

// randomProblem builds a small deterministic pseudo-random instance
// suitable for both Solve and the independent BruteForce enumerator.
func randomProblem(rng *rand.Rand) *Problem {
	n := 4
	k := 2
	p := &Problem{
		NutrientNames: []string{"n0", "n1"},
		MaxTypes:      2,
		MaxUnits:      3,
		WeightLo:      ratInt(int64(1 + rng.Intn(3))),
		WeightHi:      ratInt(12),
		NutLo:         make([]*big.Rat, k),
		NutHi:         make([]*big.Rat, k),
	}
	for j := 0; j < k; j++ {
		p.NutLo[j] = ratInt(int64(rng.Intn(4)))
		p.NutHi[j] = ratInt(int64(12 + rng.Intn(8)))
	}
	for i := 0; i < n; i++ {
		ing := Ingredient{
			Name:   string(rune('a' + i)),
			Cost:   ratInt(int64(1 + rng.Intn(5))),
			Weight: ratInt(int64(1 + rng.Intn(2))),
		}
		for s := 0; s < NumScenarios; s++ {
			ing.Pot[s] = make([]*big.Rat, k)
			for j := 0; j < k; j++ {
				ing.Pot[s][j] = ratInt(int64(rng.Intn(5)))
			}
		}
		p.Ingredients = append(p.Ingredients, ing)
	}
	if rng.Intn(2) == 0 {
		p.Mutex = [][2]int{{0, 1}}
	}
	if rng.Intn(2) == 0 {
		p.Prec = [][2]int{{0, 2}, {1, 2}}
	}
	return p
}

func TestSolveMatchesIndependentEnumeration(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		p := randomProblem(rand.New(rand.NewSource(seed)))
		res := Solve(p)
		if !res.Optimal {
			t.Fatalf("seed %d: unlimited-budget solve not marked optimal", seed)
		}
		bf := BruteForce(p)
		switch {
		case res.Best == nil && bf == nil:
			// both agree: infeasible
		case res.Best == nil || bf == nil:
			t.Fatalf("seed %d: solver/brute-force disagree on feasibility", seed)
		default:
			if cmpRat(res.Best.Cost, bf.Cost) != 0 || res.Best.Types != bf.Types {
				t.Fatalf("seed %d: solver (cost %s, types %d) != brute force (cost %s, types %d)",
					seed, frac(res.Best.Cost), res.Best.Types, frac(bf.Cost), bf.Types)
			}
			if !VerifyOrder(res.Best.Qty, p.Prec, res.Best.Order) {
				t.Fatalf("seed %d: invalid processing-order certificate", seed)
			}
			if _, err := p.Evaluate(res.Best.Qty); err != nil {
				t.Fatalf("seed %d: solver recipe fails independent Evaluate: %v", seed, err)
			}
		}
	}
}

func TestExtremalBoundaryValues(t *testing.T) {
	// Single ingredient, 30 units exactly saturating the weight ceiling,
	// and a nutrient floor met with an exact rational ratio.
	p := &Problem{
		NutrientNames: []string{"p"},
		MaxTypes:      8,
		MaxUnits:      30,
		WeightLo:      rat("30"),
		WeightHi:      rat("30"),
		NutLo:         []*big.Rat{rat("10")},
		NutHi:         []*big.Rat{rat("10")},
		Ingredients: []Ingredient{
			{Name: "x", Cost: rat("1/3"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("1/3")}, {rat("1/3")}}},
		},
	}
	res := Solve(p)
	if res.Best == nil {
		t.Fatal("boundary recipe at 30 units must be accepted (intervals are inclusive)")
	}
	if res.Best.Qty[0] != 30 {
		t.Fatalf("qty=%d, want exactly 30", res.Best.Qty[0])
	}
	if frac(res.Best.Cost) != "10" || frac(res.Best.Nutrients[0][0]) != "10" {
		t.Fatalf("exact ratios wrong: cost=%s nutrient=%s",
			frac(res.Best.Cost), frac(res.Best.Nutrients[0][0]))
	}

	// One unit beyond the ceiling must be rejected by Evaluate.
	if _, err := p.Evaluate([]int{31}); err == nil {
		t.Fatal("qty 31 must be rejected")
	}
	// Just below the nutrient floor must be rejected.
	if _, err := p.Evaluate([]int{29}); err == nil {
		t.Fatal("qty 29 violates the nutrient floor and must be rejected")
	}
}

func TestTwoScenariosMustBothHold(t *testing.T) {
	// Cheap in scenario 0 only vs cheap in scenario 1 only: no single
	// ingredient can satisfy both scenarios, so the optimum must mix.
	p := &Problem{
		NutrientNames: []string{"p"},
		MaxTypes:      8,
		MaxUnits:      30,
		WeightLo:      rat("0"),
		WeightHi:      rat("100"),
		NutLo:         []*big.Rat{rat("10")},
		NutHi:         []*big.Rat{rat("30")},
		Ingredients: []Ingredient{
			{Name: "A", Cost: rat("1"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("5")}, {rat("1")}}},
			{Name: "B", Cost: rat("1"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("1")}, {rat("5")}}},
		},
	}
	res := Solve(p)
	if res.Best == nil {
		t.Fatal("expected a feasible mixed recipe")
	}
	if res.Best.Types != 2 {
		t.Fatalf("types=%d, want 2 (both scenarios force a mix)", res.Best.Types)
	}
	for s := 0; s < NumScenarios; s++ {
		v := res.Best.Nutrients[s][0]
		if ltRat(v, rat("10")) || gtRat(v, rat("30")) {
			t.Fatalf("scenario %d nutrient %s outside [10,30]", s, frac(v))
		}
	}
	// Sanity: single-ingredient recipes are infeasible here.
	if _, err := p.Evaluate([]int{10, 0}); err == nil {
		t.Fatal("10xA must fail scenario 1 ceiling")
	}
}

func TestMutexAndPrecedenceCertificate(t *testing.T) {
	p := &Problem{
		NutrientNames: []string{"p"},
		MaxTypes:      8,
		MaxUnits:      5,
		WeightLo:      rat("0"),
		WeightHi:      rat("100"),
		NutLo:         []*big.Rat{rat("4")},
		NutHi:         []*big.Rat{rat("100")},
		Ingredients: []Ingredient{
			{Name: "cheap0", Cost: rat("1"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("1")}, {rat("1")}}},
			{Name: "cheap1", Cost: rat("1"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("1")}, {rat("1")}}},
			{Name: "pricey", Cost: rat("3"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("2")}, {rat("2")}}},
		},
		Mutex: [][2]int{{0, 1}},
		Prec:  [][2]int{{2, 0}, {2, 1}},
	}
	res := Solve(p)
	if res.Best == nil {
		t.Fatal("expected feasible recipe")
	}
	if res.Best.Qty[0] > 0 && res.Best.Qty[1] > 0 {
		t.Fatal("mutex pair both used")
	}
	if !VerifyOrder(res.Best.Qty, p.Prec, res.Best.Order) {
		t.Fatal("certificate failed verification")
	}
	// Tampered certificate must be rejected.
	bad := append([]int(nil), res.Best.Order...)
	if len(bad) >= 2 {
		bad[0], bad[len(bad)-1] = bad[len(bad)-1], bad[0]
		if VerifyOrder(res.Best.Qty, p.Prec, bad) && len(res.Best.Order) > 1 {
			// Only acceptable if the swap coincidentally stays legal;
			// force a definitely-illegal certificate instead.
			rev := append([]int(nil), res.Best.Order...)
			for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
				rev[i], rev[j] = rev[j], rev[i]
			}
			if len(p.Prec) > 0 && VerifyOrder(res.Best.Qty, p.Prec, rev) {
				t.Fatal("reversed certificate must be rejected when precedence edges exist among used ingredients")
			}
		}
	}
	// Precedence cycle among used ingredients -> infeasible.
	p.Prec = [][2]int{{0, 1}, {1, 0}}
	p.Mutex = nil
	p.NutLo = []*big.Rat{rat("3")} // forces using 0 and 1 together? both give 1/unit
	p.MaxTypes = 2
	res2 := Solve(p)
	if res2.Best != nil && res2.Best.Qty[0] > 0 && res2.Best.Qty[1] > 0 {
		t.Fatal("cyclic precedence among used ingredients must be infeasible")
	}
}

func TestBudgetExhaustionKeepsBounds(t *testing.T) {
	// Large enough tree that a tiny budget cannot finish.
	p := &Problem{
		NutrientNames: []string{"p"},
		MaxTypes:      8,
		MaxUnits:      30,
		WeightLo:      rat("0"),
		WeightHi:      rat("1000"),
		NutLo:         []*big.Rat{rat("40")},
		NutHi:         []*big.Rat{rat("1000")},
	}
	for i := 0; i < 6; i++ {
		p.Ingredients = append(p.Ingredients, Ingredient{
			Name:   string(rune('a' + i)),
			Cost:   ratInt(int64(i + 1)),
			Weight: ratInt(1),
			Pot: [2][]*big.Rat{
				{ratInt(int64(6 - i))},
				{ratInt(int64(6 - i))},
			},
		})
	}
	full := Solve(p)
	if !full.Optimal || full.Best == nil {
		t.Fatal("unlimited solve should finish and find a recipe")
	}
	limited := Solve(&Problem{
		Ingredients:   p.Ingredients,
		NutrientNames: p.NutrientNames,
		MaxTypes:      p.MaxTypes,
		MaxUnits:      p.MaxUnits,
		WeightLo:      p.WeightLo,
		WeightHi:      p.WeightHi,
		NutLo:         p.NutLo,
		NutHi:         p.NutHi,
		Budget:        40,
	})
	if !limited.Exhausted {
		t.Fatal("tiny budget must exhaust")
	}
	if limited.Optimal {
		t.Fatal("exhausted search must not claim optimality")
	}
	// Certified lower bound must not exceed the true optimum.
	if gtRat(limited.Lower, full.Best.Cost) {
		t.Fatalf("lower bound %s exceeds true optimum %s",
			frac(limited.Lower), frac(full.Best.Cost))
	}
	// If a recipe was found, its cost is a valid upper bound.
	if limited.Best != nil {
		if limited.Upper == nil || cmpRat(limited.Upper, limited.Best.Cost) != 0 {
			t.Fatal("upper bound must equal best found cost")
		}
		if ltRat(limited.Upper, full.Best.Cost) {
			t.Fatalf("upper bound %s below true optimum %s",
				frac(limited.Upper), frac(full.Best.Cost))
		}
		if _, err := p.Evaluate(limited.Best.Qty); err != nil {
			t.Fatalf("incumbent recipe infeasible: %v", err)
		}
	}
}

func TestExactRatioCost(t *testing.T) {
	p := &Problem{
		NutrientNames: []string{"p"},
		MaxTypes:      8,
		MaxUnits:      30,
		WeightLo:      rat("0"),
		WeightHi:      rat("100"),
		NutLo:         []*big.Rat{rat("2")},
		NutHi:         []*big.Rat{rat("100")},
		Ingredients: []Ingredient{
			{Name: "x", Cost: rat("2/3"), Weight: rat("1"),
				Pot: [2][]*big.Rat{{rat("1")}, {rat("1")}}},
		},
	}
	res := Solve(p)
	if res.Best == nil {
		t.Fatal("expected feasible recipe")
	}
	if got := frac(res.Best.Cost); got != "4/3" {
		t.Fatalf("cost=%s, want exact ratio 4/3", got)
	}
	if got := frac(res.Upper); got != "4/3" {
		t.Fatalf("upper=%s, want 4/3", got)
	}
	if got := frac(res.Lower); got != "4/3" {
		t.Fatalf("lower=%s, want 4/3 (proven optimal)", got)
	}
}
