package main

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func mustSolve(t *testing.T, s Spec) Plan {
	t.Helper()
	pl, err := Solve(s)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	return pl
}

// checkCertificate validates every invariant the energy certificate must
// satisfy: SOC chain continuity, grid bounds, no simultaneous charge and
// discharge, and cost consistency.
func checkCertificate(t *testing.T, s Spec, pl Plan) {
	t.Helper()
	if len(pl.Steps) != len(s.Periods) {
		t.Fatalf("certificate has %d steps, want %d", len(pl.Steps), len(s.Periods))
	}
	var sum int64
	soc := s.Initial
	for i, st := range pl.Steps {
		if st.Charge > 0 && st.Discharge > 0 {
			t.Errorf("period %d: charges and discharges simultaneously", st.Period)
		}
		if st.SOCBefore != soc {
			t.Errorf("period %d: SOC before = %d, want %d", st.Period, st.SOCBefore, soc)
		}
		if st.SOCAfter < 0 || st.SOCAfter > s.Capacity {
			t.Errorf("period %d: SOC after = %d outside [0, %d]", st.Period, st.SOCAfter, s.Capacity)
		}
		p := s.Periods[i]
		if want := int64(p.Price) * int64(p.Demand+st.Charge-st.Discharge); st.Cost != want {
			t.Errorf("period %d: cost = %d, want %d", st.Period, st.Cost, want)
		}
		sum += st.Cost
		soc = st.SOCAfter
	}
	if soc != s.Final {
		t.Errorf("final SOC = %d, want %d", soc, s.Final)
	}
	if sum != pl.TotalCost {
		t.Errorf("step costs sum to %d, total is %d", sum, pl.TotalCost)
	}
}

func TestSolveKnownOptimum(t *testing.T) {
	// Buy 2 units at price 1 in period 1, discharge them in period 2 to
	// cover a demand of 2 priced at 10. Optimum: 2*1 + 0*10 = 2.
	s := Spec{
		Capacity: 4, Initial: 0, Final: 0,
		ChargeEff: "1", DischargeEff: "1",
		Periods: []Period{
			{Demand: 0, Price: 1, ChargeLimit: 4, DischargeLimit: 4},
			{Demand: 2, Price: 10, ChargeLimit: 4, DischargeLimit: 4},
		},
	}
	pl := mustSolve(t, s)
	if pl.TotalCost != 2 {
		t.Fatalf("total cost = %d, want 2", pl.TotalCost)
	}
	if pl.Steps[0].Charge != 2 || pl.Steps[1].Discharge != 2 {
		t.Fatalf("unexpected schedule: %+v", pl.Steps)
	}
	checkCertificate(t, s, pl)
}

func TestSolveChargeEfficiencyLoss(t *testing.T) {
	// Charge efficiency 1/2: 2 grid units store 1. Covering the demand of 1
	// in period 2 from the battery costs 2*1; buying directly costs 10.
	s := Spec{
		Capacity: 2, Initial: 0, Final: 0,
		ChargeEff: "1/2", DischargeEff: "1",
		Periods: []Period{
			{Demand: 0, Price: 1, ChargeLimit: 4, DischargeLimit: 0},
			{Demand: 1, Price: 10, ChargeLimit: 0, DischargeLimit: 1},
		},
	}
	pl := mustSolve(t, s)
	if pl.TotalCost != 2 {
		t.Fatalf("total cost = %d, want 2", pl.TotalCost)
	}
	if pl.Steps[0].Charge != 2 || pl.Steps[1].Discharge != 1 {
		t.Fatalf("unexpected schedule: %+v", pl.Steps)
	}
	checkCertificate(t, s, pl)
}

func TestGridPoints(t *testing.T) {
	third := eff{num: 1, den: 3}
	twoThirds := eff{num: 2, den: 3}
	p := Period{ChargeLimit: 7, DischargeLimit: 7}
	got := actionsFor(p, third, twoThirds)
	// Charge: only multiples of 3 land on the grid. Discharge: h*3 must be
	// divisible by 2, so only even h. Idle appears exactly once.
	want := []action{
		{},
		{charge: 3}, {charge: 6},
		{discharge: 2}, {discharge: 4}, {discharge: 6},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("actionsFor = %v, want %v", got, want)
	}
}

func TestParseEff(t *testing.T) {
	for _, in := range []string{"1", "0.95", "19/20", "3/2"} {
		if _, err := parseEff(in); err != nil {
			t.Errorf("parseEff(%q): %v", in, err)
		}
	}
	for _, in := range []string{"", "abc", "0", "-1/2", "1/0"} {
		if _, err := parseEff(in); err == nil {
			t.Errorf("parseEff(%q) unexpectedly succeeded", in)
		}
	}
}

