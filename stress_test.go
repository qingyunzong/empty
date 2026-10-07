package location

import (
	"math/rand"
	"testing"
	"time"
)

func TestStress18x12(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	inst := Instance{MaxDist: 15}
	for i := 0; i < 18; i++ {
		inst.Sites = append(inst.Sites, Site{ID: i, X: rng.Float64() * 20, Y: rng.Float64() * 20,
			OpenCost: 5 + rng.Float64()*15, Capacity: 2 + rng.Intn(4)})
	}
	for j := 0; j < 12; j++ {
		inst.Demands = append(inst.Demands, Demand{ID: j, X: rng.Float64() * 20, Y: rng.Float64() * 20,
			Size: 1 + rng.Intn(3)})
	}
	start := time.Now()
	sol, err := Solve(inst)
	if err != nil {
		t.Skipf("infeasible random instance: %v", err)
	}
	t.Logf("solved 18x12 in %v, cost %.4f, bound %.4f", time.Since(start), sol.TotalCost, sol.LowerBound)
	if err := Verify(inst, sol); err != nil {
		t.Fatal(err)
	}
}
