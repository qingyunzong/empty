package signal

import (
	"errors"
	"fmt"
)

// ErrInfeasible reports that no schedule can satisfy every phase minimum
// within the cycle under the conflict constraints.
var ErrInfeasible = errors.New("infeasible: minimum green times cannot be accommodated within the cycle")

// Certificate is a complete, independently checkable cycle schedule.
type Certificate struct {
	Cycle int `json:"cycle"`
	Cost  int `json:"cost"`
	// Green[i] is the number of slots in which phase i is released.
	Green []int `json:"green"`
	// Slots lists, for every slot of the cycle, the set of phase
	// indices released simultaneously. Each set is conflict-free.
	Slots   [][]int `json:"slots"`
	Optimal bool    `json:"optimal"`
	Method  string  `json:"method"`
}

// independentSets returns all non-empty conflict-free phase sets as bitmasks.
func independentSets(adj []uint64) []uint64 {
	n := len(adj)
	var sets []uint64
	for mask := uint64(1); mask < 1<<n; mask++ {
		ok := true
		for i := 0; i < n && ok; i++ {
			if mask&(1<<i) != 0 && adj[i]&mask != 0 {
				ok = false
			}
		}
		if ok {
			sets = append(sets, mask)
		}
	}
	return sets
}

// maskMembers decodes a phase bitmask into ascending indices.
func maskMembers(mask uint64, n int) []int {
	out := []int{}
	for j := 0; j < n; j++ {
		if mask&(1<<j) != 0 {
			out = append(out, j)
		}
	}
	return out
}

const bitsPerPhase = 6 // enough for green counts 0..63 (cycle <= 60)

func unpack(key uint64, idx int) int {
	return int(key>>(bitsPerPhase*idx)) & 63
}

type parent struct {
	prev uint64
	set  uint64
}

// Solve computes a minimum-cost schedule by an exact breadth-first
// search over green-count vectors. Layer t holds every green vector
// realizable with exactly t slots, so the first time a vector is
// reached its distance equals the minimum number of slots it needs.
// The answer is the cheapest vector with distance <= Cycle that meets
// all phase minimums. maxStates bounds the explored state space.
func Solve(p *Problem, maxStates int) (*Certificate, error) {
	n := len(p.Phases)
	adj := p.adjacency()
	sets := independentSets(adj)
	members := make([][]int, len(sets))
	for i, s := range sets {
		members[i] = maskMembers(s, n)
	}

	dist := map[uint64]int{0: 0}
	par := map[uint64]parent{}
	frontier := []uint64{0}
	for t := 1; t <= p.Cycle && len(frontier) > 0; t++ {
		var next []uint64
		for _, v := range frontier {
			for si, mem := range members {
				v2 := v
				ok := true
				for _, j := range mem {
					if unpack(v2, j) >= p.Cycle {
						ok = false
						break
					}
					v2 += 1 << (bitsPerPhase * j)
				}
				if !ok {
					continue
				}
				if _, seen := dist[v2]; seen {
					continue
				}
				dist[v2] = t
				par[v2] = parent{prev: v, set: sets[si]}
				next = append(next, v2)
			}
		}
		if len(dist) > maxStates {
			return nil, fmt.Errorf("state space exceeded %d green vectors; instance too large", maxStates)
		}
		frontier = next
	}

	bestCost := 0
	var bestKey uint64
	found := false
	for v := range dist {
		ok := true
		for i := 0; i < n; i++ {
			if unpack(v, i) < p.Phases[i].Min {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		c := 0
		for i := 0; i < n; i++ {
			c += p.Phases[i].Cost[unpack(v, i)]
		}
		if !found || c < bestCost {
			found, bestCost, bestKey = true, c, v
		}
	}
	if !found {
		return nil, ErrInfeasible
	}

	var path []uint64
	for v := bestKey; v != 0; {
		pr := par[v]
		path = append(path, pr.set)
		v = pr.prev
	}
	slots := make([][]int, 0, p.Cycle)
	for i := len(path) - 1; i >= 0; i-- {
		slots = append(slots, maskMembers(path[i], n))
	}
	for len(slots) < p.Cycle {
		slots = append(slots, []int{})
	}
	green := make([]int, n)
	for i := range green {
		green[i] = unpack(bestKey, i)
	}
	return &Certificate{
		Cycle:   p.Cycle,
		Cost:    bestCost,
		Green:   green,
		Slots:   slots,
		Optimal: true,
		Method:  "dp",
	}, nil
}
