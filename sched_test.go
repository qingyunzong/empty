package sched

import (
	"errors"
	"math/rand"
	"strings"
	"testing"
)

// bruteForce enumerates every one of the 4^n assignments without any
// pruning or memoization and returns the minimum feasible cost. It is the
// finite-enumeration oracle used to accept Solve.
func bruteForce(inst *Instance) (int, bool) {
	n := len(inst.Shifts)
	assign := make([]int, n)
	best := -1
	var rec func(i int)
	rec = func(i int) {
		if i == n {
			if c, ok := evalAssignment(inst, assign); ok && (best < 0 || c < best) {
				best = c
			}
			return
		}
		for e := 0; e < 4; e++ {
			assign[i] = e
			rec(i + 1)
		}
	}
	rec(0)
	return best, best >= 0
}

// evalAssignment checks feasibility and computes the cost of one complete
// assignment entirely from scratch (independent of the solver internals).
func evalAssignment(inst *Instance, assign []int) (int, bool) {
	var mins [4]int
	lastEnd := [4]int{-1, -1, -1, -1}
	cost := 0
	for i, sh := range inst.Shifts {
		e := assign[i]
		emp := &inst.Employees[e]
		if !emp.hasSkill(sh.Skill) {
			return 0, false
		}
		if lastEnd[e] >= 0 && sh.Start-lastEnd[e] < inst.Params.MinRest {
			return 0, false
		}
		lastEnd[e] = sh.End
		mins[e] += sh.End - sh.Start
		if mins[e] > emp.MaxHours {
			return 0, false
		}
		if i > 0 && assign[i] != assign[i-1] {
			cost += inst.Params.Changeover
		}
	}
	for e := 0; e < 4; e++ {
		cost += labor(mins[e], inst.Params.Tiers)
	}
	return cost, true
}

func TestHandCraftedChangeoverVsOvertime(t *testing.T) {
	// Two 8h shifts, skill A. Tiers: first 480 min @1, then @2.
	// Same employee: 480*1 + 480*2 = 1440. Split: 960 + 100 changeover = 1060.
	inst := &Instance{
		Shifts: []Shift{
			{ID: "S0", Start: 0, End: 480, Skill: "A"},
			{ID: "S1", Start: 480, End: 960, Skill: "A"},
		},
		Employees: [4]Employee{
			{ID: "E0", Skills: []string{"A"}, MaxHours: 960},
			{ID: "E1", Skills: []string{"A"}, MaxHours: 960},
			{ID: "E2", Skills: []string{"B"}, MaxHours: 960},
			{ID: "E3", Skills: []string{"B"}, MaxHours: 960},
		},
		Params: Params{
			Tiers:      []Tier{{UpTo: 480, Rate: 1}, {UpTo: -1, Rate: 2}},
			Changeover: 100,
		},
	}
	sol, err := inst.Solve()
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if sol.Total != 1060 {
		t.Fatalf("total = %d, want 1060", sol.Total)
	}
	if sol.Assign[0] == sol.Assign[1] {
		t.Fatalf("expected split assignment, got %v", sol.Assign)
	}
	if _, err := Verify(inst, &sol); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	// With a cheap changeover the overtime ladder dominates: 1440 vs 960+10.
	inst.Params.Changeover = 10
	sol, err = inst.Solve()
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if sol.Total != 970 {
		t.Fatalf("total = %d, want 970", sol.Total)
	}
}

func TestRestConstraint(t *testing.T) {
	mk := func(gap int) *Instance {
		return &Instance{
			Shifts: []Shift{
				{ID: "S0", Start: 0, End: 480, Skill: "A"},
				{ID: "S1", Start: 480 + gap, End: 960 + gap, Skill: "A"},
			},
			Employees: [4]Employee{
				{ID: "E0", Skills: []string{"A"}, MaxHours: 960},
				{ID: "E1", Skills: []string{"X"}, MaxHours: 960}, // unusable
				{ID: "E2", Skills: []string{"X"}, MaxHours: 960},
				{ID: "E3", Skills: []string{"X"}, MaxHours: 960},
			},
			Params: Params{
				Tiers:   []Tier{{UpTo: -1, Rate: 1}},
				MinRest: 60,
			},
		}
	}
	if _, err := mk(30).Solve(); !errors.Is(err, ErrInfeasible) {
		t.Fatalf("gap 30 < rest 60: got %v, want ErrInfeasible", err)
	}
	sol, err := mk(60).Solve()
	if err != nil {
		t.Fatalf("gap 60: %v", err)
	}
	if sol.Total != 960 {
		t.Fatalf("total = %d, want 960", sol.Total)
	}
}

func TestHoursCap(t *testing.T) {
	inst := &Instance{
		Shifts: []Shift{
			{ID: "S0", Start: 0, End: 600},
			{ID: "S1", Start: 600, End: 1200},
		},
		Employees: [4]Employee{
			{ID: "E0", MaxHours: 500},
			{ID: "E1", MaxHours: 500},
			{ID: "E2", MaxHours: 500},
			{ID: "E3", MaxHours: 500},
		},
		Params: Params{Tiers: []Tier{{UpTo: -1, Rate: 1}}},
	}
	if _, err := inst.Solve(); !errors.Is(err, ErrInfeasible) {
		t.Fatalf("got %v, want ErrInfeasible", err)
	}
}

func TestValidation(t *testing.T) {
	bad := &Instance{Shifts: nil}
	if _, err := bad.Solve(); err == nil {
		t.Fatal("empty instance accepted")
	}
	bad = &Instance{Shifts: make([]Shift, 17)}
	if _, err := bad.Solve(); err == nil {
		t.Fatal("17 shifts accepted")
	}
}

