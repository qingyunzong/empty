// Package arb simulates arbitration (consensus) configuration changes:
// an old configuration moves to a new configuration through a joint
// phase. During the joint phase every commit needs a strict majority of
// the total weight in EACH configuration; once the switch completes,
// only the new configuration decides.
package arb

import (
	"fmt"
	"sort"
)

// Config is a set of voters, each with a positive weight.
type Config struct {
	Weights map[string]int
}

// NewConfig builds a Config and validates weights.
func NewConfig(weights map[string]int) (Config, error) {
	if len(weights) == 0 {
		return Config{}, fmt.Errorf("config must have at least one voter")
	}
	w := make(map[string]int, len(weights))
	for id, wt := range weights {
		if wt <= 0 {
			return Config{}, fmt.Errorf("voter %q has non-positive weight %d", id, wt)
		}
		w[id] = wt
	}
	return Config{Weights: w}, nil
}

// Total is the sum of all voter weights.
func (c Config) Total() int {
	t := 0
	for _, w := range c.Weights {
		t += w
	}
	return t
}

// Quorum is the strict majority threshold of the total weight.
func (c Config) Quorum() int {
	return c.Total()/2 + 1
}

// Tally records the vote count of one configuration for one decision.
type Tally struct {
	Config      Config
	Voters      []string // sorted IDs that voted yes
	YesWeight   int
	TotalWeight int
	Need        int // strict-majority threshold
	Pass        bool
}

// CountVotes tallies the yes votes among voters for this config.
func (c Config) CountVotes(voters []string) Tally {
	seen := map[string]bool{}
	var yes []string
	yesWeight := 0
	for _, id := range voters {
		if seen[id] {
			continue
		}
		seen[id] = true
		if w, ok := c.Weights[id]; ok {
			yes = append(yes, id)
			yesWeight += w
		}
	}
	sort.Strings(yes)
	return Tally{
		Config:      c,
		Voters:      yes,
		YesWeight:   yesWeight,
		TotalWeight: c.Total(),
		Need:        c.Quorum(),
		Pass:        yesWeight >= c.Quorum(),
	}
}

// IsQuorum reports whether voters form a strict weighted majority.
func (c Config) IsQuorum(voters []string) bool {
	return c.CountVotes(voters).Pass
}

// Phase is the stage of the configuration change.
type Phase int

const (
	PhaseOld   Phase = iota // only the old config decides
	PhaseJoint              // joint phase: old AND new must each agree
	PhaseNew                // switch complete: only the new config decides
)

func (p Phase) String() string {
	switch p {
	case PhaseOld:
		return "old"
	case PhaseJoint:
		return "joint"
	case PhaseNew:
		return "new"
	}
	return "unknown"
}
