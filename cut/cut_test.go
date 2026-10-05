package cut

import (
	"math/rand"
	"testing"
)

func sampleJob() Job {
	return Job{
		Kerf:           2,
		ScrapThreshold: 5,
		CutCost:        1,
		OrderID:        "O1",
		StockTypes:     []StockType{{Length: 20, Cost: 10}, {Length: 12, Cost: 7}},
		Demands:        []Demand{{Label: "a", Length: 6, Qty: 2}, {Label: "b", Length: 5, Qty: 1}},
	}
}

func TestBasicPlanAndConservation(t *testing.T) {
	plan, err := Solve(sampleJob())
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Totals.ConservationOK {
		t.Fatalf("global conservation violated: %+v", plan.Totals)
	}
	job := sampleJob()
	for _, bp := range plan.Bars {
		sum := 0
		for _, label := range bp.Cuts {
			for _, p := range plan.Pieces {
				if p.Label == label && p.BarID == bp.BarID {
					sum += p.Length
				}
			}
		}
		if bp.Length != sum+bp.KerfLoss+bp.Leftover {
			t.Fatalf("bar %s: %d != %d+%d+%d", bp.BarID, bp.Length, sum, bp.KerfLoss, bp.Leftover)
		}
		if bp.KerfLoss != bp.CutCount*job.Kerf {
			t.Fatalf("bar %s: kerf mismatch", bp.BarID)
		}
	}
	if plan.Totals.CutCost != plan.Totals.CutCount*job.CutCost {
		t.Fatal("cut cost mismatch")
	}
	if plan.Totals.TotalCost != plan.Totals.PurchaseCost+plan.Totals.CutCost {
		t.Fatal("total cost mismatch")
	}
}

func TestScrapThreshold(t *testing.T) {
	job := Job{
		Kerf:           1,
		ScrapThreshold: 4,
		OrderID:        "O1",
		StockTypes:     []StockType{{Length: 10, Cost: 5}},
		Demands:        []Demand{{Label: "x", Length: 6, Qty: 1}},
	}
	plan, err := Solve(job)
	if err != nil {
		t.Fatal(err)
	}
	// leftover = 10 - 6 - 1 = 3 < 4 -> scrap
	if plan.Bars[0].Leftover != 3 || plan.Bars[0].LeftoverState != "scrap" {
		t.Fatalf("expected scrap leftover 3, got %+v", plan.Bars[0])
	}
	if plan.Totals.Scrap != 3 || plan.Totals.Reusable != 0 {
		t.Fatalf("bad totals %+v", plan.Totals)
	}

	job.Demands = []Demand{{Label: "x", Length: 5, Qty: 1}}
	plan, err = Solve(job)
	if err != nil {
		t.Fatal(err)
	}
	// leftover = 10 - 5 - 1 = 4 >= 4 -> reusable
	if plan.Bars[0].LeftoverState != "reusable" || plan.Bars[0].LeftoverID == "" {
		t.Fatalf("expected reusable leftover, got %+v", plan.Bars[0])
	}
	if len(plan.NewInventory) != 1 || plan.NewInventory[0].Length != 4 {
		t.Fatalf("bad new inventory %+v", plan.NewInventory)
	}
}

func TestSolverMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 1000; trial++ {
		job := randomJob(rng)
		plan, err := Solve(job)
		bp, bs, ok := BruteForce(job)
		if (err == nil) != ok {
			t.Fatalf("trial %d: feasibility mismatch solve=%v brute=%v job=%+v", trial, err, ok, job)
		}
		if !ok {
			continue
		}
		if plan.Totals.PurchaseCost != bp || plan.Totals.Scrap != bs {
			t.Fatalf("trial %d: solve=(%d,%d) brute=(%d,%d) job=%+v",
				trial, plan.Totals.PurchaseCost, plan.Totals.Scrap, bp, bs, job)
		}
		if !plan.Totals.ConservationOK {
			t.Fatalf("trial %d: conservation violated job=%+v plan=%+v", trial, job, plan)
		}
	}
}

func TestBoundsSandwich(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 1000; trial++ {
		job := randomJob(rng)
		plan, err := Solve(job)
		if err != nil {
			continue
		}
		b := plan.Bounds
		if b.Lower > plan.Totals.TotalCost || b.Upper < plan.Totals.TotalCost {
			t.Fatalf("trial %d: bounds [%d,%d] do not sandwich %d", trial, b.Lower, b.Upper, plan.Totals.TotalCost)
		}
	}
}

