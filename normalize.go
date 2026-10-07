package synclib

import "strings"

// Rule is a declared equivalence rule. Only declared rules are applied
// during read-back comparison; anything undeclared is reported as a diff.
type Rule int

const (
	// RuleTrimSpace ignores leading and trailing whitespace.
	RuleTrimSpace Rule = iota
	// RuleFoldCase ignores letter case.
	RuleFoldCase
	// RuleCollapseSpace treats any run of whitespace as one space.
	RuleCollapseSpace
)

// Ruleset declares which equivalence rules apply, globally and per field.
type Ruleset struct {
	Global []Rule
	Fields map[string][]Rule
}

func (rs Ruleset) rulesFor(field string) []Rule {
	rules := make([]Rule, 0, len(rs.Global)+len(rs.Fields[field]))
	rules = append(rules, rs.Global...)
	rules = append(rules, rs.Fields[field]...)
	return rules
}

func applyRules(s string, rules []Rule) string {
	for _, r := range rules {
		switch r {
		case RuleTrimSpace:
			s = strings.TrimSpace(s)
		case RuleFoldCase:
			s = strings.ToLower(s)
		case RuleCollapseSpace:
			s = strings.Join(strings.Fields(s), " ")
		}
	}
	return s
}
