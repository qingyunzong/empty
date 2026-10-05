package recipe

// BruteForce is an independent enumerator used to cross-check Solve on
// small instances. It shares no search code with the branch-and-bound
// solver: it simply visits every count vector and keeps the best one
// that CheckFeasible accepts. Running time is (MaxUnits+1)^n, so it is
// only practical for small instances.
func BruteForce(in *Instance) (best []int, bestEval Eval, found bool) {
	n := len(in.Ingredients)
	counts := make([]int, n)
	var rec func(i int)
	rec = func(i int) {
		if i == n {
			if in.CheckFeasible(counts) != nil {
				return
			}
			ev := in.Evaluate(counts)
			if !found || betterEval(ev, bestEval) {
				found = true
				bestEval = ev
				best = append([]int(nil), counts...)
			}
			return
		}
		for c := 0; c <= in.MaxUnits; c++ {
			counts[i] = c
			rec(i + 1)
		}
		counts[i] = 0
	}
	rec(0)
	return best, bestEval, found
}
