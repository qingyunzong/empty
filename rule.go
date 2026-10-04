package rulelib

import (
	"fmt"
	"sort"
	"strings"
)

// Rule is one access rule: an include glob plus optional exclusion globs.
// A rule matches a path when the include glob matches and no exclusion
// glob matches.
type Rule struct {
	Name     string
	Allow    bool // effect when the rule fires
	Glob     string
	include  Pattern
	excludes []Pattern
}

// NewRule builds a rule from a glob list such as
// "src/** !src/internal/** !src/tmp". Tokens prefixed with '!' are
// exclusion (exception) patterns; exactly one include pattern is required.
func NewRule(name string, allow bool, globList string) (Rule, error) {
	if name == "" {
		return Rule{}, fmt.Errorf("rulelib: rule name must not be empty")
	}
	r := Rule{Name: name, Allow: allow, Glob: strings.TrimSpace(globList)}
	for _, tok := range strings.Fields(globList) {
		if strings.HasPrefix(tok, "!") {
			pat := strings.TrimPrefix(tok, "!")
			p, err := ParsePattern(pat)
			if err != nil {
				return Rule{}, fmt.Errorf("rulelib: rule %q exclusion: %w", name, err)
			}
			r.excludes = append(r.excludes, p)
			continue
		}
		if r.include.Raw != "" {
			return Rule{}, fmt.Errorf("rulelib: rule %q has more than one include glob", name)
		}
		p, err := ParsePattern(tok)
		if err != nil {
			return Rule{}, fmt.Errorf("rulelib: rule %q: %w", name, err)
		}
		r.include = p
	}
	if r.include.Raw == "" {
		return Rule{}, fmt.Errorf("rulelib: rule %q has no include glob", name)
	}
	return r, nil
}

func (r Rule) specificity() specificity { return r.include.specificity() }

// matchesDirect reports whether the rule fires on path, using plain glob
// matching (no automaton, no cache). Used as the reference matcher.
func (r Rule) matchesDirect(path []string) bool {
	if !r.include.Match(path) {
		return false
	}
	for _, ex := range r.excludes {
		if ex.Match(path) {
			return false
		}
	}
	return true
}

// sortRules orders rules by descending specificity (literal segment count,
// then total segment count). Ties keep their input order.
func sortRules(rules []Rule) []Rule {
	out := make([]Rule, len(rules))
	copy(out, rules)
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].specificity().compare(out[j].specificity()) > 0
	})
	return out
}
