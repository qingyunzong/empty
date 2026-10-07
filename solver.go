package main

import "sort"

// Placement describes where one seated group was placed.
type Placement struct {
	Group int // 0-based group index
	Start int // 0-based first column occupied by the group
}

// Result is the outcome of a seat allocation.
type Result struct {
	Unseated   int         // number of people that could not be seated
	Distance   int         // total |column - target| over all seated people
	Placements []Placement // placement of every seated group
	Layout     string      // one char per seat: '#' blocked, '.' empty, 'A'+group seated
}

// cost is the optimization pair: maximize seated people, then minimize
// total distance to the target column.
type cost struct {
	people int
	dist   int
}

// better reports whether a is strictly preferred over b.
func (a cost) better(b cost) bool {
	if a.people != b.people {
		return a.people > b.people
	}
	return a.dist < b.dist
}

// Solve allocates groups to one row of seats. available[i] reports whether
// seat i (0-based) is usable (false = blocked). Every seated group occupies
// exactly sizes[g] consecutive usable seats; groups never overlap and may be
// separated by arbitrary empty seats. The primary objective is minimizing
// the number of unseated people, the secondary objective is minimizing the
// total absolute distance of seated people to column target (0-based).
//
// It runs a subset DP over the row: dp[i][mask] is the best cost using only
// seats before i while seating exactly the groups in mask. Complexity is
// O(n * 2^g * g) which is fine for g <= 10.
func Solve(available []bool, sizes []int, target int) Result {
	n := len(available)
	g := len(sizes)
	total := 0
	for _, s := range sizes {
		total += s
	}

	// availPrefix: number of usable seats before i; distPrefix: sum of
	// |c - target| over columns c < i. Both give O(1) range queries.
	availPrefix := make([]int, n+1)
	distPrefix := make([]int, n+1)
	for i := 0; i < n; i++ {
		availPrefix[i+1] = availPrefix[i]
		if available[i] {
			availPrefix[i+1]++
		}
		d := i - target
		if d < 0 {
			d = -d
		}
		distPrefix[i+1] = distPrefix[i] + d
	}
	fits := func(p, s int) bool {
		return p+s <= n && availPrefix[p+s]-availPrefix[p] == s
	}
	blockDist := func(p, s int) int { return distPrefix[p+s] - distPrefix[p] }

	full := 1 << uint(g)
	states := (n + 1) * full
	dp := make([]cost, states)
	ok := make([]bool, states)
	parentPos := make([]int32, states) // seat index of the previous state
	parentGrp := make([]int16, states) // group placed by the transition, -1 = seat left empty
	ok[0] = true

	for i := 0; i <= n; i++ {
		base := i * full
		for mask := 0; mask < full; mask++ {
			idx := base + mask
			if !ok[idx] {
				continue
			}
			cur := dp[idx]
			relax := func(ni, nmask int, nc cost, grp int16) {
				j := ni*full + nmask
				if !ok[j] || nc.better(dp[j]) {
					ok[j] = true
					dp[j] = nc
					parentPos[j] = int32(i)
					parentGrp[j] = grp
				}
			}
			if i < n {
				// Leave seat i empty (always allowed, also for blocked seats).
				relax(i+1, mask, cur, -1)
				// Start a not-yet-seated group at seat i.
				if available[i] {
					for grp := 0; grp < g; grp++ {
						bit := 1 << uint(grp)
						if mask&bit != 0 {
							continue
						}
						s := sizes[grp]
						if fits(i, s) {
							relax(i+s, mask|bit,
								cost{cur.people + s, cur.dist + blockDist(i, s)},
								int16(grp))
						}
					}
				}
			}
		}
	}

	// Best final state: any mask reachable after processing the whole row.
	bestMask := -1
	var best cost
	for mask := 0; mask < full; mask++ {
		idx := n*full + mask
		if ok[idx] && (bestMask < 0 || dp[idx].better(best)) {
			bestMask = mask
			best = dp[idx]
		}
	}

	// Walk parents back from (n, bestMask) to recover the layout.
	var placements []Placement
	for i, mask := n, bestMask; i != 0 || mask != 0; {
		idx := i*full + mask
		prev := int(parentPos[idx])
		grp := parentGrp[idx]
		if grp >= 0 {
			placements = append(placements, Placement{Group: int(grp), Start: prev})
			mask ^= 1 << uint(grp)
		}
		i = prev
	}
	sort.Slice(placements, func(a, b int) bool { return placements[a].Group < placements[b].Group })

	return buildResult(available, sizes, total, best, placements)
}

// buildResult assembles a Result from a chosen set of placements.
func buildResult(available []bool, sizes []int, total int, best cost, placements []Placement) Result {
	row := make([]byte, len(available))
	for i := range row {
		if available[i] {
			row[i] = '.'
		} else {
			row[i] = '#'
		}
	}
	for _, p := range placements {
		for c := p.Start; c < p.Start+sizes[p.Group]; c++ {
			row[c] = byte('A' + p.Group)
		}
	}
	return Result{
		Unseated:   total - best.people,
		Distance:   best.dist,
		Placements: placements,
		Layout:     string(row),
	}
}
