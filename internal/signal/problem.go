// Package signal implements an exact traffic-signal cycle optimizer.
//
// Model: a cycle consists of C integer slots (1 <= C <= 60). In every
// slot any conflict-free set of phases may be released (green). Phase i
// must collect at least min[i] green slots per cycle. The total cost of
// a schedule is sum_i cost_i[green_i], where cost_i is a per-phase
// waiting-cost table indexed by the number of green slots. The goal is
// to minimize the total cost.
package signal

import (
	"encoding/json"
	"fmt"
	"os"
)

// MaxCycle is the largest allowed cycle length.
const MaxCycle = 60

// MaxPhases is the largest supported number of phases. Green vectors are
// packed into 64-bit keys with 6 bits per phase, so this bound is hard.
const MaxPhases = 10

// Phase describes one signal phase.
type Phase struct {
	Name string `json:"name"`
	Min  int    `json:"min"`
	// Cost[g] is the waiting cost incurred when the phase receives g
	// green slots in a cycle. Must hold exactly Cycle+1 entries.
	Cost []int `json:"cost"`
}

// Problem is a signal-cycle optimization instance.
type Problem struct {
	Cycle     int      `json:"cycle"`
	Phases    []Phase  `json:"phases"`
	Conflicts [][2]int `json:"conflicts"`
}

// LoadProblem reads and validates a problem from a JSON file.
func LoadProblem(path string) (*Problem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var p Problem
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("invalid problem in %s: %w", path, err)
	}
	return &p, nil
}

// Validate checks structural constraints of the instance.
func (p *Problem) Validate() error {
	if p.Cycle < 1 || p.Cycle > MaxCycle {
		return fmt.Errorf("cycle must be in [1,%d], got %d", MaxCycle, p.Cycle)
	}
	if len(p.Phases) < 1 || len(p.Phases) > MaxPhases {
		return fmt.Errorf("need between 1 and %d phases, got %d", MaxPhases, len(p.Phases))
	}
	seen := map[string]bool{}
	for i, ph := range p.Phases {
		if ph.Name == "" {
			return fmt.Errorf("phase %d: empty name", i)
		}
		if seen[ph.Name] {
			return fmt.Errorf("duplicate phase name %q", ph.Name)
		}
		seen[ph.Name] = true
		if ph.Min < 0 || ph.Min > p.Cycle {
			return fmt.Errorf("phase %q: min %d out of range [0,%d]", ph.Name, ph.Min, p.Cycle)
		}
		if len(ph.Cost) != p.Cycle+1 {
			return fmt.Errorf("phase %q: cost table must have exactly %d entries (g=0..%d), got %d",
				ph.Name, p.Cycle+1, p.Cycle, len(ph.Cost))
		}
		for g, c := range ph.Cost {
			if c < 0 {
				return fmt.Errorf("phase %q: negative cost at g=%d", ph.Name, g)
			}
		}
	}
	for _, e := range p.Conflicts {
		a, b := e[0], e[1]
		if a < 0 || b < 0 || a >= len(p.Phases) || b >= len(p.Phases) {
			return fmt.Errorf("conflict [%d,%d] out of range", a, b)
		}
		if a == b {
			return fmt.Errorf("self-conflict on phase %d", a)
		}
	}
	return nil
}

// adjacency returns per-phase conflict bitmasks.
func (p *Problem) adjacency() []uint64 {
	adj := make([]uint64, len(p.Phases))
	for _, e := range p.Conflicts {
		adj[e[0]] |= 1 << e[1]
		adj[e[1]] |= 1 << e[0]
	}
	return adj
}
