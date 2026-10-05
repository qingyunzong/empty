package cut

type resource struct{ length, cost int }

// BruteForce independently verifies Solve on small instances by
// enumerating every set partition of pieces into <= maxBars slots and,
// for each partition, solving the slot->resource assignment exactly.
// Only feasible for tiny jobs (a handful of pieces and bars).
func BruteForce(job Job) (purchase, scrap int, ok bool) {
	if err := validate(job); err != nil {
		return 0, 0, false
	}
	maxBars, err := normMaxBars(job)
	if err != nil {
		return 0, 0, false
	}
	pieces := expandPieces(job)
	if len(pieces) == 0 {
		return 0, 0, true
	}
	var resources []resource
	for _, b := range job.Inventory {
		resources = append(resources, resource{b.Length, 0})
	}
	for _, t := range job.StockTypes {
		cnt := t.Max
		if cnt == 0 || cnt > maxBars {
			cnt = maxBars
		}
		for i := 0; i < cnt; i++ {
			resources = append(resources, resource{t.Length, t.Cost})
		}
	}
	needs := make([]int, maxBars)
	found := false
	bestPurch, bestScrap := 0, 0
	var assign func(i, slots int)
	assign = func(i, slots int) {
		if i == len(pieces) {
			p, s, ok2 := matchResources(needs[:slots], resources, job.ScrapThreshold)
			if !ok2 {
				return
			}
			if !found || p < bestPurch || (p == bestPurch && s < bestScrap) {
				found, bestPurch, bestScrap = true, p, s
			}
			return
		}
		need := pieces[i].length + job.Kerf
		limit := slots
		if limit > maxBars-1 {
			limit = maxBars - 1
		}
		for sn := 0; sn <= limit; sn++ {
			needs[sn] += need
			ns := slots
			if sn == slots {
				ns++
			}
			assign(i+1, ns)
			needs[sn] -= need
		}
	}
	assign(0, 0)
	return bestPurch, bestScrap, found
}

// matchResources assigns each slot a distinct resource with
// length >= need, minimizing (cost, scrap) lexicographically.
func matchResources(needs []int, resources []resource, threshold int) (int, int, bool) {
	used := make([]bool, len(resources))
	found := false
	bestCost, bestScrap := 0, 0
	var dfs func(slot, cost, scrap int)
	dfs = func(sn, cost, scrap int) {
		if sn == len(needs) {
			if !found || cost < bestCost || (cost == bestCost && scrap < bestScrap) {
				found, bestCost, bestScrap = true, cost, scrap
			}
			return
		}
		seen := map[[2]int]bool{}
		for ri, r := range resources {
			key := [2]int{r.length, r.cost}
			if used[ri] || r.length < needs[sn] || seen[key] {
				continue
			}
			seen[key] = true
			lo := r.length - needs[sn]
			sc := 0
			if lo > 0 && lo < threshold {
				sc = lo
			}
			used[ri] = true
			dfs(sn+1, cost+r.cost, scrap+sc)
			used[ri] = false
		}
	}
	dfs(0, 0, 0)
	return bestCost, bestScrap, found
}
