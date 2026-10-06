package main

import "sort"

// scheduleLimit bounds the backtracking work of the exact scheduler.
const scheduleLimit = 4_000_000

// Schedule finds a slot assignment for the given green demands:
// slots[s] is the bitmask of phases green at slot s. It returns nil if
// no assignment exists (or the search budget is exhausted).
//
// Slots carrying the same occupancy mask are interchangeable, so the
// search only decides how many slots to take from each mask group, which
// keeps the exact search small even for 60-slot cycles.
func Schedule(inst *Instance, g []int) []uint64 {
	n := len(inst.Phases)
	adj := inst.adjacency()
	used := make([]uint64, inst.Cycle)

	// Assign most-demanding phases first.
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		if g[order[a]] != g[order[b]] {
			return g[order[a]] > g[order[b]]
		}
		return popcount(adj[order[a]]) > popcount(adj[order[b]])
	})

	nodes := 0
	var dfs func(k int) bool
	dfs = func(k int) bool {
		if k == n {
			return true
		}
		nodes++
		if nodes > scheduleLimit {
			return false
		}
		// Forward check: every remaining phase must still have enough slots.
		for j := k; j < n; j++ {
			ph := order[j]
			free := 0
			for s := 0; s < inst.Cycle; s++ {
				if used[s]&adj[ph] == 0 {
					free++
				}
			}
			if free < g[ph] {
				return false
			}
		}
		ph := order[k]
		nb := adj[ph]
		// Group available slots by occupancy mask; prefer already-busy
		// slots to keep empty slots available for later phases.
		type group struct {
			mask  uint64
			slots []int
		}
		groupIdx := map[uint64]int{}
		var groups []group
		for s := 0; s < inst.Cycle; s++ {
			if used[s]&nb != 0 {
				continue
			}
			idx, ok := groupIdx[used[s]]
			if !ok {
				idx = len(groups)
				groupIdx[used[s]] = idx
				groups = append(groups, group{mask: used[s]})
			}
			groups[idx].slots = append(groups[idx].slots, s)
		}
		sort.Slice(groups, func(a, b int) bool {
			if popcount(groups[a].mask) != popcount(groups[b].mask) {
				return popcount(groups[a].mask) > popcount(groups[b].mask)
			}
			return len(groups[a].slots) > len(groups[b].slots)
		})
		bit := uint64(1) << ph
		takes := make([]int, len(groups))
		var assign func(idx, left int) bool
		assign = func(idx, left int) bool {
			if left == 0 {
				// Only takes[:idx] are set on the current path.
				for i, t := range takes[:idx] {
					for _, s := range groups[i].slots[:t] {
						used[s] |= bit
					}
				}
				if dfs(k + 1) {
					return true
				}
				for i, t := range takes[:idx] {
					for _, s := range groups[i].slots[:t] {
						used[s] &^= bit
					}
				}
				return false
			}
			if idx == len(groups) {
				return false
			}
			avail := len(groups[idx].slots)
			// Largest takes first: fill busy groups before empty ones.
			rest := 0
			for j := idx + 1; j < len(groups); j++ {
				rest += len(groups[j].slots)
			}
			for t := avail; t >= 0; t-- {
				if t > left {
					continue
				}
				if rest < left-t {
					break
				}
				takes[idx] = t
				if assign(idx+1, left-t) {
					return true
				}
			}
			takes[idx] = 0
			return false
		}
		return assign(0, g[ph])
	}
	if !dfs(0) {
		return nil
	}
	return used
}
