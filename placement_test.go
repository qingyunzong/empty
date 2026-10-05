package placement

import (
	"math"
	"math/rand"
	"testing"
)

func TestPacksOntoOneMachine(t *testing.T) {
	p := Problem{
		Tasks: []Task{
			{Name: "a", CPU: 2, Mem: 2},
			{Name: "b", CPU: 2, Mem: 2},
			{Name: "c", CPU: 1, Mem: 1},
		},
		Machines: []Machine{
			{Name: "m0", CPUCap: 5, MemCap: 5, StartupCost: 10},
			{Name: "m1", CPUCap: 5, MemCap: 5, StartupCost: 10},
		},
		OldPlacement: []int{-1, -1, -1},
	}
	r := Solve(p)
	if !r.Optimal || r.Cost != 10 {
		t.Fatalf("got %+v, want optimal cost 10", r)
	}
	used := 0
	for _, u := range r.Certificate.Used {
		if u {
			used++
		}
	}
	if used != 1 {
		t.Fatalf("want all tasks on one machine, cert %+v", r.Certificate)
	}
}

func TestAntiAffinityForcesSecondMachine(t *testing.T) {
	p := Problem{
		Tasks: []Task{
			{Name: "a", CPU: 3, Mem: 3},
			{Name: "b", CPU: 3, Mem: 3},
		},
		Machines: []Machine{
			{CPUCap: 3, MemCap: 3, StartupCost: 10},
			{CPUCap: 3, MemCap: 3, StartupCost: 10},
		},
		Conflicts:    [][2]int{{0, 1}},
		OldPlacement: []int{-1, -1},
	}
	r := Solve(p)
	if !r.Optimal || r.Cost != 20 {
		t.Fatalf("got %+v, want optimal cost 20", r)
	}
	if r.Placement[0] == r.Placement[1] {
		t.Fatalf("conflicting tasks share a machine: %v", r.Placement)
	}
}

func TestAffinityRestrictsMachine(t *testing.T) {
	p := Problem{
		Tasks: []Task{
			{CPU: 1, Mem: 1, Allowed: []bool{false, true}},
			{CPU: 1, Mem: 1},
		},
		Machines: []Machine{
			{CPUCap: 4, MemCap: 4, StartupCost: 5},
			{CPUCap: 4, MemCap: 4, StartupCost: 5},
		},
		OldPlacement: []int{-1, -1},
	}
	r := Solve(p)
	if !r.Optimal {
		t.Fatalf("got %+v", r)
	}
	if r.Placement[0] != 1 {
		t.Fatalf("task 0 must sit on machine 1, got %v", r.Placement)
	}
	if r.Cost != 5 {
		t.Fatalf("both tasks should share machine 1, cost %d", r.Cost)
	}
}

func TestMigrationAvoidedWhenPossible(t *testing.T) {
	p := Problem{
		Tasks: []Task{{CPU: 2, Mem: 2}, {CPU: 2, Mem: 2}},
		Machines: []Machine{
			{CPUCap: 4, MemCap: 4, Running: true, StartupCost: 100},
			{CPUCap: 4, MemCap: 4, StartupCost: 10},
		},
		OldPlacement:  []int{0, 0},
		MigrationCost: 7,
	}
	r := Solve(p)
	if !r.Optimal || r.Cost != 0 {
		t.Fatalf("staying put is free, got %+v", r)
	}
	// Shrink machine 0: one task must leave, paying startup + migration.
	p.Machines[0].CPUCap = 3
	r = Solve(p)
	if !r.Optimal || r.Cost != 17 {
		t.Fatalf("want cost 10+7=17, got %+v", r)
	}
	if len(r.Certificate.Migrated) != 1 {
		t.Fatalf("want exactly one migrated task, cert %+v", r.Certificate)
	}
}

func TestInfeasibleKeepsOldPlacement(t *testing.T) {
	p := Problem{
		Tasks: []Task{{CPU: 10, Mem: 1}, {CPU: 1, Mem: 1}},
		Machines: []Machine{
			{CPUCap: 4, MemCap: 4},
			{CPUCap: 4, MemCap: 4},
		},
		OldPlacement: []int{0, 1},
	}
	r := Solve(p)
	if r.Optimal || !r.KeptOld {
		t.Fatalf("got %+v", r)
	}
	if r.Placement[0] != 0 || r.Placement[1] != 1 {
		t.Fatalf("old placement not kept: %v", r.Placement)
	}
	if r.CertificateValid {
		t.Fatalf("old placement is over capacity, certificate must flag it")
	}
}

