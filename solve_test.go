package main

import (
	"math/big"
	"math/rand"
	"testing"
)

func totalCost(t *testing.T, inst *Instance) (*big.Rat, *Certificate) {
	t.Helper()
	cert, err := Solve(inst)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := Verify(inst, cert); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	total, err := cert.TotalCostRat()
	if err != nil {
		t.Fatalf("TotalCostRat: %v", err)
	}
	return total, cert
}

// Two slots, lossless battery: buy cheap in slot 1, avoid expensive
// grid energy in slot 2. Optimum computed by hand: 13.
func TestHandComputed(t *testing.T) {
	inst := &Instance{
		Capacity:     4,
		InitialSOC:   0,
		ChargeEff:    Rat{1, 1},
		DischargeEff: Rat{1, 1},
		Slots: []Slot{
			{Demand: 1, Price: 1, ChargeLimit: 2, DischargeLimit: 2},
			{Demand: 3, Price: 10, ChargeLimit: 2, DischargeLimit: 2},
		},
	}
	total, cert := totalCost(t, inst)
	if total.Cmp(big.NewRat(13, 1)) != 0 {
		t.Fatalf("total cost = %s, want 13", total.RatString())
	}
	if cert.Steps[0].Charge != 2 || cert.Steps[1].Discharge != 2 {
		t.Fatalf("unexpected plan: %+v", cert.Steps)
	}
}

// Lossy battery with rational efficiencies. Charge 1 unit in slot 1
// (grid 2, cost 2), discharge 1 in slot 2 (grid -1/3, revenue 10/3).
// Optimum by hand: 2 - 10/3 = -4/3.
func TestRationalEfficiencyExact(t *testing.T) {
	inst := &Instance{
		Capacity:     1,
		InitialSOC:   0,
		ChargeEff:    Rat{1, 2},
		DischargeEff: Rat{1, 3},
		Slots: []Slot{
			{Demand: 0, Price: 1, ChargeLimit: 1, DischargeLimit: 0},
			{Demand: 0, Price: 10, ChargeLimit: 0, DischargeLimit: 1},
		},
	}
	total, cert := totalCost(t, inst)
	if total.Cmp(big.NewRat(-4, 3)) != 0 {
		t.Fatalf("total cost = %s, want -4/3", total.RatString())
	}
	if cert.Steps[1].GridEnergy != "-1/3" {
		t.Fatalf("slot 2 grid energy = %s, want -1/3", cert.Steps[1].GridEnergy)
	}
}

// Discharging beyond demand sells energy back (negative grid energy).
func TestSellBack(t *testing.T) {
	inst := &Instance{
		Capacity:     2,
		InitialSOC:   2,
		ChargeEff:    Rat{1, 1},
		DischargeEff: Rat{1, 1},
		Slots: []Slot{
			{Demand: 1, Price: 5, ChargeLimit: 0, DischargeLimit: 2},
		},
	}
	total, cert := totalCost(t, inst)
	// Sell everything: grid = 1 - 2 = -1, cost = -5.
	if total.Cmp(big.NewRat(-5, 1)) != 0 {
		t.Fatalf("total cost = %s, want -5", total.RatString())
	}
	if cert.Steps[0].GridEnergy != "-1" {
		t.Fatalf("grid energy = %s, want -1", cert.Steps[0].GridEnergy)
	}
}

func TestInfeasible(t *testing.T) {
	inst := &Instance{
		Capacity:     2,
		InitialSOC:   0,
		FinalSOCMin:  2,
		ChargeEff:    Rat{1, 1},
		DischargeEff: Rat{1, 1},
		Slots: []Slot{
			{Demand: 1, Price: 1, ChargeLimit: 1, DischargeLimit: 0},
		},
	}
	if _, err := Solve(inst); err == nil {
		t.Fatal("expected infeasibility error")
	}
	if _, err := BruteForce(inst); err == nil {
		t.Fatal("expected infeasibility error from brute force")
	}
}

