// Package planner implements a permission-planning solver: choose a
// minimum-cost subset of allow rules and assign a multiset of action
// demands to them, subject to forbidden actions, mutual exclusion,
// enable-prerequisites, per-rule capacities and a global action quota.
package planner

import (
	"fmt"
	"sort"
)

// Rule is a single allow rule.
type Rule struct {
	ID       string         `json:"id"`
	Cost     int64          `json:"cost"`                 // fixed cost paid once when selected
	UseCost  int64          `json:"use_cost"`             // cost per assigned action unit
	Capacity int            `json:"capacity"`             // max total units served; <=0 means unlimited
	Actions  map[string]int `json:"actions"`              // action -> max units this rule can serve
}

// Prereq states that Rule may only be enabled together with Requires.
type Prereq struct {
	Rule     string `json:"rule"`
	Requires string `json:"requires"`
}

// Input is the full planning instance.
type Input struct {
	Rules     []Rule         `json:"rules"`
	Mutex     [][2]string    `json:"mutex"`     // pairs of rule IDs that cannot both be selected
	Prereqs   []Prereq       `json:"prereqs"`   // enable prerequisites
	Quota     int            `json:"quota"`     // global cap on total assigned action units; <=0 means unlimited
	Demands   map[string]int `json:"demands"`   // action -> required units (multiset demand)
	Forbidden []string       `json:"forbidden"` // actions no selected rule may cover
}

// MaxRules is the hard limit on the number of allow rules.
const MaxRules = 22

// Validate checks structural well-formedness of the instance.
func (in *Input) Validate() error {
	if len(in.Rules) == 0 {
		return fmt.Errorf("no rules given")
	}
	if len(in.Rules) > MaxRules {
		return fmt.Errorf("too many rules: %d > %d", len(in.Rules), MaxRules)
	}
	seen := map[string]bool{}
	for _, r := range in.Rules {
		if r.ID == "" {
			return fmt.Errorf("rule with empty id")
		}
		if seen[r.ID] {
			return fmt.Errorf("duplicate rule id %q", r.ID)
		}
		seen[r.ID] = true
		if r.Cost < 0 || r.UseCost < 0 {
			return fmt.Errorf("rule %q: negative cost", r.ID)
		}
		for a, n := range r.Actions {
			if n <= 0 {
				return fmt.Errorf("rule %q: action %q has non-positive limit %d", r.ID, a, n)
			}
		}
	}
	known := func(id string) bool { return seen[id] }
	for _, p := range in.Mutex {
		if !known(p[0]) || !known(p[1]) {
			return fmt.Errorf("mutex pair references unknown rule: %v", p)
		}
		if p[0] == p[1] {
			return fmt.Errorf("mutex pair with identical rules: %q", p[0])
		}
	}
	for _, p := range in.Prereqs {
		if !known(p.Rule) || !known(p.Requires) {
			return fmt.Errorf("prereq references unknown rule: %+v", p)
		}
		if p.Rule == p.Requires {
			return fmt.Errorf("rule %q requires itself", p.Rule)
		}
	}
	for a, n := range in.Demands {
		if n <= 0 {
			return fmt.Errorf("demand %q has non-positive count %d", a, n)
		}
	}
	return nil
}

// TotalDemand returns the total number of demanded action units.
func (in *Input) TotalDemand() int {
	t := 0
	for _, n := range in.Demands {
		t += n
	}
	return t
}

// sortedKeys returns map keys in deterministic order.
func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}