func TestVerifyRejectsViolations(t *testing.T) {
	p := Problem{
		Tasks: []Task{
			{CPU: 3, Mem: 1, Allowed: []bool{true, false}},
			{CPU: 3, Mem: 1},
		},
		Machines: []Machine{
			{CPUCap: 4, MemCap: 4},
			{CPUCap: 4, MemCap: 4},
		},
		Conflicts:    [][2]int{{0, 1}},
		OldPlacement: []int{-1, -1},
	}
	if _, ok := p.Verify([]int{0, 0}); ok {
		t.Fatal("conflict not detected")
	}
	if _, ok := p.Verify([]int{1, 1}); ok {
		t.Fatal("affinity violation not detected")
	}
	if _, ok := p.Verify([]int{0, 1}); !ok {
		t.Fatal("valid placement rejected")
	}
	over := Problem{
		Tasks:        []Task{{CPU: 5, Mem: 1}},
		Machines:     []Machine{{CPUCap: 4, MemCap: 4}},
		OldPlacement: []int{-1},
	}
	if _, ok := over.Verify([]int{0}); ok {
		t.Fatal("capacity overflow not detected")
	}
}

// bruteForce enumerates all m^n assignments and returns the minimum
// feasible cost, using only Verify as the feasibility oracle.
func bruteForce(p Problem) (best int, ok bool) {
	best = math.MaxInt
	assign := make([]int, len(p.Tasks))
	var rec func(k int)
	rec = func(k int) {
		if k == len(p.Tasks) {
			if cert, valid := p.Verify(assign); valid && cert.TotalCost < best {
				best = cert.TotalCost
				ok = true
			}
			return
		}
		for x := 0; x < len(p.Machines); x++ {
			assign[k] = x
			rec(k + 1)
		}
	}
	rec(0)
	return best, ok
}

func randomProblem(rng *rand.Rand) Problem {
	m := 1 + rng.Intn(4)
	n := 1 + rng.Intn(8)
	p := Problem{OldPlacement: make([]int, n), MigrationCost: rng.Intn(7)}
	for x := 0; x < m; x++ {
		p.Machines = append(p.Machines, Machine{
			CPUCap:      2 + rng.Intn(7),
			MemCap:      2 + rng.Intn(7),
			StartupCost: rng.Intn(16),
			Running:     rng.Intn(2) == 0,
		})
	}
	for i := 0; i < n; i++ {
		t := Task{CPU: rng.Intn(7), Mem: rng.Intn(7)}
		if rng.Intn(10) < 3 {
			allowed := make([]bool, m)
			for x := range allowed {
				allowed[x] = rng.Intn(2) == 0
			}
			if !allowed[rng.Intn(m)] {
				allowed[rng.Intn(m)] = true
			}
			t.Allowed = allowed
		}
		p.Tasks = append(p.Tasks, t)
		if rng.Intn(10) < 7 {
			p.OldPlacement[i] = rng.Intn(m)
		} else {
			p.OldPlacement[i] = -1
		}
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if rng.Intn(100) < 12 {
				p.Conflicts = append(p.Conflicts, [2]int{i, j})
			}
		}
	}
	return p
}

// TestExhaustiveSmall cross-checks the branch-and-bound solver against
// exhaustive enumeration on random small instances.
func TestExhaustiveSmall(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 400; trial++ {
		p := randomProblem(rng)
		if err := p.Validate(); err != nil {
			t.Fatalf("trial %d: generated invalid problem: %v", trial, err)
		}
		r := Solve(p)
		best, ok := bruteForce(p)
		if ok != r.Optimal {
			t.Fatalf("trial %d: feasibility mismatch brute=%v solve=%+v", trial, ok, r)
		}
		if !ok {
			if !r.KeptOld {
				t.Fatalf("trial %d: infeasible but old plan not kept", trial)
			}
			continue
		}
		if r.Cost != best {
			t.Fatalf("trial %d: cost %d, brute force optimum %d", trial, r.Cost, best)
		}
		cert, valid := p.Verify(r.Placement)
		if !valid || cert.TotalCost != best {
			t.Fatalf("trial %d: bad certificate %+v valid=%v", trial, cert, valid)
		}
	}
}

// TestEighteenTasks exercises the full problem size: 18 tasks, 4 machines.
func TestEighteenTasks(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	p := Problem{MigrationCost: 4, OldPlacement: make([]int, 18)}
	totalCPU, totalMem := 0, 0
	for i := 0; i < 18; i++ {
		cpu, mem := 1+rng.Intn(5), 1+rng.Intn(5)
		totalCPU += cpu
		totalMem += mem
		p.Tasks = append(p.Tasks, Task{CPU: cpu, Mem: mem})
		p.OldPlacement[i] = rng.Intn(4)
	}
	for x := 0; x < 4; x++ {
		p.Machines = append(p.Machines, Machine{
			CPUCap:      totalCPU*4/10 + 1,
			MemCap:      totalMem*4/10 + 1,
			StartupCost: 5 + rng.Intn(15),
			Running:     x == 0,
		})
	}
	p.Conflicts = [][2]int{{0, 1}, {2, 3}, {4, 5}}
	r := Solve(p)
	if !r.Optimal {
		t.Fatalf("expected a feasible optimum, got %+v", r)
	}
	if !r.CertificateValid {
		t.Fatalf("certificate invalid: %+v", r.Certificate)
	}
	if cert, ok := p.Verify(p.OldPlacement); ok && r.Cost > cert.TotalCost {
		t.Fatalf("optimum %d worse than old plan %d", r.Cost, cert.TotalCost)
	}
	t.Logf("\n%s", r.String(p))
}
