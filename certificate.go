package location

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// Verify checks a solution against an instance and returns nil only if the
// solution is a valid capacity certificate:
//   - every demand is assigned to exactly one open site (unsplittable);
//   - every assignment respects the coverage distance limit;
//   - per-site load never exceeds integer capacity;
//   - reported costs are consistent with the assignment.
func Verify(inst Instance, sol Solution) error {
	n, m := len(inst.Sites), len(inst.Demands)
	if len(sol.Open) != n || len(sol.Load) != n || len(sol.Assign) != m {
		return errors.New("location: solution shape does not match instance")
	}
	load := make([]int, n)
	openCost, assignCost := 0.0, 0.0
	for i, s := range inst.Sites {
		if sol.Open[i] {
			openCost += s.OpenCost
		}
	}
	for j, d := range inst.Demands {
		i := sol.Assign[j]
		if i < 0 || i >= n {
			return fmt.Errorf("location: demand %d assigned to invalid site %d", j, i)
		}
		if !sol.Open[i] {
			return fmt.Errorf("location: demand %d assigned to closed site %d", j, i)
		}
		if dd := dist(d.X, d.Y, inst.Sites[i].X, inst.Sites[i].Y); dd > inst.MaxDist {
			return fmt.Errorf("location: demand %d assigned beyond coverage limit (%.4f > %.4f)", j, dd, inst.MaxDist)
		}
		load[i] += d.Size
		assignCost += dist(d.X, d.Y, inst.Sites[i].X, inst.Sites[i].Y)
	}
	for i, s := range inst.Sites {
		if load[i] != sol.Load[i] {
			return fmt.Errorf("location: reported load of site %d is inconsistent", i)
		}
		if load[i] > s.Capacity {
			return fmt.Errorf("location: site %d overloaded (%d > %d)", i, load[i], s.Capacity)
		}
	}
	const eps = 1e-9
	if math.Abs(openCost-sol.OpenCost) > eps ||
		math.Abs(assignCost-sol.AssignCost) > eps ||
		math.Abs(openCost+assignCost-sol.TotalCost) > eps {
		return errors.New("location: reported costs are inconsistent")
	}
	return nil
}

// Report renders the solution as a human-readable capacity certificate,
// including the budget bound when the instance carries a finite budget.
func Report(inst Instance, sol Solution) string {
	var b strings.Builder
	fmt.Fprintf(&b, "total cost: %.4f (open %.4f + distance %.4f)\n", sol.TotalCost, sol.OpenCost, sol.AssignCost)
	fmt.Fprintf(&b, "certified lower bound: %.4f\n", sol.LowerBound)
	if sol.HasBudget {
		status := "WITHIN"
		if !sol.WithinBudget {
			status = "EXCEEDS"
		}
		fmt.Fprintf(&b, "budget: %.4f -> %s budget\n", inst.Budget, status)
	}
	b.WriteString("open sites and capacity certificate:\n")
	for i, s := range inst.Sites {
		if sol.Open[i] {
			fmt.Fprintf(&b, "  site %d: load %d / capacity %d\n", s.ID, sol.Load[i], s.Capacity)
		}
	}
	b.WriteString("assignment (demand -> site, distance):\n")
	for j, d := range inst.Demands {
		i := sol.Assign[j]
		fmt.Fprintf(&b, "  demand %d (size %d) -> site %d, dist %.4f\n",
			d.ID, d.Size, inst.Sites[i].ID, dist(d.X, d.Y, inst.Sites[i].X, inst.Sites[i].Y))
	}
	return b.String()
}
