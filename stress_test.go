package placement

import (
	"math/rand"
	"testing"
	"time"
)

func TestStressAdversarial(t *testing.T) {
	worst := time.Duration(0)
	for seed := int64(0); seed < 40; seed++ {
		r := rand.New(rand.NewSource(seed))
		req := Request{Old: map[string]string{}}
		for j := 0; j < MaxMachines; j++ {
			req.Machines = append(req.Machines, Machine{
				ID:          string(rune('A' + j)),
				CPU:         int64(20 + r.Intn(60)),
				Mem:         int64(20 + r.Intn(60)),
				StartupCost: int64(r.Intn(20)),
			})
		}
		for i := 0; i < MaxTasks; i++ {
			task := Task{
				ID:            "t" + string(rune('a'+i)),
				CPU:           int64(1 + r.Intn(10)),
				Mem:           int64(1 + r.Intn(10)),
				MigrationCost: int64(r.Intn(15)),
			}
			if r.Intn(3) == 0 {
				task.Allowed = []bool{r.Intn(2) == 0, r.Intn(2) == 0, r.Intn(2) == 0, r.Intn(2) == 0}
			}
			req.Tasks = append(req.Tasks, task)
			req.Old[task.ID] = req.Machines[r.Intn(MaxMachines)].ID
		}
		for i := 0; i < 10; i++ {
			a, b := r.Intn(MaxTasks), r.Intn(MaxTasks)
			if a != b {
				req.Tasks[a].AntiWith = append(req.Tasks[a].AntiWith, req.Tasks[b].ID)
			}
		}
		start := time.Now()
		res, err := Solve(req)
		el := time.Since(start)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if el > worst {
			worst = el
		}
		t.Logf("seed %d: %s nodes=%d feasible=%v cost=%d", seed, el, res.Cert.NodesExplored, res.Feasible, res.Cost)
	}
	t.Logf("worst: %s", worst)
}