func randomJob(rng *rand.Rand) Job {
	job := Job{
		Kerf:           rng.Intn(3),
		ScrapThreshold: rng.Intn(6),
		CutCost:        rng.Intn(4),
		MaxBars:        3 + rng.Intn(2),
		OrderID:        "O1",
	}
	for i := 0; i < 1+rng.Intn(2); i++ {
		job.StockTypes = append(job.StockTypes, StockType{
			Length: 8 + rng.Intn(13),
			Cost:   1 + rng.Intn(15),
		})
	}
	nPieces := 1 + rng.Intn(6)
	for nPieces > 0 {
		d := Demand{
			Label:  string(rune('a' + rng.Intn(26))),
			Length: 2 + rng.Intn(9),
			Qty:    1 + rng.Intn(nPieces),
		}
		nPieces -= d.Qty
		job.Demands = append(job.Demands, d)
	}
	for i := 0; i < rng.Intn(3); i++ {
		job.Inventory = append(job.Inventory, Bar{
			ID:     string(rune('A'+i)) + "-L",
			Length: 4 + rng.Intn(10),
			Origin: "leftover",
		})
	}
	return job
}

func TestInventoryReuseAcrossOrders(t *testing.T) {
	state := &State{}
	job1 := Job{
		Kerf:           1,
		ScrapThreshold: 4,
		CutCost:        1,
		OrderID:        "O1",
		StockTypes:     []StockType{{Length: 10, Cost: 5}},
		Demands:        []Demand{{Label: "x", Length: 5, Qty: 1}},
	}
	plan1, err := Solve(job1)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan1.NewInventory) != 1 {
		t.Fatalf("expected one leftover, got %+v", plan1.NewInventory)
	}
	leftoverID := plan1.NewInventory[0].ID
	if leftoverID != "O1-P1-L" {
		t.Fatalf("unexpected leftover id %q", leftoverID)
	}
	state.Apply(plan1)

	// order 2: demand fits the leftover exactly -> no new purchase
	job2 := Job{
		Kerf:           1,
		ScrapThreshold: 4,
		CutCost:        1,
		OrderID:        "O2",
		StockTypes:     []StockType{{Length: 10, Cost: 5}},
		Demands:        []Demand{{Label: "y", Length: 3, Qty: 1}},
		Inventory:      state.Inventory,
		History:        state.History,
	}
	plan2, err := Solve(job2)
	if err != nil {
		t.Fatal(err)
	}
	if plan2.Totals.PurchaseCost != 0 {
		t.Fatalf("expected zero additional purchase, got %d", plan2.Totals.PurchaseCost)
	}
	if plan2.Bars[0].BarID != leftoverID {
		t.Fatalf("expected reuse of %s, got %s", leftoverID, plan2.Bars[0].BarID)
	}
	// source tree traces back to the original purchased bar
	want := "O1-P1-L <- O1-P1"
	if plan2.Pieces[0].Source != want {
		t.Fatalf("source tree = %q, want %q", plan2.Pieces[0].Source, want)
	}
	// order 1 plan untouched: no rollback
	if plan1.Bars[0].Cuts[0] != "x" {
		t.Fatal("order 1 plan mutated")
	}
}

func TestDemandCorrectionMinimalAdditional(t *testing.T) {
	state := &State{}
	base := Job{
		Kerf:           2,
		ScrapThreshold: 3,
		CutCost:        2,
		OrderID:        "O1",
		StockTypes:     []StockType{{Length: 12, Cost: 9}},
		Demands:        []Demand{{Label: "a", Length: 5, Qty: 1}},
	}
	plan1, err := Solve(base)
	if err != nil {
		t.Fatal(err)
	}
	state.Apply(plan1)

	// corrected demand: one more piece of length 4
	corr := base
	corr.OrderID = "O2"
	corr.Demands = []Demand{{Label: "b", Length: 4, Qty: 1}}
	corr.Inventory = state.Inventory
	corr.History = state.History
	plan2, err := Solve(corr)
	if err != nil {
		t.Fatal(err)
	}
	bp, bs, ok := BruteForce(corr)
	if !ok {
		t.Fatal("brute force infeasible")
	}
	if plan2.Totals.PurchaseCost != bp || plan2.Totals.Scrap != bs {
		t.Fatalf("correction not minimal: got (%d,%d), brute (%d,%d)",
			plan2.Totals.PurchaseCost, plan2.Totals.Scrap, bp, bs)
	}
	// leftover from O1 (length 12-5-2=5) fits 4+2=6? no -> must buy 1 bar
	if plan2.Totals.PurchaseCost != 9 {
		t.Fatalf("expected additional purchase 9, got %d", plan2.Totals.PurchaseCost)
	}
}

