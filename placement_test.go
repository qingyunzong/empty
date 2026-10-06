package placement

import (
	"math/rand"
	"reflect"
	"testing"
	"time"
)

func mustSolve(t *testing.T, req Request) Result {
	t.Helper()
	res, err := Solve(req)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	return res
}

func TestBasicFeasible(t *testing.T) {
	req := Request{
		Machines: []Machine{
			{ID: "A", CPU: 10, Mem: 10, StartupCost: 5},
			{ID: "B", CPU: 10, Mem: 10, StartupCost: 3},
		},
		Tasks: []Task{
			{ID: "t1", CPU: 4, Mem: 2, MigrationCost: 1},
			{ID: "t2", CPU: 3, Mem: 3, MigrationCost: 1},
			{ID: "t3", CPU: 2, Mem: 8, MigrationCost: 1},
		},
		Old: map[string]string{"t1": "A", "t2": "A", "t3": "B"},
	}
	res := mustSolve(t, req)
	if !res.Feasible {
		t.Fatalf("expected feasible, got %+v", res.Cert)
	}
	want := map[string]string{"t1": "A", "t2": "A", "t3": "B"}
	if !reflect.DeepEqual(res.Plan, want) {
		t.Fatalf("plan = %v, want %v", res.Plan, want)
	}
	if res.Cost != 8 {
		t.Fatalf("cost = %d, want 8", res.Cost)
	}
	if cost, err := Check(req, res.Plan); err != nil || cost != res.Cost {
		t.Fatalf("Check = %d, %v; want %d, nil", cost, err, res.Cost)
	}
	if res.Cert.Feasible != true || res.Cert.KeptOld {
		t.Fatalf("bad certificate flags: %+v", res.Cert)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	req := Request{
		Machines: []Machine{
			{ID: "A", CPU: 10, Mem: 10, StartupCost: 5},
			{ID: "B", CPU: 10, Mem: 10, StartupCost: 5},
		},
		Tasks: []Task{
			{ID: "t1", CPU: 2, Mem: 2},
			{ID: "t2", CPU: 2, Mem: 2},
		},
	}
	res := mustSolve(t, req)
	want := map[string]string{"t1": "A", "t2": "A"}
	if !reflect.DeepEqual(res.Plan, want) {
		t.Fatalf("plan = %v, want lexicographically smallest %v", res.Plan, want)
	}
	if res.Cost != 5 {
		t.Fatalf("cost = %d, want 5", res.Cost)
	}
}

func TestAntiColocationTieBreak(t *testing.T) {
	req := Request{
		Machines: []Machine{
			{ID: "A", CPU: 10, Mem: 10, StartupCost: 5},
			{ID: "B", CPU: 10, Mem: 10, StartupCost: 5},
		},
		Tasks: []Task{
			{ID: "t1", CPU: 2, Mem: 2, AntiWith: []string{"t2"}},
			{ID: "t2", CPU: 2, Mem: 2},
		},
	}
	res := mustSolve(t, req)
	want := map[string]string{"t1": "A", "t2": "B"}
	if !reflect.DeepEqual(res.Plan, want) {
		t.Fatalf("plan = %v, want %v", res.Plan, want)
	}
	if res.Cost != 10 {
		t.Fatalf("cost = %d, want 10", res.Cost)
	}
}

func TestAffinityAndMigration(t *testing.T) {
	req := Request{
		Machines: []Machine{
			{ID: "A", CPU: 10, Mem: 10},
			{ID: "B", CPU: 10, Mem: 10},
		},
		Tasks: []Task{
			{ID: "t1", CPU: 1, Mem: 1, MigrationCost: 3, Allowed: []bool{true, false}},
			{ID: "t2", CPU: 1, Mem: 1, MigrationCost: 3},
		},
		Old: map[string]string{"t1": "B", "t2": "A"},
	}
	res := mustSolve(t, req)
	// t1 must move to A (affinity), paying 3; t2 stays on A for free.
	want := map[string]string{"t1": "A", "t2": "A"}
	if !reflect.DeepEqual(res.Plan, want) {
		t.Fatalf("plan = %v, want %v", res.Plan, want)
	}
	if res.Cost != 3 {
		t.Fatalf("cost = %d, want 3", res.Cost)
	}
}

func TestInfeasibleAggregateCapacityKeepsOld(t *testing.T) {
	req := Request{
		Machines: []Machine{
			{ID: "A", CPU: 5, Mem: 5, StartupCost: 2},
			{ID: "B", CPU: 5, Mem: 5, StartupCost: 2},
		},
		Tasks: []Task{
			{ID: "t1", CPU: 4, Mem: 1},
			{ID: "t2", CPU: 4, Mem: 1},
			{ID: "t3", CPU: 4, Mem: 1},
		},
		Old: map[string]string{"t1": "A", "t2": "B", "t3": "A"},
	}
	res := mustSolve(t, req)
	if res.Feasible {
		t.Fatalf("expected infeasible, got plan %v", res.Plan)
	}
	if !reflect.DeepEqual(res.Plan, req.Old) {
		t.Fatalf("old plan not kept: %v", res.Plan)
	}
	if !res.Cert.KeptOld {
		t.Fatalf("certificate should record that the old plan was kept")
	}
	if res.Cost != 4 { // startup of A and B, no migration
		t.Fatalf("cost = %d, want 4", res.Cost)
	}
	t.Logf("certificate reason: %s", res.Cert.Reason)
}

func TestInfeasibleAntiColocationClique(t *testing.T) {
	req := Request{
		Machines: []Machine{
			{ID: "A", CPU: 10, Mem: 10},
			{ID: "B", CPU: 10, Mem: 10},
		},
		Tasks: []Task{
			{ID: "t1", CPU: 1, Mem: 1, AntiWith: []string{"t2", "t3"}},
			{ID: "t2", CPU: 1, Mem: 1, AntiWith: []string{"t3"}},
			{ID: "t3", CPU: 1, Mem: 1},
		},
	}
	res := mustSolve(t, req)
	if res.Feasible {
		t.Fatalf("expected infeasible, got plan %v", res.Plan)
	}
	if len(res.Cert.Clique) != 3 {
		t.Fatalf("clique certificate = %v, want 3 tasks", res.Cert.Clique)
	}
	t.Logf("certificate reason: %s", res.Cert.Reason)
}

func TestInfeasibleEmptyAffinity(t *testing.T) {
	req := Request{
		Machines: []Machine{{ID: "A", CPU: 10, Mem: 10}},
		Tasks:    []Task{{ID: "t1", CPU: 1, Mem: 1, Allowed: []bool{false}}},
	}
	res := mustSolve(t, req)
	if res.Feasible {
		t.Fatalf("expected infeasible")
	}
	t.Logf("certificate reason: %s", res.Cert.Reason)
}

func TestValidationLimits(t *testing.T) {
	machines := []Machine{{ID: "A", CPU: 1, Mem: 1}}
	tasks := make([]Task, MaxTasks+1)
	for i := range tasks {
		tasks[i] = Task{ID: string(rune('a' + i)), CPU: 1, Mem: 1}
	}
	if _, err := Solve(Request{Tasks: tasks, Machines: machines}); err == nil {
		t.Fatalf("expected error for %d tasks", len(tasks))
	}
	many := make([]Machine, MaxMachines+1)
	for i := range many {
		many[i] = Machine{ID: string(rune('a' + i)), CPU: 1, Mem: 1}
	}
	if _, err := Solve(Request{Tasks: tasks[:1], Machines: many}); err == nil {
		t.Fatalf("expected error for %d machines", len(many))
	}
}

func TestCheckRejectsBadPlan(t *testing.T) {
	req := Request{
		Machines: []Machine{{ID: "A", CPU: 2, Mem: 2}},
		Tasks:    []Task{{ID: "t1", CPU: 3, Mem: 1}},
	}
	if _, err := Check(req, map[string]string{"t1": "A"}); err == nil {
		t.Fatalf("expected capacity violation")
	}
	if _, err := Check(req, map[string]string{"t1": "B"}); err == nil {
		t.Fatalf("expected unknown machine error")
	}
}

// bruteForce enumerates all m^n assignments in lexicographic order and
// returns the optimal cost together with the lexicographically smallest
// optimal plan. It is the reference for the exhaustive verification.
func bruteForce(req Request) (bool, int64, map[string]string) {
	tasks := sortedTasks(req.Tasks)
	n, m := len(tasks), len(req.Machines)
	machineIdx := make(map[string]int, m)
	for i, mc := range req.Machines {
		machineIdx[mc.ID] = i
	}
	anti := antiMatrix(req, tasks)
	assign := make([]int, n)
	best := int64(-1)
	var bestAssign []int
	var rec func(i int)
	rec = func(i int) {
		if i == n {
			cpuUsed := make([]int64, m)
			memUsed := make([]int64, m)
			for k, t := range tasks {
				j := assign[k]
				if len(t.Allowed) != 0 && !t.Allowed[j] {
					return
				}
				cpuUsed[j] += t.CPU
				memUsed[j] += t.Mem
			}
			for j := 0; j < m; j++ {
				if cpuUsed[j] > req.Machines[j].CPU || memUsed[j] > req.Machines[j].Mem {
					return
				}
			}
			for a := 0; a < n; a++ {
				for b := a + 1; b < n; b++ {
					if anti[a][b] && assign[a] == assign[b] {
						return
					}
				}
			}
			cost := planCost(req, tasks, assign)
			if best < 0 || cost < best {
				best = cost
				bestAssign = append([]int(nil), assign...)
			}
			return
		}
		for j := 0; j < m; j++ {
			assign[i] = j
			rec(i + 1)
		}
	}
	rec(0)
	if best < 0 {
		return false, 0, nil
	}
	plan := make(map[string]string, n)
	for i, t := range tasks {
		plan[t.ID] = req.Machines[bestAssign[i]].ID
	}
	return true, best, plan
}

func randomRequest(r *rand.Rand) Request {
	m := 1 + r.Intn(3)
	n := 1 + r.Intn(7)
	req := Request{Old: map[string]string{}}
	for j := 0; j < m; j++ {
		req.Machines = append(req.Machines, Machine{
			ID:          string(rune('A' + j)),
			CPU:         int64(4 + r.Intn(11)),
			Mem:         int64(4 + r.Intn(11)),
			StartupCost: int64(r.Intn(9)),
		})
	}
	for i := 0; i < n; i++ {
		t := Task{
			ID:            "t" + string(rune('0'+i)),
			CPU:           int64(1 + r.Intn(6)),
			Mem:           int64(1 + r.Intn(6)),
			MigrationCost: int64(r.Intn(7)),
		}
		if r.Intn(2) == 0 {
			t.Allowed = make([]bool, m)
			for j := range t.Allowed {
				t.Allowed[j] = r.Intn(5) != 0
			}
		}
		req.Tasks = append(req.Tasks, t)
		if r.Intn(10) < 7 {
			req.Old[t.ID] = req.Machines[r.Intn(m)].ID
		}
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if r.Intn(100) < 15 {
				req.Tasks[i].AntiWith = append(req.Tasks[i].AntiWith, req.Tasks[j].ID)
			}
		}
	}
	return req
}

