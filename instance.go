package main

import (
	"encoding/json"
	"fmt"
	"io"
)

// MaxCycle is the hard upper bound on the total cycle length.
const MaxCycle = 60

// Phase describes one signal phase.
type Phase struct {
	Name string `json:"name"`
	Min  int    `json:"min"`  // minimum green slots per cycle
	Cost []int  `json:"cost"` // Cost[g] = waiting cost when the phase gets g green slots
}

// Instance is the full optimization problem.
type Instance struct {
	Cycle     int      `json:"cycle"`     // total cycle length, 1..MaxCycle
	Phases    []Phase  `json:"phases"`    // signal phases
	Conflicts [][2]int `json:"conflicts"` // index pairs that may not be green simultaneously
}

// LoadInstance decodes and validates an instance from r.
func LoadInstance(r io.Reader) (*Instance, error) {
	var inst Instance
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&inst); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := inst.Validate(); err != nil {
		return nil, err
	}
	return &inst, nil
}

// Validate checks structural constraints of the instance.
func (inst *Instance) Validate() error {
	if inst.Cycle < 1 || inst.Cycle > MaxCycle {
		return fmt.Errorf("cycle must be in 1..%d, got %d", MaxCycle, inst.Cycle)
	}
	if len(inst.Phases) == 0 {
		return fmt.Errorf("at least one phase is required")
	}
	names := map[string]bool{}
	for i, p := range inst.Phases {
		if p.Name == "" {
			return fmt.Errorf("phase %d: empty name", i)
		}
		if names[p.Name] {
			return fmt.Errorf("duplicate phase name %q", p.Name)
		}
		names[p.Name] = true
		if p.Min < 0 || p.Min > inst.Cycle {
			return fmt.Errorf("phase %q: min %d out of range 0..%d", p.Name, p.Min, inst.Cycle)
		}
		if len(p.Cost) == 0 {
			return fmt.Errorf("phase %q: empty cost table", p.Name)
		}
		for g, c := range p.Cost {
			if c < 0 {
				return fmt.Errorf("phase %q: negative cost at g=%d", p.Name, g)
			}
		}
	}
	for _, pr := range inst.Conflicts {
		a, b := pr[0], pr[1]
		if a == b || a < 0 || b < 0 || a >= len(inst.Phases) || b >= len(inst.Phases) {
			return fmt.Errorf("invalid conflict pair [%d %d]", a, b)
		}
	}
	return nil
}

// CostOf returns the waiting cost of phase i when it receives g green slots.
// Tables shorter than cycle+1 are extended flat with their last entry.
func (inst *Instance) CostOf(i, g int) int {
	c := inst.Phases[i].Cost
	if g >= len(c) {
		return c[len(c)-1]
	}
	return c[g]
}

// Conflict reports whether phases a and b conflict.
func (inst *Instance) Conflict(a, b int) bool {
	for _, pr := range inst.Conflicts {
		if (pr[0] == a && pr[1] == b) || (pr[0] == b && pr[1] == a) {
			return true
		}
	}
	return false
}

// adjacency returns the conflict neighbor sets as bitmasks.
func (inst *Instance) adjacency() []uint64 {
	n := len(inst.Phases)
	adj := make([]uint64, n)
	for _, pr := range inst.Conflicts {
		adj[pr[0]] |= 1 << pr[1]
		adj[pr[1]] |= 1 << pr[0]
	}
	return adj
}