func TestLimits(t *testing.T) {
	job := sampleJob()
	job.Demands = []Demand{{Label: "z", Length: 3, Qty: 17}}
	if _, err := Solve(job); err != ErrTooManyPieces {
		t.Fatalf("want ErrTooManyPieces, got %v", err)
	}
	job = sampleJob()
	job.MaxBars = 9
	if _, err := Solve(job); err != ErrTooManyBars {
		t.Fatalf("want ErrTooManyBars, got %v", err)
	}
}

func TestInfeasible(t *testing.T) {
	job := Job{
		Kerf:       1,
		OrderID:    "O1",
		StockTypes: []StockType{{Length: 5, Cost: 3}},
		Demands:    []Demand{{Label: "big", Length: 10, Qty: 1}},
	}
	if _, err := Solve(job); err != ErrInfeasible {
		t.Fatalf("want ErrInfeasible, got %v", err)
	}
}

func TestMultiGenerationLineage(t *testing.T) {
	state := &State{}
	mk := func(order string, dem Demand) Job {
		return Job{
			Kerf:           0,
			ScrapThreshold: 3,
			OrderID:        order,
			StockTypes:     []StockType{{Length: 20, Cost: 10}},
			Demands:        []Demand{dem},
			Inventory:      state.Inventory,
			History:        state.History,
		}
	}
	// O1: cut 12 from 20 -> leftover 8 (O1-P1-L)
	p1, err := Solve(mk("O1", Demand{Label: "a", Length: 12, Qty: 1}))
	if err != nil {
		t.Fatal(err)
	}
	state.Apply(p1)
	// O2: cut 5 from leftover 8 -> leftover 3 (O1-P1-L-L)
	p2, err := Solve(mk("O2", Demand{Label: "b", Length: 5, Qty: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if p2.Totals.PurchaseCost != 0 {
		t.Fatalf("O2 should reuse leftover, paid %d", p2.Totals.PurchaseCost)
	}
	state.Apply(p2)
	// O3: cut 3 from leftover 3 -> exact fit
	p3, err := Solve(mk("O3", Demand{Label: "c", Length: 3, Qty: 1}))
	if err != nil {
		t.Fatal(err)
	}
	want := "O1-P1-L-L <- O1-P1-L <- O1-P1"
	if p3.Pieces[0].Source != want {
		t.Fatalf("lineage = %q, want %q", p3.Pieces[0].Source, want)
	}
	state.Apply(p3)
	if len(state.Inventory) != 0 {
		t.Fatalf("inventory should be empty, got %+v", state.Inventory)
	}
	if len(state.History) != 3 { // O1-P1, O1-P1-L, O1-P1-L-L
		t.Fatalf("history = %+v", state.History)
	}
}

func TestStatePersistence(t *testing.T) {
	path := t.TempDir() + "/state.json"
	state := &State{}
	job := Job{
		Kerf:           1,
		ScrapThreshold: 4,
		OrderID:        "O1",
		StockTypes:     []StockType{{Length: 10, Cost: 5}},
		Demands:        []Demand{{Label: "x", Length: 5, Qty: 1}},
	}
	plan, err := Solve(job)
	if err != nil {
		t.Fatal(err)
	}
	state.Apply(plan)
	if err := state.Save(path); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadState(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Inventory) != 1 || loaded.Inventory[0].ID != "O1-P1-L" {
		t.Fatalf("bad loaded inventory %+v", loaded.Inventory)
	}
	if loaded.OrderSeq != 1 {
		t.Fatalf("OrderSeq = %d", loaded.OrderSeq)
	}
	missing, err := LoadState(path + ".missing")
	if err != nil || len(missing.Inventory) != 0 {
		t.Fatalf("missing state should load empty: %v %+v", err, missing)
	}
}