func TestExhaustiveSmallInstances(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for iter := 0; iter < 500; iter++ {
		req := randomRequest(r)
		res, err := Solve(req)
		if err != nil {
			t.Fatalf("iter %d: Solve: %v", iter, err)
		}
		wantFeasible, wantCost, wantPlan := bruteForce(req)
		if res.Feasible != wantFeasible {
			t.Fatalf("iter %d: feasible = %v, want %v (req %+v)", iter, res.Feasible, wantFeasible, req)
		}
		if !wantFeasible {
			if !reflect.DeepEqual(res.Plan, req.Old) {
				t.Fatalf("iter %d: infeasible but old plan not kept: %v vs %v", iter, res.Plan, req.Old)
			}
			continue
		}
		if res.Cost != wantCost {
			t.Fatalf("iter %d: cost = %d, want %d (req %+v)", iter, res.Cost, wantCost, req)
		}
		if !reflect.DeepEqual(res.Plan, wantPlan) {
			t.Fatalf("iter %d: plan = %v, want lex-smallest %v (req %+v)", iter, res.Plan, wantPlan, req)
		}
		if cost, err := Check(req, res.Plan); err != nil || cost != res.Cost {
			t.Fatalf("iter %d: Check = %d, %v; want %d, nil", iter, cost, err, res.Cost)
		}
	}
}