// randInstance builds a deterministic pseudo-random instance with n shifts.
func randInstance(r *rand.Rand, n int) *Instance {
	skills := []string{"A", "B", ""}
	inst := &Instance{Params: Params{
		Tiers:      []Tier{{UpTo: 480, Rate: 2}, {UpTo: 900, Rate: 3}, {UpTo: -1, Rate: 5}},
		Changeover: 1 + r.Intn(120),
		MinRest:    r.Intn(4) * 30,
	}}
	tm := 0
	for i := 0; i < n; i++ {
		dur := 240 + 60*r.Intn(7) // 4h..10h
		inst.Shifts = append(inst.Shifts, Shift{
			ID:    "S" + itoa(i),
			Start: tm,
			End:   tm + dur,
			Skill: skills[r.Intn(len(skills))],
		})
		tm += dur + r.Intn(5)*60
	}
	for e := 0; e < 4; e++ {
		var sk []string
		if r.Intn(4) > 0 {
			sk = append(sk, "A")
		}
		if r.Intn(4) > 0 {
			sk = append(sk, "B")
		}
		inst.Employees[e] = Employee{
			ID:       "E" + itoa(e),
			Skills:   sk,
			MaxHours: 600 + 120*r.Intn(8),
		}
	}
	return inst
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [4]byte
	p := len(buf)
	for i > 0 {
		p--
		buf[p] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[p:])
}

// TestSolveMatchesBruteForce is the finite-enumeration acceptance test:
// for many random instances of up to 11 shifts the DP optimum must equal
// the minimum over all 4^n explicitly enumerated assignments, and the
// returned solution must pass independent verification.
func TestSolveMatchesBruteForce(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		r := rand.New(rand.NewSource(seed))
		n := 1 + r.Intn(11)
		inst := randInstance(r, n)
		sol, err := inst.Solve()
		want, feasible := bruteForce(inst)
		if !feasible {
			if !errors.Is(err, ErrInfeasible) {
				t.Fatalf("seed %d: infeasible by enumeration, Solve err=%v", seed, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("seed %d: enumeration found cost %d, Solve: %v", seed, want, err)
		}
		if sol.Total != want {
			t.Fatalf("seed %d: Solve total %d, enumeration optimum %d", seed, sol.Total, want)
		}
		if _, err := Verify(inst, &sol); err != nil {
			t.Fatalf("seed %d: Verify: %v", seed, err)
		}
	}
}

// TestSolveMatchesBruteForce12 pushes the finite enumeration to 12 shifts
// (4^12 = 16.7M assignments per instance).
func TestSolveMatchesBruteForce12(t *testing.T) {
	for seed := int64(100); seed < 104; seed++ {
		r := rand.New(rand.NewSource(seed))
		inst := randInstance(r, 12)
		sol, err := inst.Solve()
		want, feasible := bruteForce(inst)
		if !feasible {
			if !errors.Is(err, ErrInfeasible) {
				t.Fatalf("seed %d: infeasible by enumeration, Solve err=%v", seed, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("seed %d: enumeration found cost %d, Solve: %v", seed, want, err)
		}
		if sol.Total != want {
			t.Fatalf("seed %d: Solve total %d, enumeration optimum %d", seed, sol.Total, want)
		}
		if _, err := Verify(inst, &sol); err != nil {
			t.Fatalf("seed %d: Verify: %v", seed, err)
		}
	}
}

// TestSixteenShiftsStress solves and verifies many full-size instances,
// including tightly constrained ones, to guard against A* blow-ups.
func TestSixteenShiftsStress(t *testing.T) {
	for seed := int64(0); seed < 60; seed++ {
		r := rand.New(rand.NewSource(1000 + seed))
		inst := randInstance(r, 16)
		sol, err := inst.Solve()
		if errors.Is(err, ErrInfeasible) {
			continue
		}
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if _, err := Verify(inst, &sol); err != nil {
			t.Fatalf("seed %d: Verify: %v", seed, err)
		}
	}
}

// TestSixteenShifts exercises the maximum supported size and the report.
func TestSixteenShifts(t *testing.T) {
	r := rand.New(rand.NewSource(16))
	inst := randInstance(r, 16)
	inst.Params.MinRest = 0
	for e := range inst.Employees {
		inst.Employees[e].Skills = []string{"A", "B"}
		inst.Employees[e].MaxHours = 2400
	}
	sol, err := inst.Solve()
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	cert, err := Verify(inst, &sol)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	report, err := inst.Report(&sol)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	for _, want := range []string{"shift", "employee", "total:", "certificate", "E0", "S15"} {
		if !strings.Contains(report, want) {
			t.Fatalf("report missing %q:\n%s", want, report)
		}
	}
	// The DP must be deterministic.
	sol2, err := inst.Solve()
	if err != nil || sol2.Total != sol.Total {
		t.Fatalf("non-deterministic: %d vs %d (err %v)", sol.Total, sol2.Total, err)
	}
	t.Logf("16-shift optimum: total=%d changeovers=%d", cert.Total, cert.Changeovers)
	t.Logf("\n%s", report)
}

// TestVerifyRejectsTampering ensures the certificate path catches bad input.
func TestVerifyRejectsTampering(t *testing.T) {
	inst := randInstance(rand.New(rand.NewSource(7)), 6)
	sol, err := inst.Solve()
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	sol.Total++
	if _, err := Verify(inst, &sol); err == nil {
		t.Fatal("tampered total accepted")
	}
}
