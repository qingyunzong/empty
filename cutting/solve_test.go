package cutting

import (
	"math/rand"
	"testing"
)

func TestKnownOptimum(t *testing.T) {
	spec := &Spec{
		OrderID:    "t1",
		Kerf:       1,
		MinRemnant: 3,
		CutCost:    2,
		StockTypes: []StockType{{Length: 10, Cost: 10}, {Length: 5, Cost: 6}},
		Demands:    []Demand{{Length: 4, Count: 4}},
	}
	plan, err := Solve(spec)
	if err != nil {
		t.Fatal(err)
	}
	// Best: two 10-bars, each cut into 4+4 (cuts=2, kerf 2, leftover 0).
	if plan.PurchaseCost != 20 {
		t.Errorf("purchase cost = %d, want 20", plan.PurchaseCost)
	}
	if len(plan.Bars) != 2 {
		t.Errorf("bars = %d, want 2", len(plan.Bars))
	}
	if plan.TotalCuts != 4 || plan.CutCostTotal != 8 {
		t.Errorf("cuts = %d (cost %d), want 4 (8)", plan.TotalCuts, plan.CutCostTotal)
	}
	if plan.TotalScrap != 0 || plan.TotalRemnant != 0 {
		t.Errorf("scrap=%d remnant=%d, want 0/0", plan.TotalScrap, plan.TotalRemnant)
	}
	if !plan.ConservationOK {
		t.Error("conservation check failed")
	}
	// 20 stock = 16 demand + 4 kerf.
	if plan.TotalStockLength != 20 || plan.DemandLength != 16 || plan.TotalKerfLoss != 4 {
		t.Errorf("stock=%d demand=%d kerf=%d", plan.TotalStockLength, plan.DemandLength, plan.TotalKerfLoss)
	}
}

func TestExactFitSavesOneCut(t *testing.T) {
	spec := &Spec{
		Kerf:       2,
		MinRemnant: 1,
		StockTypes: []StockType{{Length: 10, Cost: 5}},
		Demands:    []Demand{{Length: 4, Count: 2}},
	}
	plan, err := Solve(spec)
	if err != nil {
		t.Fatal(err)
	}
	bar := plan.Bars[0]
	if bar.Cuts != 1 || bar.KerfLoss != 2 || bar.Remnant != 0 || bar.Scrap != 0 {
		t.Errorf("cuts=%d kerf=%d remnant=%d scrap=%d, want 1/2/0/0",
			bar.Cuts, bar.KerfLoss, bar.Remnant, bar.Scrap)
	}
}

func TestScrapThreshold(t *testing.T) {
	spec := &Spec{
		MinRemnant: 4,
		StockTypes: []StockType{{Length: 10, Cost: 5}},
		Demands:    []Demand{{Length: 7, Count: 1}, {Length: 6, Count: 1}},
	}
	plan, err := Solve(spec)
	if err != nil {
		t.Fatal(err)
	}
	byLen := map[int]BarPlan{}
	for _, b := range plan.Bars {
		byLen[b.Pieces[0].Length] = b
	}
	if b := byLen[7]; b.Scrap != 3 || b.Remnant != 0 {
		t.Errorf("len-7 bar: scrap=%d remnant=%d, want 3/0", b.Scrap, b.Remnant)
	}
	if b := byLen[6]; b.Remnant != 4 || b.RemnantID == "" || b.Scrap != 0 {
		t.Errorf("len-6 bar: remnant=%d id=%q scrap=%d, want 4/<id>/0", b.Remnant, b.RemnantID, b.Scrap)
	}
	if len(plan.NewRemnants) != 1 || plan.NewRemnants[0].Length != 4 {
		t.Errorf("new remnants = %+v, want one of length 4", plan.NewRemnants)
	}
}

