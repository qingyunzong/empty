package signal

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

// linCosts returns a waiting-cost table cost[g] = (cycle-g)*slope.
func linCosts(cycle, slope int) []int {
	c := make([]int, cycle+1)
	for g := range c {
		c[g] = (cycle - g) * slope
	}
	return c
}

func TestIndependentSets(t *testing.T) {
	// Path 0-1-2: independent non-empty sets are {0},{1},{2},{0,2}.
	p := &Problem{
		Cycle: 4,
		Phases: []Phase{
			{Name: "a", Min: 0, Cost: linCosts(4, 1)},
			{Name: "b", Min: 0, Cost: linCosts(4, 1)},
			{Name: "c", Min: 0, Cost: linCosts(4, 1)},
		},
		Conflicts: [][2]int{{0, 1}, {1, 2}},
	}
	sets := independentSets(p.adjacency())
	want := []uint64{0b001, 0b010, 0b100, 0b101}
	if !reflect.DeepEqual(sets, want) {
		t.Fatalf("independentSets = %b, want %b", sets, want)
	}
}

func TestSolveHandComputedConflict(t *testing.T) {
	// Two conflicting phases, cycle 10, min 2 each.
	// cost = 80 - (3*gA + 5*gB), gA+gB <= 10 -> optimum gA=2, gB=8, cost 34.
	p := &Problem{
		Cycle: 10,
		Phases: []Phase{
			{Name: "A", Min: 2, Cost: linCosts(10, 3)},
			{Name: "B", Min: 2, Cost: linCosts(10, 5)},
		},
		Conflicts: [][2]int{{0, 1}},
	}
	cert, err := Solve(p, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 34 {
		t.Fatalf("cost = %d, want 34", cert.Cost)
	}
	if !reflect.DeepEqual(cert.Green, []int{2, 8}) {
		t.Fatalf("green = %v, want [2 8]", cert.Green)
	}
	if err := Check(p, cert); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

func TestSolveNoConflict(t *testing.T) {
	// Compatible phases can share every slot: both get full green.
	p := &Problem{
		Cycle: 6,
		Phases: []Phase{
			{Name: "A", Min: 2, Cost: linCosts(6, 3)},
			{Name: "B", Min: 2, Cost: linCosts(6, 5)},
		},
	}
	cert, err := Solve(p, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 0 || !reflect.DeepEqual(cert.Green, []int{6, 6}) {
		t.Fatalf("cost=%d green=%v, want cost 0 green [6 6]", cert.Cost, cert.Green)
	}
	if err := Check(p, cert); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

func TestSolveInfeasible(t *testing.T) {
	// Two conflicting phases needing 3+3 slots in a cycle of 5.
	p := &Problem{
		Cycle: 5,
		Phases: []Phase{
			{Name: "A", Min: 3, Cost: linCosts(5, 1)},
			{Name: "B", Min: 3, Cost: linCosts(5, 1)},
		},
		Conflicts: [][2]int{{0, 1}},
	}
	if _, err := Solve(p, 1<<20); !errors.Is(err, ErrInfeasible) {
		t.Fatalf("err = %v, want ErrInfeasible", err)
	}
	if _, err := Exhaustive(p, 1<<20); !errors.Is(err, ErrInfeasible) {
		t.Fatalf("exhaustive err = %v, want ErrInfeasible", err)
	}
}

func TestSolveAllConflicting(t *testing.T) {
	// Triangle of conflicts: greens must sum to <= cycle.
	// cost = (10-gA) + 2*(10-gB) + 3*(10-gC), gA+gB+gC <= 10, mins 1 each
	// -> give everything to C: green [1 1 8], cost 9 + 18 + 6 = 33.
	p := &Problem{
		Cycle: 10,
		Phases: []Phase{
			{Name: "A", Min: 1, Cost: linCosts(10, 1)},
			{Name: "B", Min: 1, Cost: linCosts(10, 2)},
			{Name: "C", Min: 1, Cost: linCosts(10, 3)},
		},
		Conflicts: [][2]int{{0, 1}, {0, 2}, {1, 2}},
	}
	cert, err := Solve(p, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 33 || !reflect.DeepEqual(cert.Green, []int{1, 1, 8}) {
		t.Fatalf("cost=%d green=%v, want cost 33 green [1 1 8]", cert.Cost, cert.Green)
	}
}

func TestExhaustiveMatchesSolve(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(4)     // 1..4 phases
		cycle := 1 + rng.Intn(7) // cycle 1..7 (tiny, exhaustible)
		p := &Problem{Cycle: cycle}
		for i := 0; i < n; i++ {
			cost := make([]int, cycle+1)
			for g := range cost {
				cost[g] = rng.Intn(50)
			}
			p.Phases = append(p.Phases, Phase{
				Name: string(rune('A' + i)),
				Min:  rng.Intn(cycle/2 + 1),
				Cost: cost,
			})
		}
		for i := 0; i < n; i++ {
			for j := i + 1; j < n; j++ {
				if rng.Float64() < 0.4 {
					p.Conflicts = append(p.Conflicts, [2]int{i, j})
				}
			}
		}
		if err := p.Validate(); err != nil {
			t.Fatalf("trial %d: invalid generated problem: %v", trial, err)
		}
		certDP, errDP := Solve(p, 1<<22)
		certEx, errEx := Exhaustive(p, 1<<22)
		if errors.Is(errDP, ErrInfeasible) || errors.Is(errEx, ErrInfeasible) {
			if !errors.Is(errDP, ErrInfeasible) || !errors.Is(errEx, ErrInfeasible) {
				t.Fatalf("trial %d: feasibility mismatch dp=%v exhaustive=%v", trial, errDP, errEx)
			}
			continue
		}
		if errDP != nil || errEx != nil {
			t.Fatalf("trial %d: dp=%v exhaustive=%v", trial, errDP, errEx)
		}
		if certDP.Cost != certEx.Cost {
			t.Fatalf("trial %d: dp cost %d != exhaustive cost %d\nproblem: %+v", trial, certDP.Cost, certEx.Cost, p)
		}
		if err := Check(p, certDP); err != nil {
			t.Fatalf("trial %d: dp certificate invalid: %v", trial, err)
		}
		if err := Check(p, certEx); err != nil {
			t.Fatalf("trial %d: exhaustive certificate invalid: %v", trial, err)
		}
	}
}

func TestExhaustiveRefusesLargeCycles(t *testing.T) {
	p := &Problem{
		Cycle: 60,
		Phases: []Phase{
			{Name: "A", Min: 1, Cost: linCosts(60, 1)},
			{Name: "B", Min: 1, Cost: linCosts(60, 1)},
			{Name: "C", Min: 1, Cost: linCosts(60, 1)},
		},
	}
	if _, err := Exhaustive(p, 1000); err == nil {
		t.Fatal("expected enumeration-limit error for large cycle")
	}
}

func TestCheck(t *testing.T) {
	p := &Problem{
		Cycle: 4,
		Phases: []Phase{
			{Name: "A", Min: 2, Cost: linCosts(4, 3)},
			{Name: "B", Min: 1, Cost: linCosts(4, 5)},
		},
		Conflicts: [][2]int{{0, 1}},
	}
	good := &Certificate{
		Cycle: 4,
		Green: []int{3, 1},
		Slots: [][]int{{0}, {0}, {0}, {1}},
	}
	good.Cost = p.Phases[0].Cost[3] + p.Phases[1].Cost[1]
	if err := Check(p, good); err != nil {
		t.Fatalf("good certificate rejected: %v", err)
	}

	cases := map[string]*Certificate{
		"conflict in slot": {Cycle: 4, Cost: good.Cost, Green: []int{3, 1}, Slots: [][]int{{0, 1}, {0}, {0}, {}}},
		"below minimum":    {Cycle: 4, Cost: p.Phases[0].Cost[1] + p.Phases[1].Cost[1], Green: []int{1, 1}, Slots: [][]int{{0}, {1}, {}, {}}},
		"wrong cost":       {Cycle: 4, Cost: good.Cost + 1, Green: []int{3, 1}, Slots: [][]int{{0}, {0}, {0}, {1}}},
		"wrong green":      {Cycle: 4, Cost: good.Cost, Green: []int{2, 2}, Slots: [][]int{{0}, {0}, {0}, {1}}},
		"too many slots":   {Cycle: 4, Cost: good.Cost, Green: []int{3, 1}, Slots: [][]int{{0}, {0}, {0}, {1}, {}}},
		"bad index":        {Cycle: 4, Cost: good.Cost, Green: []int{3, 1}, Slots: [][]int{{0}, {0}, {0}, {7}}},
		"cycle mismatch":   {Cycle: 5, Cost: good.Cost, Green: []int{3, 1}, Slots: [][]int{{0}, {0}, {0}, {1}}},
	}
	for name, cert := range cases {
		if err := Check(p, cert); err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
	}
}

func TestValidate(t *testing.T) {
	base := func() *Problem {
		return &Problem{
			Cycle: 4,
			Phases: []Phase{
				{Name: "A", Min: 1, Cost: linCosts(4, 1)},
				{Name: "B", Min: 1, Cost: linCosts(4, 1)},
			},
			Conflicts: [][2]int{{0, 1}},
		}
	}
	if err := base().Validate(); err != nil {
		t.Fatalf("baseline problem invalid: %v", err)
	}
	bad := map[string]func(*Problem){
		"cycle too large":  func(p *Problem) { p.Cycle = 61 },
		"cycle zero":       func(p *Problem) { p.Cycle = 0 },
		"no phases":        func(p *Problem) { p.Phases = nil },
		"duplicate name":   func(p *Problem) { p.Phases[1].Name = "A" },
		"min above cycle":  func(p *Problem) { p.Phases[0].Min = 5 },
		"short cost table": func(p *Problem) { p.Phases[0].Cost = p.Phases[0].Cost[:4] },
		"negative cost":    func(p *Problem) { p.Phases[0].Cost[2] = -1 },
		"conflict range":   func(p *Problem) { p.Conflicts = [][2]int{{0, 2}} },
		"self conflict":    func(p *Problem) { p.Conflicts = [][2]int{{1, 1}} },
	}
	for name, mutate := range bad {
		p := base()
		mutate(p)
		if err := p.Validate(); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}
}

func TestExampleIntersection(t *testing.T) {
	p, err := LoadProblem("../../examples/intersection.json")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := Solve(p, 1<<22)
	if err != nil {
		t.Fatal(err)
	}
	// Hand-computed: maximize 4*gA+7*gB+5*gC with slots {A,C}x10 + {B}x2.
	if cert.Cost != 88 || !reflect.DeepEqual(cert.Green, []int{10, 2, 10}) {
		t.Fatalf("cost=%d green=%v, want cost 88 green [10 2 10]", cert.Cost, cert.Green)
	}
	ex, err := Exhaustive(p, 1<<22)
	if err != nil {
		t.Fatal(err)
	}
	if ex.Cost != cert.Cost {
		t.Fatalf("exhaustive cost %d != dp cost %d", ex.Cost, cert.Cost)
	}
	if err := Check(p, cert); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}