func TestTooManySlots(t *testing.T) {
	inst := &Instance{
		Capacity:     1,
		ChargeEff:    Rat{1, 1},
		DischargeEff: Rat{1, 1},
		Slots:        make([]Slot, MaxSlots+1),
	}
	if _, err := Solve(inst); err == nil {
		t.Fatal("expected slot-count error")
	}
}

func randomInstance(r *rand.Rand, n int) *Instance {
	effs := []Rat{{1, 1}, {1, 2}, {2, 3}, {9, 10}, {3, 4}}
	cap := 1 + r.Intn(6)
	inst := &Instance{
		Capacity:     cap,
		InitialSOC:   r.Intn(cap + 1),
		FinalSOCMin:  r.Intn(cap/2 + 1),
		ChargeEff:    effs[r.Intn(len(effs))],
		DischargeEff: effs[r.Intn(len(effs))],
		Slots:        make([]Slot, n),
	}
	for i := range inst.Slots {
		inst.Slots[i] = Slot{
			Demand:         r.Intn(6),
			Price:          1 + r.Intn(10),
			ChargeLimit:    r.Intn(4),
			DischargeLimit: r.Intn(4),
		}
	}
	return inst
}

// Small-scale cross-check: DP optimum must equal exhaustive enumeration
// over all action sequences, and every certificate must verify.
func TestDPvsBruteForceRandom(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for i := 0; i < 300; i++ {
		inst := randomInstance(r, 1+r.Intn(6))
		best, err := BruteForce(inst)
		cert, serr := Solve(inst)
		if serr != nil || err != nil {
			if (serr == nil) != (err == nil) {
				t.Fatalf("instance %d: DP infeasible=%v, brute infeasible=%v", i, serr != nil, err != nil)
			}
			continue // both agree the instance is infeasible
		}
		if verr := Verify(inst, cert); verr != nil {
			t.Fatalf("instance %d: Verify: %v", i, verr)
		}
		total, terr := cert.TotalCostRat()
		if terr != nil {
			t.Fatalf("instance %d: TotalCostRat: %v", i, terr)
		}
		if err != nil {
			t.Fatalf("instance %d: BruteForce: %v", i, err)
		}
		if total.Cmp(best) != 0 {
			t.Fatalf("instance %d: DP=%s brute=%s\ninstance: %+v", i, total.RatString(), best.RatString(), inst)
		}
		for _, st := range cert.Steps {
			if st.Charge > 0 && st.Discharge > 0 {
				t.Fatalf("instance %d: simultaneous charge/discharge in slot %d", i, st.Slot)
			}
		}
	}
}

// Full 12-slot horizon, still small enough for exhaustive enumeration
// (at most 3 actions per slot).
func TestTwelveSlotsVsBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	inst := &Instance{
		Capacity:     3,
		InitialSOC:   1,
		FinalSOCMin:  1,
		ChargeEff:    Rat{9, 10},
		DischargeEff: Rat{4, 5},
		Slots:        make([]Slot, MaxSlots),
	}
	for i := range inst.Slots {
		inst.Slots[i] = Slot{
			Demand:         r.Intn(4),
			Price:          1 + r.Intn(8),
			ChargeLimit:    r.Intn(2),
			DischargeLimit: r.Intn(2),
		}
	}
	total, _ := totalCost(t, inst)
	best, err := BruteForce(inst)
	if err != nil {
		t.Fatalf("BruteForce: %v", err)
	}
	if total.Cmp(best) != 0 {
		t.Fatalf("DP=%s brute=%s", total.RatString(), best.RatString())
	}
}

// A certificate tampered after solving must be rejected.
func TestVerifyRejectsTampering(t *testing.T) {
	inst := &Instance{
		Capacity:     2,
		InitialSOC:   1,
		ChargeEff:    Rat{1, 1},
		DischargeEff: Rat{1, 1},
		Slots: []Slot{
			{Demand: 1, Price: 3, ChargeLimit: 1, DischargeLimit: 1},
		},
	}
	_, cert := totalCost(t, inst)
	cert.Steps[0].Discharge = 2 // exceeds limit 1
	if err := Verify(inst, cert); err == nil {
		t.Fatal("expected verification failure for tampered certificate")
	}
}