func TestMaxSizeCompletes(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	req := Request{Old: map[string]string{}}
	for j := 0; j < MaxMachines; j++ {
		req.Machines = append(req.Machines, Machine{
			ID:          string(rune('A' + j)),
			CPU:         30,
			Mem:         30,
			StartupCost: int64(r.Intn(10)),
		})
	}
	for i := 0; i < MaxTasks; i++ {
		t := Task{
			ID:            "t" + string(rune('a'+i)),
			CPU:           int64(1 + r.Intn(8)),
			Mem:           int64(1 + r.Intn(8)),
			MigrationCost: int64(r.Intn(10)),
		}
		req.Tasks = append(req.Tasks, t)
		req.Old[t.ID] = req.Machines[r.Intn(MaxMachines)].ID
	}
	for i := 0; i < 6; i++ {
		a, b := r.Intn(MaxTasks), r.Intn(MaxTasks)
		if a != b {
			req.Tasks[a].AntiWith = append(req.Tasks[a].AntiWith, req.Tasks[b].ID)
		}
	}
	start := time.Now()
	res := mustSolve(t, req)
	elapsed := time.Since(start)
	if !res.Feasible {
		t.Fatalf("expected feasible")
	}
	if _, err := Check(req, res.Plan); err != nil {
		t.Fatalf("Check: %v", err)
	}
	t.Logf("18 tasks / 4 machines solved in %s (%d nodes, cost %d)", elapsed, res.Cert.NodesExplored, res.Cost)
	if elapsed > 10*time.Second {
		t.Fatalf("solver too slow: %s", elapsed)
	}
}