func TestRemnantReuseAcrossOrders(t *testing.T) {
	inv := Inventory{NextRemnantNum: 1, NextOrderNum: 1}
	// Order 1: cut 12 from a 20-bar, leaving a remnant of 8.
	spec1 := &Spec{
		OrderID: "o1", MinRemnant: 5,
		StockTypes: []StockType{{Length: 20, Cost: 30}},
		Demands:    []Demand{{Length: 12, Count: 1}},
	}
	spec1.Remnants = inv.Remnants
	spec1.NextRemnantNum = inv.NextRemnantNum
	plan1, err := Solve(spec1)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan1.NewRemnants) != 1 || plan1.NewRemnants[0].ID != "R0001" {
		t.Fatalf("new remnants = %+v, want R0001", plan1.NewRemnants)
	}
	inv.ApplyPlan(plan1, spec1.NextRemnantNum)

	// Order 2: demand 8 must come free from remnant R0001, with its stable ID.
	spec2 := &Spec{
		OrderID: "o2", MinRemnant: 5,
		StockTypes: []StockType{{Length: 20, Cost: 30}},
		Demands:    []Demand{{Length: 8, Count: 1}},
	}
	spec2.Remnants = inv.Remnants
	spec2.NextRemnantNum = inv.NextRemnantNum
	plan2, err := Solve(spec2)
	if err != nil {
		t.Fatal(err)
	}
	if plan2.PurchaseCost != 0 {
		t.Errorf("purchase cost = %d, want 0 (remnant reused)", plan2.PurchaseCost)
	}
	bar := plan2.Bars[0]
	if bar.BarID != "R0001" || bar.Purchased {
		t.Errorf("bar id = %q purchased=%v, want R0001/false", bar.BarID, bar.Purchased)
	}
	if bar.Cuts != 0 { // exact fit: the remnant is the piece
		t.Errorf("cuts = %d, want 0", bar.Cuts)
	}
	inv.ApplyPlan(plan2, spec2.NextRemnantNum)
	if len(inv.Remnants) != 0 {
		t.Errorf("inventory remnants = %+v, want empty (R0001 consumed)", inv.Remnants)
	}
	if inv.NextRemnantNum != 2 {
		t.Errorf("next remnant num = %d, want 2", inv.NextRemnantNum)
	}
}

func TestDemandCorrection(t *testing.T) {
	// Previous plan already cut two 4s; demand rises to three 4s and one 6.
	prev := &Plan{Bars: []BarPlan{{Pieces: []PlacedPiece{
		{ID: "P1", Length: 4}, {ID: "P2", Length: 4},
	}}}}
	var cut []PlacedPiece
	for _, b := range prev.Bars {
		cut = append(cut, b.Pieces...)
	}
	remaining, surplus := RemainingDemand(
		[]Demand{{Length: 4, Count: 3}, {Length: 6, Count: 1}}, cut)
	if len(surplus) != 0 {
		t.Errorf("surplus = %+v, want none", surplus)
	}
	if len(remaining) != 2 {
		t.Fatalf("remaining = %+v, want 4x1 + 6x1", remaining)
	}
	// Minimal addition: one 10-bar cut 6+4 exactly.
	spec := &Spec{
		OrderID: "o2", MinRemnant: 3,
		StockTypes: []StockType{{Length: 10, Cost: 10}},
		Demands:    remaining,
	}
	plan, err := Solve(spec)
	if err != nil {
		t.Fatal(err)
	}
	if plan.PurchaseCost != 10 || len(plan.Bars) != 1 || plan.Bars[0].Cuts != 1 {
		t.Errorf("additional plan: cost=%d bars=%d cuts=%d, want 10/1/1",
			plan.PurchaseCost, len(plan.Bars), plan.Bars[0].Cuts)
	}

	// Demand drops below what was cut: surplus reported, nothing to plan.
	remaining, surplus = RemainingDemand([]Demand{{Length: 4, Count: 1}}, cut)
	if len(remaining) != 0 || len(surplus) != 1 || surplus[0].Count != 1 {
		t.Errorf("remaining=%+v surplus=%+v, want none / one 4", remaining, surplus)
	}
}

