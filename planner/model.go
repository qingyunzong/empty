// Package planner implements a permission-planning optimizer: it selects a
// minimum-cost set of allow rules that covers a multiset of action demands,
// subject to forbidden actions, mutual exclusion, enable-prerequisites and a
// global action-count quota.
package planner

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

// MaxRules is the maximum number of allow rules a spec may declare.
const MaxRules = 22

// MaxActions bounds the distinct action names so bitmask arithmetic stays in uint64.
const MaxActions = 64

// Rule is a single allow rule.
type Rule struct {
	ID       string   `json:"id"`
	Cost     int64    `json:"cost"`
	Actions  []string `json:"actions"`
	Capacity int      `json:"capacity"` // max assigned action units; 0 = unlimited
	Requires []string `json:"requires"` // rule IDs that must also be selected
	Excludes []string `json:"excludes"` // mutually exclusive rule IDs (symmetric)
}

// Spec is the planning problem instance.
type Spec struct {
	Rules       []Rule         `json:"rules"`
	Forbidden   []string       `json:"forbidden"`   // actions no selected rule may cover
	Demands     map[string]int `json:"demands"`     // action -> required count (multiset)
	GlobalQuota int            `json:"globalQuota"` // max total assigned units; 0 = unlimited
}

// ParseSpec decodes a spec from JSON, rejecting unknown fields.
func ParseSpec(r io.Reader) (*Spec, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	var s Spec
	if err := dec.Decode(&s); err != nil {
		return nil, err
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

// Validate checks structural constraints of the spec.
func (s *Spec) Validate() error {
	if len(s.Rules) > MaxRules {
		return fmt.Errorf("at most %d rules allowed, got %d", MaxRules, len(s.Rules))
	}
	if s.GlobalQuota < 0 {
		return fmt.Errorf("globalQuota must be >= 0")
	}
	seen := map[string]bool{}
	for i := range s.Rules {
		r := &s.Rules[i]
		if r.ID == "" {
			return fmt.Errorf("rule %d: empty id", i)
		}
		if seen[r.ID] {
			return fmt.Errorf("duplicate rule id %q", r.ID)
		}
		seen[r.ID] = true
		if r.Cost < 0 {
			return fmt.Errorf("rule %q: negative cost", r.ID)
		}
		if r.Capacity < 0 {
			return fmt.Errorf("rule %q: negative capacity", r.ID)
		}
		if len(r.Actions) == 0 {
			return fmt.Errorf("rule %q: covers no actions", r.ID)
		}
	}
	for i := range s.Rules {
		r := &s.Rules[i]
		for _, dep := range r.Requires {
			if !seen[dep] {
				return fmt.Errorf("rule %q requires unknown rule %q", r.ID, dep)
			}
		}
		for _, ex := range r.Excludes {
			if !seen[ex] {
				return fmt.Errorf("rule %q excludes unknown rule %q", r.ID, ex)
			}
		}
	}
	for a, n := range s.Demands {
		if a == "" {
			return fmt.Errorf("empty demand action name")
		}
		if n <= 0 {
			return fmt.Errorf("demand for %q must be positive, got %d", a, n)
		}
	}
	actions := map[string]bool{}
	for _, r := range s.Rules {
		for _, a := range r.Actions {
			actions[a] = true
		}
	}
	for a := range s.Demands {
		actions[a] = true
	}
	for _, a := range s.Forbidden {
		actions[a] = true
	}
	if len(actions) > MaxActions {
		return fmt.Errorf("at most %d distinct actions supported, got %d", MaxActions, len(actions))
	}
	return nil
}

// prepared is the indexed internal form of a validated spec.
type prepared struct {
	spec *Spec

	ruleIdx   map[string]int
	actionIdx map[string]int
	actions   []string // index -> name, sorted

	ruleActionMask  []uint64   // per rule, over action indices
	eligible        []bool     // false if rule covers a forbidden action
	forbiddenHits   [][]string // forbidden actions covered per rule
	requiresMask    []uint64   // direct prerequisites, over rule indices
	requiresClosure []uint64   // transitive prerequisites
	excludesMask    []uint64   // symmetric mutex, over rule indices

	demandActions []int // action indices with demand, ascending
	demandCounts  []int
	demandMask    uint64
	totalDemand   int

	elig []int // eligible rule indices, input order
}

func prepare(spec *Spec) *prepared {
	p := &prepared{
		spec:      spec,
		ruleIdx:   map[string]int{},
		actionIdx: map[string]int{},
	}
	actionSet := map[string]bool{}
	for i := range spec.Rules {
		p.ruleIdx[spec.Rules[i].ID] = i
		for _, a := range spec.Rules[i].Actions {
			actionSet[a] = true
		}
	}
	for a := range spec.Demands {
		actionSet[a] = true
	}
	for _, a := range spec.Forbidden {
		actionSet[a] = true
	}
	for a := range actionSet {
		p.actions = append(p.actions, a)
	}
	sort.Strings(p.actions)
	for i, a := range p.actions {
		p.actionIdx[a] = i
	}

	n := len(spec.Rules)
	p.ruleActionMask = make([]uint64, n)
	p.eligible = make([]bool, n)
	p.forbiddenHits = make([][]string, n)
	p.requiresMask = make([]uint64, n)
	p.requiresClosure = make([]uint64, n)
	p.excludesMask = make([]uint64, n)

	forbidden := map[string]bool{}
	for _, a := range spec.Forbidden {
		forbidden[a] = true
	}
	for i, r := range spec.Rules {
		var mask uint64
		for _, a := range r.Actions {
			mask |= 1 << uint(p.actionIdx[a])
			if forbidden[a] {
				p.forbiddenHits[i] = append(p.forbiddenHits[i], a)
			}
		}
		sort.Strings(p.forbiddenHits[i])
		p.ruleActionMask[i] = mask
		p.eligible[i] = len(p.forbiddenHits[i]) == 0
		for _, dep := range r.Requires {
			p.requiresMask[i] |= 1 << uint(p.ruleIdx[dep])
		}
		for _, ex := range r.Excludes {
			j := p.ruleIdx[ex]
			p.excludesMask[i] |= 1 << uint(j)
			p.excludesMask[j] |= 1 << uint(i) // symmetric
		}
	}
	// Transitive closure of requires (cycles are fine: members co-required).
	copy(p.requiresClosure, p.requiresMask)
	for changed := true; changed; {
		changed = false
		for i := 0; i < n; i++ {
			c := p.requiresClosure[i]
			extra := c
			for m := c; m != 0; m &= m - 1 {
				extra |= p.requiresClosure[bitsTrailing(m)]
			}
			if extra != c {
				p.requiresClosure[i] = extra
				changed = true
			}
		}
	}

	for a, cnt := range spec.Demands {
		ai := p.actionIdx[a]
		p.demandActions = append(p.demandActions, ai)
		p.demandCounts = append(p.demandCounts, cnt)
		p.demandMask |= 1 << uint(ai)
		p.totalDemand += cnt
	}
	// Keep demand actions ordered by action index for determinism.
	for i := 0; i < len(p.demandActions); i++ {
		for j := i + 1; j < len(p.demandActions); j++ {
			if p.demandActions[j] < p.demandActions[i] {
				p.demandActions[i], p.demandActions[j] = p.demandActions[j], p.demandActions[i]
				p.demandCounts[i], p.demandCounts[j] = p.demandCounts[j], p.demandCounts[i]
			}
		}
	}

	for i := range spec.Rules {
		if p.eligible[i] {
			p.elig = append(p.elig, i)
		}
	}
	return p
}

func bitsTrailing(m uint64) int {
	// index of lowest set bit
	i := 0
	for m&1 == 0 {
		m >>= 1
		i++
	}
	return i
}

// effCap caps a rule's capacity at totalDemand (0 = unlimited).
func (p *prepared) effCap(r int) int {
	c := p.spec.Rules[r].Capacity
	if c <= 0 || c > p.totalDemand {
		return p.totalDemand
	}
	return c
}

// quotaOK reports whether the global quota admits the demand at all.
func (p *prepared) quotaOK() bool {
	q := p.spec.GlobalQuota
	return q <= 0 || p.totalDemand <= q
}

// sortedIDs returns the sorted rule IDs of a selection bitmask.
func (p *prepared) sortedIDs(sel uint64) []string {
	var ids []string
	for m := sel; m != 0; m &= m - 1 {
		ids = append(ids, p.spec.Rules[bitsTrailing(m)].ID)
	}
	sort.Strings(ids)
	return ids
}

// lessIDs compares two sorted ID lists lexicographically.
func lessIDs(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}
