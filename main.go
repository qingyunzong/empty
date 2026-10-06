// Command seatalloc assigns at most 10 groups to consecutive seats in the
// same row. A group may span empty seats but is never split across rows or
// across blocked seats. Blocked seats are unusable. The solver first
// minimizes the number of unseated people, then the total distance, where
// each seated person contributes |column - TargetCol|.
package main

import (
	"fmt"
	"sort"
	"strings"
)

// Row describes one row of seats. Columns are 0-based.
type Row struct {
	Length  int
	Blocked map[int]bool
}

// Problem is a seat-allocation instance.
type Problem struct {
	Rows      []Row
	Groups    []int // group sizes, at most 10 groups
	TargetCol int   // designated column for the distance metric
}

// Placement seats Group (original index) in Row starting at column Start.
type Placement struct {
	Group int
	Row   int
	Start int
}

// Solution is the optimal assignment.
type Solution struct {
	Unseated   int // number of people without a seat
	Distance   int // total |col - TargetCol| over seated people
	Placements []Placement
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// Solve finds an assignment minimizing (Unseated, Distance)
// lexicographically via branch and bound over group placements.
func Solve(p Problem) Solution {
	n := len(p.Groups)
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		if p.Groups[order[a]] != p.Groups[order[b]] {
			return p.Groups[order[a]] > p.Groups[order[b]] // large groups first
		}
		return order[a] < order[b]
	})

	// pref[r][c] = total distance of columns [0, c) in row r.
	pref := make([][]int, len(p.Rows))
	occ := make([][]bool, len(p.Rows))
	for r, row := range p.Rows {
		pref[r] = make([]int, row.Length+1)
		occ[r] = make([]bool, row.Length)
		for c := 0; c < row.Length; c++ {
			pref[r][c+1] = pref[r][c] + abs(c-p.TargetCol)
		}
	}

	const inf = int(^uint(0) >> 1)
	best := Solution{Unseated: inf, Distance: inf}
	cur := make([]Placement, 0, n)

	var dfs func(idx, unseated, dist int)
	dfs = func(idx, unseated, dist int) {
		if unseated > best.Unseated || (unseated == best.Unseated && dist >= best.Distance) {
			return
		}
		if idx == n {
			best.Unseated = unseated
			best.Distance = dist
			best.Placements = append([]Placement(nil), cur...)
			return
		}
		g := order[idx]
		size := p.Groups[g]
		for r := range p.Rows {
			row := p.Rows[r]
			for start := 0; start+size <= row.Length; start++ {
				ok := true
				for c := start; c < start+size; c++ {
					if row.Blocked[c] || occ[r][c] {
						ok = false
						break
					}
				}
				if !ok {
					continue
				}
				for c := start; c < start+size; c++ {
					occ[r][c] = true
				}
				cur = append(cur, Placement{Group: g, Row: r, Start: start})
				dfs(idx+1, unseated, dist+pref[r][start+size]-pref[r][start])
				cur = cur[:len(cur)-1]
				for c := start; c < start+size; c++ {
					occ[r][c] = false
				}
			}
		}
		dfs(idx+1, unseated+size, dist) // leave the group unseated
	}
	dfs(0, 0, 0)

	sort.Slice(best.Placements, func(a, b int) bool {
		return best.Placements[a].Group < best.Placements[b].Group
	})
	return best
}

// Layout renders the solution: '#' blocked, '.' empty, 'A'+group index seated.
func Layout(p Problem, s Solution) string {
	var b strings.Builder
	for r, row := range p.Rows {
		cells := make([]byte, row.Length)
		for c := range cells {
			if row.Blocked[c] {
				cells[c] = '#'
			} else {
				cells[c] = '.'
			}
		}
		for _, pl := range s.Placements {
			if pl.Row != r {
				continue
			}
			for c := pl.Start; c < pl.Start+p.Groups[pl.Group]; c++ {
				cells[c] = byte('A' + pl.Group)
			}
		}
		fmt.Fprintf(&b, "row %d: %s\n", r, string(cells))
	}
	fmt.Fprintf(&b, "unseated=%d distance=%d\n", s.Unseated, s.Distance)
	return b.String()
}

func main() {
	p := Problem{
		Rows: []Row{
			{Length: 8, Blocked: map[int]bool{3: true}},
			{Length: 6},
			{Length: 5, Blocked: map[int]bool{0: true, 4: true}},
		},
		Groups:    []int{3, 2, 4, 1, 2},
		TargetCol: 2,
	}
	sol := Solve(p)
	fmt.Print(Layout(p, sol))
}
