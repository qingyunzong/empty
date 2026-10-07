package recipe

// BruteForce is an independent, deliberately naive enumerator used to
// cross-check Solve on small instances. It shares no search code with
// the branch-and-bound solver: it simply walks every quantity vector
// in lexicographic order and keeps the best fully feasible one via
// Evaluate. Intended only for small problems.
func BruteForce(p *Problem) *Solution {
	if err := p.Validate(); err != nil {
		panic(err)
	}
	n := len(p.Ingredients)
	qty := make([]int, n)
	var best *Solution
	var walk func(i int)
	walk = func(i int) {
		if i == n {
			if sol, err := p.Evaluate(qty); err == nil && better(sol, best) {
				best = sol
			}
			return
		}
		for q := 0; q <= p.MaxUnits; q++ {
			qty[i] = q
			walk(i + 1)
		}
		qty[i] = 0
	}
	walk(0)
	return best
}
