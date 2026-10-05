// Package regalloc computes minimum-cost register allocations for live
// intervals over a small register file, with call-site reserved registers
// and spill load/store costs.
package regalloc

import (
	"errors"
	"fmt"
	"sort"
)

// Limits required by the problem statement.
const (
	MaxRegisters = 4
	MaxIntervals = 16
	MaxPoints    = 4096
	MaxCalls     = 512
)

// Interval is a live range [Start, End): the value is defined at Start and
// last used at End-1. Costs are paid when the value moves between a
// register and memory.
type Interval struct {
	ID        string `json:"id"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	LoadCost  int64  `json:"loadCost"`
	StoreCost int64  `json:"storeCost"`
}

// Call marks a program point where the registers in Reserved may not hold
// live values (they are reserved/clobbered by the call).
type Call struct {
	Point    int   `json:"point"`
	Reserved []int `json:"reserved"`
}

// Input describes one allocation problem.
type Input struct {
	NumRegisters int        `json:"numRegisters"`
	Intervals    []Interval `json:"intervals"`
	Calls        []Call     `json:"calls"`
}

// RegAssignment records where one interval lives at one point: a register
// index or memory.
type RegAssignment struct {
	Interval string `json:"interval"`
	Reg      int    `json:"reg"` // -1 means memory
}

// PointState is the occupancy at one program point.
type PointState struct {
	Point      int             `json:"point"`
	Reserved   []int           `json:"reserved,omitempty"`
	Assignment []RegAssignment `json:"assignment"`
}

// Event is one spill (store) or reload (load) action. It is part of the
// cost certificate.
type Event struct {
	Point    int    `json:"point"` // transition happens between Point-1 and Point
	Type     string `json:"type"`  // "store" or "load"
	Interval string `json:"interval"`
	Cost     int64  `json:"cost"`
}

// Output is the solver result plus its certificate.
type Output struct {
	Feasible  bool         `json:"feasible"`
	Reason    string       `json:"reason,omitempty"`
	Cost      int64        `json:"cost"`
	Occupancy []PointState `json:"occupancy,omitempty"`
	Events    []Event      `json:"events,omitempty"`
	Verified  bool         `json:"verified"`
}

// reservedAt returns the reserved register set per point.
func (in *Input) reservedAt() map[int][]int {
	m := map[int][]int{}
	for _, c := range in.Calls {
		m[c.Point] = unionInts(m[c.Point], c.Reserved)
	}
	return m
}

func unionInts(a, b []int) []int {
	seen := map[int]bool{}
	out := append([]int(nil), a...)
	for _, v := range a {
		seen[v] = true
	}
	for _, v := range b {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Ints(out)
	return out
}

// Validate checks structural constraints of the problem.
func (in *Input) Validate() error {
	if in.NumRegisters < 1 || in.NumRegisters > MaxRegisters {
		return fmt.Errorf("numRegisters must be in [1,%d], got %d", MaxRegisters, in.NumRegisters)
	}
	if len(in.Intervals) == 0 {
		return errors.New("at least one interval is required")
	}
	if len(in.Intervals) > MaxIntervals {
		return fmt.Errorf("at most %d intervals allowed, got %d", MaxIntervals, len(in.Intervals))
	}
	if len(in.Calls) > MaxCalls {
		return fmt.Errorf("at most %d calls allowed, got %d", MaxCalls, len(in.Calls))
	}
	ids := map[string]bool{}
	for _, iv := range in.Intervals {
		if iv.ID == "" {
			return errors.New("interval id must not be empty")
		}
		if ids[iv.ID] {
			return fmt.Errorf("duplicate interval id %q", iv.ID)
		}
		ids[iv.ID] = true
		if iv.Start < 0 || iv.End <= iv.Start {
			return fmt.Errorf("interval %q: need 0 <= start < end, got [%d,%d)", iv.ID, iv.Start, iv.End)
		}
		if iv.End > MaxPoints {
			return fmt.Errorf("interval %q: end %d exceeds max point %d", iv.ID, iv.End, MaxPoints)
		}
		if iv.LoadCost < 0 || iv.StoreCost < 0 {
			return fmt.Errorf("interval %q: costs must be non-negative", iv.ID)
		}
	}
	for _, c := range in.Calls {
		if c.Point < 0 || c.Point >= MaxPoints {
			return fmt.Errorf("call point %d out of range", c.Point)
		}
		seen := map[int]bool{}
		for _, r := range c.Reserved {
			if r < 0 || r >= in.NumRegisters {
				return fmt.Errorf("call at %d: reserved register %d out of range", c.Point, r)
			}
			if seen[r] {
				return fmt.Errorf("call at %d: duplicate reserved register %d", c.Point, r)
			}
			seen[r] = true
		}
	}
	return nil
}

// numPoints is the number of program points (0..numPoints-1) that can hold
// live values.
func (in *Input) numPoints() int {
	p := 0
	for _, iv := range in.Intervals {
		if iv.End > p {
			p = iv.End
		}
	}
	return p
}
