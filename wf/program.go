// Package wf evaluates finite ground logic programs under the well-founded
// semantics using the alternating fixed point operator defined by the host
// data-quality pipeline.
//
// The host instantiates every rule to ground atoms before calling this
// package: no language parsing and no variable expansion happens here. The
// three-valued result keeps unknown atoms as a first-class outcome; unknown is
// never collapsed to false and no stable model is ever selected.
package wf

import (
	"errors"
	"fmt"
	"sort"
)

// Input size limits promised by the host contract.
const (
	MaxAtoms = 1000
	MaxRules = 20000
)

// Rule is a ground rule h :- p1,...,pm, not n1,...,not nk.
//
// Pos and Neg hold atom IDs. NewProgram normalizes repeated body literals to
// sets. A rule that mentions the same atom both positively and negatively is
// retained as-is: its body can never be all true, but the rule is not deleted
// automatically. A rule with an empty body is a fact.
type Rule struct {
	ID   string
	Head string
	Pos  []string
	Neg  []string
}

// Program is an immutable snapshot of a ground program together with its
// explicit universe B. One evaluation is always bound to exactly one Program
// snapshot. Replacing the full set of facts/rules means constructing a new
// Program and evaluating it independently; previously returned results and
// the original rules stay untouched.
type Program struct {
	universe []string
	ruleIDs  []string
	rules    map[string]*compiledRule
	byHead   map[string][]*compiledRule
}

type compiledRule struct {
	id   string
	head string
	pos  []string
	neg  []string
}

// NewProgram validates and compiles an immutable program snapshot.
func NewProgram(universe []string, rules []Rule) (*Program, error) {
	if len(universe) > MaxAtoms {
		return nil, fmt.Errorf("wf: universe has %d atoms, limit is %d", len(universe), MaxAtoms)
	}
	if len(rules) > MaxRules {
		return nil, fmt.Errorf("wf: program has %d rules, limit is %d", len(rules), MaxRules)
	}

	known := make(map[string]bool, len(universe))
	for _, id := range universe {
		if id == "" {
			return nil, errors.New("wf: empty atom id in universe")
		}
		if !isASCII(id) {
			return nil, fmt.Errorf("wf: atom id %q is not ASCII", id)
		}
		if known[id] {
			return nil, fmt.Errorf("wf: duplicate atom id %q in universe", id)
		}
		known[id] = true
	}

	p := &Program{
		universe: append([]string(nil), universe...),
		rules:    make(map[string]*compiledRule, len(rules)),
		byHead:   make(map[string][]*compiledRule),
	}
	sort.Strings(p.universe)

	ruleIDSeen := make(map[string]bool, len(rules))
	for _, r := range rules {
		if r.ID == "" {
			return nil, errors.New("wf: empty rule id")
		}
		if !isASCII(r.ID) {
			return nil, fmt.Errorf("wf: rule id %q is not ASCII", r.ID)
		}
		if ruleIDSeen[r.ID] {
			return nil, fmt.Errorf("wf: duplicate rule id %q", r.ID)
		}
		ruleIDSeen[r.ID] = true
		if !known[r.Head] {
			return nil, fmt.Errorf("wf: rule %q head %q is not in universe B", r.ID, r.Head)
		}
		pos, err := normalizeLit(r.ID, "positive", r.Pos, known)
		if err != nil {
			return nil, err
		}
		neg, err := normalizeLit(r.ID, "negative", r.Neg, known)
		if err != nil {
			return nil, err
		}
		cr := &compiledRule{id: r.ID, head: r.Head, pos: pos, neg: neg}
		p.rules[r.ID] = cr
		p.byHead[r.Head] = append(p.byHead[r.Head], cr)
	}

	p.ruleIDs = make([]string, 0, len(rules))
	for id := range ruleIDSeen {
		p.ruleIDs = append(p.ruleIDs, id)
	}
	sort.Strings(p.ruleIDs)
	for head := range p.byHead {
		sort.Slice(p.byHead[head], func(i, j int) bool {
			return p.byHead[head][i].id < p.byHead[head][j].id
		})
	}
	return p, nil
}

func normalizeLit(ruleID, kind string, lits []string, known map[string]bool) ([]string, error) {
	set := make(map[string]bool, len(lits))
	for _, atom := range lits {
		if atom == "" {
			return nil, fmt.Errorf("wf: rule %q has an empty %s body literal", ruleID, kind)
		}
		if !known[atom] {
			return nil, fmt.Errorf("wf: rule %q %s body atom %q is not in universe B", ruleID, kind, atom)
		}
		set[atom] = true
	}
	out := make([]string, 0, len(set))
	for atom := range set {
		out = append(out, atom)
	}
	sort.Strings(out)
	return out, nil
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 128 {
			return false
		}
	}
	return true
}

// Universe returns a copy of the sorted universe B.
func (p *Program) Universe() []string {
	return append([]string(nil), p.universe...)
}

// Rules returns the normalized rules in rule ID ASCII order.
func (p *Program) Rules() []Rule {
	out := make([]Rule, 0, len(p.ruleIDs))
	for _, id := range p.ruleIDs {
		cr := p.rules[id]
		out = append(out, Rule{
			ID:   cr.id,
			Head: cr.head,
			Pos:  append([]string(nil), cr.pos...),
			Neg:  append([]string(nil), cr.neg...),
		})
	}
	return out
}

func (p *Program) rulesFor(atom string) []*compiledRule {
	return p.byHead[atom]
}
