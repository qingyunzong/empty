package main

import (
	"fmt"
	"sort"
)

// Window is a half-open tidal window [Start, End) in absolute minutes.
// Absolute time allows intervals to cross midnight (e.g. 1320..1560).
type Window struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Ship describes one vessel to schedule.
type Ship struct {
	ID       string `json:"id"`
	Length   int    `json:"length"`   // meters alongside
	Arrival  int    `json:"arrival"`  // absolute minutes
	Duration int    `json:"duration"` // service minutes
	// Starts optionally pins the discrete candidate start times (absolute
	// minutes). When empty, candidates are generated from the tidal windows
	// using Problem.Step.
	Starts []int `json:"starts,omitempty"`
}

// Problem is a berth scheduling instance: one berth whose total length is
// shared by all concurrently moored ships, plus tidal windows during which
// service must take place.
type Problem struct {
	BerthLength int      `json:"berth_length"` // total quay length, meters
	Step        int      `json:"step"`         // candidate grid step, minutes
	Tides       []Window `json:"tides"`        // half-open service windows
	Ships       []Ship   `json:"ships"`
}

// MaxShips bounds the instance size ("至多12艘船").
const MaxShips = 12

// Assignment is the scheduled half-open occupancy [Start, End) of one ship.
type Assignment struct {
	ShipIndex int
	Start     int
	End       int
	Wait      int
}

// Solution is the optimizer result.
type Solution struct {
	Assignments []Assignment
	TotalWait   int
	Makespan    int // max End over all assignments
}

// Validate checks structural constraints of the instance.
func (p *Problem) Validate() error {
	if p.BerthLength <= 0 {
		return fmt.Errorf("berth_length must be positive, got %d", p.BerthLength)
	}
	if p.Step <= 0 {
		return fmt.Errorf("step must be positive, got %d", p.Step)
	}
	if len(p.Tides) == 0 {
		return fmt.Errorf("at least one tidal window is required")
	}
	for i, w := range p.Tides {
		if w.Start < 0 || w.End <= w.Start {
			return fmt.Errorf("tides[%d]: invalid window [%d, %d)", i, w.Start, w.End)
		}
	}
	if len(p.Ships) == 0 {
		return fmt.Errorf("at least one ship is required")
	}
	if len(p.Ships) > MaxShips {
		return fmt.Errorf("too many ships: %d > %d", len(p.Ships), MaxShips)
	}
	seen := map[string]bool{}
	for i, s := range p.Ships {
		if s.ID == "" {
			return fmt.Errorf("ships[%d]: empty id", i)
		}
		if seen[s.ID] {
			return fmt.Errorf("ships[%d]: duplicate id %q", i, s.ID)
		}
		seen[s.ID] = true
		if s.Length <= 0 {
			return fmt.Errorf("ship %q: length must be positive", s.ID)
		}
		if s.Length > p.BerthLength {
			return fmt.Errorf("ship %q: length %d exceeds berth length %d", s.ID, s.Length, p.BerthLength)
		}
		if s.Arrival < 0 {
			return fmt.Errorf("ship %q: negative arrival %d", s.ID, s.Arrival)
		}
		if s.Duration <= 0 {
			return fmt.Errorf("ship %q: duration must be positive", s.ID)
		}
	}
	return nil
}

// inSomeWindow reports whether the half-open interval [s, e) is fully
// contained in at least one tidal window.
func (p *Problem) inSomeWindow(s, e int) bool {
	for _, w := range p.Tides {
		if s >= w.Start && e <= w.End {
			return true
		}
	}
	return false
}

// Candidates returns the sorted, deduplicated feasible discrete start times
// for a ship: start >= arrival and [start, start+duration) inside one window.
func (p *Problem) Candidates(s Ship) ([]int, error) {
	var out []int
	if len(s.Starts) > 0 {
		for _, t := range s.Starts {
			if t < s.Arrival {
				return nil, fmt.Errorf("ship %q: candidate start %d before arrival %d", s.ID, t, s.Arrival)
			}
			if !p.inSomeWindow(t, t+s.Duration) {
				return nil, fmt.Errorf("ship %q: candidate [%d, %d) outside all tidal windows", s.ID, t, t+s.Duration)
			}
			out = append(out, t)
		}
	} else {
		for _, w := range p.Tides {
			lo := s.Arrival
			if w.Start > lo {
				lo = w.Start
			}
			for t := lo; t+s.Duration <= w.End; t += p.Step {
				out = append(out, t)
			}
		}
	}
	sort.Ints(out)
	// dedupe
	uniq := out[:0]
	for i, t := range out {
		if i == 0 || t != out[i-1] {
			uniq = append(uniq, t)
		}
	}
	if len(uniq) == 0 {
		return nil, fmt.Errorf("ship %q: no feasible candidate start times", s.ID)
	}
	return uniq, nil
}

// feasible reports whether a full set of half-open occupancies respects the
// berth length capacity at every instant.
func (p *Problem) feasible(starts []int) bool {
	type ev struct {
		t, delta int
	}
	var evs []ev
	for i, s := range p.Ships {
		evs = append(evs, ev{starts[i], s.Length}, ev{starts[i] + s.Duration, -s.Length})
	}
	sort.Slice(evs, func(a, b int) bool {
		// ends before starts at the same instant (half-open semantics)
		if evs[a].t != evs[b].t {
			return evs[a].t < evs[b].t
		}
		return evs[a].delta < evs[b].delta
	})
	load := 0
	for _, e := range evs {
		load += e.delta
		if load > p.BerthLength {
			return false
		}
	}
	return true
}

// evaluate computes the objective for a complete feasible start vector.
func (p *Problem) evaluate(starts []int) Solution {
	sol := Solution{Assignments: make([]Assignment, len(p.Ships))}
	for i, s := range p.Ships {
		end := starts[i] + s.Duration
		sol.Assignments[i] = Assignment{ShipIndex: i, Start: starts[i], End: end, Wait: starts[i] - s.Arrival}
		sol.TotalWait += starts[i] - s.Arrival
		if end > sol.Makespan {
			sol.Makespan = end
		}
	}
	return sol
}

// better reports whether solution a beats b: primary total wait, then makespan.
func better(a, b Solution) bool {
	if a.TotalWait != b.TotalWait {
		return a.TotalWait < b.TotalWait
	}
	return a.Makespan < b.Makespan
}

// fmtAbs renders absolute minutes as "d<day> HH:MM" (day 0 based), making
// post-midnight times explicit.
func fmtAbs(t int) string {
	return fmt.Sprintf("d%d %02d:%02d", t/1440, (t%1440)/60, t%60)
}