func TestValidation(t *testing.T) {
	valid := Spec{
		Capacity: 2, Initial: 0, Final: 0,
		ChargeEff: "1", DischargeEff: "1",
		Periods: []Period{{Demand: 1, Price: 1}},
	}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}

	many := valid
	many.Periods = make([]Period, maxPeriods+1)
	zero := valid
	zero.Capacity = 0
	badInitial := valid
	badInitial.Initial = 3
	badFinal := valid
	badFinal.Final = -1
	empty := valid
	empty.Periods = nil
	badEff := valid
	badEff.ChargeEff = "abc"
	negDemand := valid
	negDemand.Periods = []Period{{Demand: -1, Price: 1}}
	negLimit := valid
	negLimit.Periods = []Period{{Demand: 1, Price: 1, ChargeLimit: -1}}

	cases := map[string]Spec{
		"too many periods": many,
		"zero capacity":    zero,
		"bad initial":      badInitial,
		"bad final":        badFinal,
		"no periods":       empty,
		"bad efficiency":   badEff,
		"negative demand":  negDemand,
		"negative limit":   negLimit,
	}
	for name, s := range cases {
		if err := s.validate(); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestInfeasible(t *testing.T) {
	// Final SOC 2 is unreachable with a zero charge limit.
	s := Spec{
		Capacity: 2, Initial: 0, Final: 2,
		ChargeEff: "1", DischargeEff: "1",
		Periods: []Period{{Demand: 1, Price: 1}},
	}
	if _, err := Solve(s); err == nil {
		t.Fatal("Solve unexpectedly succeeded on infeasible spec")
	}
	if _, feasible, err := BruteForce(s); err != nil || feasible {
		t.Fatalf("BruteForce = feasible %v, err %v; want infeasible", feasible, err)
	}
}

// TestDPvsBruteForceRandom cross-checks the DP solver against exhaustive
// enumeration of all action sequences on small random instances.
func TestDPvsBruteForceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	effs := []string{"1", "1/2", "2", "2/3", "3/2", "3/4", "4/3", "1/3", "0.9"}
	pick := func(xs []string) string { return xs[rng.Intn(len(xs))] }

	for trial := 0; trial < 300; trial++ {
		cap := 1 + rng.Intn(6)
		n := 1 + rng.Intn(6)
		s := Spec{
			Capacity:     cap,
			Initial:      rng.Intn(cap + 1),
			Final:        rng.Intn(cap + 1),
			ChargeEff:    pick(effs),
			DischargeEff: pick(effs),
			Periods:      make([]Period, n),
		}
		for i := range s.Periods {
			s.Periods[i] = Period{
				Demand:         rng.Intn(5),
				Price:          rng.Intn(12) - 2,
				ChargeLimit:    rng.Intn(5),
				DischargeLimit: rng.Intn(5),
			}
		}

		best, feasible, err := BruteForce(s)
		if err != nil {
			t.Fatalf("trial %d: BruteForce: %v", trial, err)
		}
		pl, err := Solve(s)
		if !feasible {
			if err == nil {
				t.Fatalf("trial %d: DP found cost %d but brute force reports infeasible", trial, pl.TotalCost)
			}
			continue
		}
		if err != nil {
			t.Fatalf("trial %d: DP infeasible but brute force found cost %d", trial, best)
		}
		if pl.TotalCost != best {
			t.Fatalf("trial %d: DP cost %d != brute-force cost %d", trial, pl.TotalCost, best)
		}
		checkCertificate(t, s, pl)
	}
}

func TestRenderCertificate(t *testing.T) {
	s := Spec{
		Capacity: 4, Initial: 0, Final: 0,
		ChargeEff: "1", DischargeEff: "1",
		Periods: []Period{
			{Demand: 0, Price: 1, ChargeLimit: 4, DischargeLimit: 4},
			{Demand: 2, Price: 10, ChargeLimit: 4, DischargeLimit: 4},
		},
	}
	out := RenderCertificate(mustSolve(t, s), s)
	for _, want := range []string{"period", "charge", "discharge", "total cost: 2"} {
		if !strings.Contains(out, want) {
			t.Errorf("certificate missing %q:\n%s", want, out)
		}
	}
}

func TestSolveTwelvePeriods(t *testing.T) {
	// The maximum supported horizon: 12 periods with alternating prices.
	s := Spec{
		Capacity: 4, Initial: 0, Final: 0,
		ChargeEff: "9/10", DischargeEff: "9/10",
	}
	var spot int64
	for i := 0; i < maxPeriods; i++ {
		price := 9
		if i%2 == 0 {
			price = 2
		}
		s.Periods = append(s.Periods, Period{
			Demand: 2, Price: price, ChargeLimit: 4, DischargeLimit: 2,
		})
		spot += int64(2 * price)
	}
	pl := mustSolve(t, s)
	checkCertificate(t, s, pl)
	if pl.TotalCost > spot {
		t.Fatalf("total cost %d exceeds buying at spot %d", pl.TotalCost, spot)
	}
}
