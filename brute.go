package main

import (
	"math"
	"math/bits"
)

// BruteSingleResult is the exhaustive-enumeration answer for one quorum.
type BruteSingleResult struct {
	Feasible bool
	Mask     uint64
	Cost     int64
	Subsets  int64
}

// BruteForceSingle enumerates all 2^n subsets and returns the cheapest
// legal quorum. Used to cross-check SolveSingle on small instances.
func BruteForceSingle(in *Instance, cons Constraints) BruteSingleResult {
	var res BruteSingleResult
	best := int64(math.MaxInt64)
	total := uint64(1) << uint(len(in.Nodes))
	for mask := uint64(0); mask < total; mask++ {
		res.Subsets++
		if !in.Legal(mask, cons) {
			continue
		}
		if c := in.Cost(mask); c < best {
			best = c
			res.Mask = mask
			res.Feasible = true
		}
	}
	if res.Feasible {
		res.Cost = best
	}
	return res
}

// BrutePairResult is the exhaustive-enumeration answer for a quorum pair.
type BrutePairResult struct {
	Feasible  bool
	R, W      uint64
	Cost      int64
	Subsets   int64
	FTQuorums int
	Pairs     int64
}

// BruteForcePair enumerates all fault-tolerant quorums and all unordered
// distinct pairs, returning the pair with minimum union cost subject to
// |R ∩ W| >= 2. Used to cross-check SolvePair on small instances.
func BruteForcePair(in *Instance, cons Constraints) BrutePairResult {
	var res BrutePairResult
	var ft []uint64
	total := uint64(1) << uint(len(in.Nodes))
	for mask := uint64(0); mask < total; mask++ {
		res.Subsets++
		if in.FTLegal(mask, cons) {
			ft = append(ft, mask)
		}
	}
	res.FTQuorums = len(ft)
	best := int64(math.MaxInt64)
	for i := 0; i < len(ft); i++ {
		for j := i + 1; j < len(ft); j++ {
			res.Pairs++
			if bits.OnesCount64(ft[i]&ft[j]) < 2 {
				continue
			}
			if u := in.Cost(ft[i] | ft[j]); u < best {
				best = u
				res.R, res.W = ft[i], ft[j]
				res.Feasible = true
			}
		}
	}
	if res.Feasible {
		res.Cost = best
	}
	return res
}
