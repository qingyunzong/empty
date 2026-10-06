package main

import "fmt"

// bruteForce enumerates every legal allocation (register-resident subset
// per point) and returns the exact minimum cost. Used to cross-check the
// DP on small instances.
func bruteForce(in *Input) (int, error) {
	if err := validate(in); err != nil {
		return 0, err
	}
	inst := buildInstance(in)

	// Count the search space first; refuse if too large.
	options := 1
	for p := 0; p < inst.numPoints; p++ {
		n := len(inst.live[p])
		k := len(inst.avail[p])
		cnt := 0
		enumSubsets(inst.live[p], k, func(uint32) { cnt++ })
		options *= cnt
		if options > 50_000_000 {
			return 0, fmt.Errorf("instance too large for exhaustive check (~%d combinations)", options)
		}
		_ = n
	}

	best := -1
	var rec func(p int, prev uint32, cost int)
	rec = func(p int, prev uint32, cost int) {
		if best >= 0 && cost >= best {
			return
		}
		if p == inst.numPoints {
			if best < 0 || cost < best {
				best = cost
			}
			return
		}
		enumSubsets(inst.live[p], len(inst.avail[p]), func(cur uint32) {
			rec(p+1, cur, cost+inst.transitionCost(p, prev, cur))
		})
	}
	rec(0, 0, 0)
	if best < 0 {
		return 0, fmt.Errorf("no feasible allocation")
	}
	return best, nil
}