func TestLimitsAndInfeasible(t *testing.T) {
	// Piece longer than any stock.
	_, err := Solve(&Spec{
		StockTypes: []StockType{{Length: 5, Cost: 1}},
		Demands:    []Demand{{Length: 6, Count: 1}},
	})
	if err == nil {
		t.Error("want error for overlong piece")
	}
	// MaxPiecesPerBar forces a second bar.
	plan, err := Solve(&Spec{
		MaxPiecesPerBar: 1, MaxBars: 2,
		StockTypes: []StockType{{Length: 10, Cost: 3}},
		Demands:    []Demand{{Length: 4, Count: 2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Bars) != 2 {
		t.Errorf("bars = %d, want 2 with MaxPiecesPerBar=1", len(plan.Bars))
	}
	// Not enough bars.
	_, err = Solve(&Spec{
		MaxBars:    1,
		StockTypes: []StockType{{Length: 10, Cost: 3}},
		Demands:    []Demand{{Length: 6, Count: 2}},
	})
	if err != ErrInfeasible {
		t.Errorf("err = %v, want ErrInfeasible", err)
	}
}

// randomSpec builds a small solvable spec for cross-checking.
func randomSpec(r *rand.Rand) *Spec {
	spec := &Spec{
		OrderID:         "rnd",
		Kerf:            r.Intn(3),
		MinRemnant:      r.Intn(5),
		CutCost:         r.Intn(4),
		MaxPiecesPerBar: 5,
		MaxBars:         4,
	}
	maxLen := 0
	for i := 1 + r.Intn(2); i > 0; i-- {
		l := 4 + r.Intn(9)
		if l > maxLen {
			maxLen = l
		}
		spec.StockTypes = append(spec.StockTypes, StockType{Length: l, Cost: 3 + r.Intn(15)})
	}
	for i := 0; i < r.Intn(3); i++ {
		l := 3 + r.Intn(10)
		if l > maxLen {
			maxLen = l
		}
		spec.Remnants = append(spec.Remnants, Bar{
			ID:     string(rune('A' + i)),
			Length: l,
		})
	}
	maxPiece := maxLen
	if maxPiece > 6 {
		maxPiece = 6
	}
	n := 0
	for n == 0 {
		for _, l := range r.Perm(maxPiece - 1)[:1+r.Intn(min(3, maxPiece-1))] {
			c := r.Intn(4)
			if n+c > 8 {
				c = 8 - n
			}
			if c > 0 {
				spec.Demands = append(spec.Demands, Demand{Length: 2 + l, Count: c})
				n += c
			}
		}
	}
	return spec
}

func TestExhaustiveCrossCheck(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		spec := randomSpec(rand.New(rand.NewSource(seed)))
		plan, err := Solve(spec)
		wantKey, wantOK, xerr := Exhaustive(spec)
		if xerr != nil {
			t.Fatalf("seed %d: exhaustive: %v", seed, xerr)
		}
		if err == ErrInfeasible {
			if wantOK {
				t.Fatalf("seed %d: solver infeasible but exhaustive found %v", seed, wantKey)
			}
			continue
		}
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if !wantOK {
			t.Fatalf("seed %d: solver found plan but exhaustive did not", seed)
		}
		if got := Objective(plan); got != wantKey.Tuple() {
			t.Fatalf("seed %d: solver %v != exhaustive %v (spec %+v)", seed, got, wantKey.Tuple(), spec)
		}
		if !plan.ConservationOK {
			t.Fatalf("seed %d: conservation violated", seed)
		}
		if len(plan.Bars) > spec.MaxBars {
			t.Fatalf("seed %d: %d bars > max %d", seed, len(plan.Bars), spec.MaxBars)
		}
		for _, b := range plan.Bars {
			if len(b.Pieces) > spec.MaxPiecesPerBar {
				t.Fatalf("seed %d: %d pieces in bar > max %d", seed, len(b.Pieces), spec.MaxPiecesPerBar)
			}
		}
		if plan.Bounds.PurchaseLower > plan.PurchaseCost ||
			plan.Bounds.CutsLower > plan.TotalCuts ||
			plan.Bounds.BudgetLower > plan.Budget {
			t.Fatalf("seed %d: bounds %+v exceed actual cost=%d cuts=%d budget=%d",
				seed, plan.Bounds, plan.PurchaseCost, plan.TotalCuts, plan.Budget)
		}
	}
}
