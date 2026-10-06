package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Window is a half-open tidal window [Start, End) in absolute minutes.
// A ship's whole occupancy must fit inside one window.
type Window struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Ship describes one vessel. All times are absolute minutes, so values
// may exceed 1440 (ships are allowed to cross midnight).
type Ship struct {
	ID           string   `json:"id"`
	Length       int      `json:"length"`
	Arrival      int      `json:"arrival"`
	Duration     int      `json:"duration"`
	TidalWindows []Window `json:"tidal_windows"`
	Candidates   []int    `json:"candidates"`
}

type Berth struct {
	ID     string `json:"id"`
	Length int    `json:"length"`
}

type Problem struct {
	Berths []Berth `json:"berths"`
	Ships  []Ship  `json:"ships"`
}

// Assignment is a half-open occupancy [Start, End) of a berth.
type Assignment struct {
	Ship  string `json:"ship"`
	Berth string `json:"berth"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

type Solution struct {
	TotalWait   int          `json:"total_wait"`
	TotalEnd    int          `json:"total_end"`
	Assignments []Assignment `json:"assignments"`
}

const maxShips = 12

// Validate checks structural constraints of the input problem.
func (p Problem) Validate() error {
	if len(p.Ships) == 0 {
		return errors.New("no ships given")
	}
	if len(p.Ships) > maxShips {
		return fmt.Errorf("too many ships: %d > %d", len(p.Ships), maxShips)
	}
	if len(p.Berths) == 0 {
		return errors.New("no berths given")
	}
	seen := make(map[string]bool)
	for _, b := range p.Berths {
		if b.ID == "" {
			return errors.New("berth with empty id")
		}
		if seen[b.ID] {
			return fmt.Errorf("duplicate berth id %q", b.ID)
		}
		seen[b.ID] = true
		if b.Length <= 0 {
			return fmt.Errorf("berth %s: length must be positive", b.ID)
		}
	}
	seen = make(map[string]bool)
	for _, s := range p.Ships {
		if s.ID == "" {
			return errors.New("ship with empty id")
		}
		if seen[s.ID] {
			return fmt.Errorf("duplicate ship id %q", s.ID)
		}
		seen[s.ID] = true
		if s.Length <= 0 {
			return fmt.Errorf("ship %s: length must be positive", s.ID)
		}
		if s.Duration <= 0 {
			return fmt.Errorf("ship %s: duration must be positive", s.ID)
		}
		if len(s.Candidates) == 0 {
			return fmt.Errorf("ship %s: no candidate start times", s.ID)
		}
		for _, c := range s.Candidates {
			if c < s.Arrival {
				return fmt.Errorf("ship %s: candidate %d before arrival %d", s.ID, c, s.Arrival)
			}
		}
		for _, w := range s.TidalWindows {
			if w.Start >= w.End {
				return fmt.Errorf("ship %s: invalid tidal window [%d, %d)", s.ID, w.Start, w.End)
			}
		}
	}
	return nil
}

// feasibleStarts returns the sorted candidate starts whose whole occupancy
// [c, c+Duration) fits inside at least one tidal window.
func feasibleStarts(s Ship) []int {
	var out []int
	for _, c := range s.Candidates {
		end := c + s.Duration
		for _, w := range s.TidalWindows {
			if w.Start <= c && end <= w.End {
				out = append(out, c)
				break
			}
		}
	}
	sort.Ints(out)
	return out
}

type interval struct{ start, end int }

// overlaps reports half-open overlap: [s,e) vs stored intervals.
func overlaps(ivs []interval, s, e int) bool {
	for _, iv := range ivs {
		if s < iv.end && iv.start < e {
			return true
		}
	}
	return false
}

func solutionKey(assign []Assignment) string {
	var sb strings.Builder
	for _, a := range assign {
		fmt.Fprintf(&sb, "%s=%s@%d;", a.Ship, a.Berth, a.Start)
	}
	return sb.String()
}

// Solve finds a schedule minimizing total waiting time (sum of
// start-arrival). Ties break on total completion time, then
// lexicographically for determinism.
func Solve(p Problem, brute bool) (Solution, error) {
	if err := p.Validate(); err != nil {
		return Solution{}, err
	}
	if brute {
		return solveBrute(p)
	}
	return solveExact(p)
}

// solveExact is a branch-and-bound DFS: ships are ordered by fewest
// feasible starts, and branches are pruned with a lower bound on the
// additional waiting time of the remaining ships.
func solveExact(p Problem) (Solution, error) {
	n := len(p.Ships)
	feas := make([][]int, n)
	minWait := make([]int, n)
	for i, s := range p.Ships {
		f := feasibleStarts(s)
		if len(f) == 0 {
			return Solution{}, fmt.Errorf("ship %s has no candidate start inside its tidal windows", s.ID)
		}
		feas[i] = f
		minWait[i] = f[0] - s.Arrival
	}
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		if len(feas[order[a]]) != len(feas[order[b]]) {
			return len(feas[order[a]]) < len(feas[order[b]])
		}
		return p.Ships[order[a]].ID < p.Ships[order[b]].ID
	})
	suffix := make([]int, n+1)
	for i := n - 1; i >= 0; i-- {
		suffix[i] = suffix[i+1] + minWait[order[i]]
	}

	occ := make([][]interval, len(p.Berths))
	assign := make([]Assignment, n)
	var best *Solution
	bestWait, bestEnd := 0, 0
	bestKey := ""

	var dfs func(k, curWait, curEnd int)
	dfs = func(k, curWait, curEnd int) {
		if best != nil && curWait+suffix[k] > bestWait {
			return
		}
		if k == n {
			key := solutionKey(assign)
			if best == nil || curWait < bestWait ||
				(curWait == bestWait && (curEnd < bestEnd || (curEnd == bestEnd && key < bestKey))) {
				cp := make([]Assignment, n)
				copy(cp, assign)
				best = &Solution{TotalWait: curWait, TotalEnd: curEnd, Assignments: cp}
				bestWait, bestEnd, bestKey = curWait, curEnd, key
			}
			return
		}
		si := order[k]
		s := p.Ships[si]
		for bi, b := range p.Berths {
			if b.Length < s.Length {
				continue
			}
			for _, st := range feas[si] {
				en := st + s.Duration
				if overlaps(occ[bi], st, en) {
					continue
				}
				w := curWait + (st - s.Arrival)
				if best != nil && w+suffix[k+1] > bestWait {
					continue
				}
				occ[bi] = append(occ[bi], interval{st, en})
				assign[si] = Assignment{Ship: s.ID, Berth: b.ID, Start: st, End: en}
				dfs(k+1, w, curEnd+en)
				occ[bi] = occ[bi][:len(occ[bi])-1]
			}
		}
	}
	dfs(0, 0, 0)
	if best == nil {
		return Solution{}, errors.New("infeasible: no valid schedule exists")
	}
	return *best, nil
}

// ValidateSolution independently checks that a solution respects every
// constraint: half-open occupancies, tidal containment, berth length,
// candidate starts, and no per-berth overlap.
func ValidateSolution(p Problem, sol Solution) error {
	ships := make(map[string]Ship, len(p.Ships))
	for _, s := range p.Ships {
		ships[s.ID] = s
	}
	berths := make(map[string]Berth, len(p.Berths))
	for _, b := range p.Berths {
		berths[b.ID] = b
	}
	if len(sol.Assignments) != len(p.Ships) {
		return fmt.Errorf("expected %d assignments, got %d", len(p.Ships), len(sol.Assignments))
	}
	seen := make(map[string]bool)
	occ := make(map[string][]interval)
	totalWait := 0
	for _, a := range sol.Assignments {
		s, ok := ships[a.Ship]
		if !ok {
			return fmt.Errorf("unknown ship %q", a.Ship)
		}
		if seen[a.Ship] {
			return fmt.Errorf("ship %s assigned twice", a.Ship)
		}
		seen[a.Ship] = true
		b, ok := berths[a.Berth]
		if !ok {
			return fmt.Errorf("unknown berth %q", a.Berth)
		}
		if b.Length < s.Length {
			return fmt.Errorf("ship %s (len %d) exceeds berth %s (len %d)", s.ID, s.Length, b.ID, b.Length)
		}
		if a.End != a.Start+s.Duration {
			return fmt.Errorf("ship %s: end %d != start %d + duration %d", s.ID, a.End, a.Start, s.Duration)
		}
		if a.Start < s.Arrival {
			return fmt.Errorf("ship %s starts before arrival", s.ID)
		}
		isCandidate := false
		for _, c := range s.Candidates {
			if c == a.Start {
				isCandidate = true
				break
			}
		}
		if !isCandidate {
			return fmt.Errorf("ship %s: start %d is not a candidate", s.ID, a.Start)
		}
		inWindow := false
		for _, w := range s.TidalWindows {
			if w.Start <= a.Start && a.End <= w.End {
				inWindow = true
				break
			}
		}
		if !inWindow {
			return fmt.Errorf("ship %s: [%d, %d) not contained in any tidal window", s.ID, a.Start, a.End)
		}
		if overlaps(occ[a.Berth], a.Start, a.End) {
			return fmt.Errorf("berth %s: overlap at [%d, %d)", a.Berth, a.Start, a.End)
		}
		occ[a.Berth] = append(occ[a.Berth], interval{a.Start, a.End})
		totalWait += a.Start - s.Arrival
	}
	if totalWait != sol.TotalWait {
		return fmt.Errorf("total wait mismatch: got %d, want %d", sol.TotalWait, totalWait)
	}
	return nil
}
