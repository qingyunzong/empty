package q204

import (
	"fmt"
	"strings"
)

// Rule selects values in an event and applies an action to them.
//
// A path contains literal object keys and "*" wildcards. A literal segment
// matches one object key; "*" matches one object key or one array element.
// Arrays otherwise act as transparent containers (a path such as "users.email"
// walks into every element of the "users" array).
//
// Rule selection is deterministic: at the same depth the matching rule with
// the largest number of literal segments wins. Two overlapping rules at the
// same depth with the same number of literal segments are only accepted when
// they are identical and use the same action. All other ties are rejected as
// ambiguous configuration.
type Rule struct {
	Path   []string `json:"path"`
	Action Action   `json:"action"`
}

// RuleSet is a validated, immutable rule tree.
type RuleSet struct {
	root    *ruleNode
	hasHMAC bool
}

type compiledAction struct {
	action   Action
	literals int
}

type ruleNode struct {
	literal  map[string]*ruleNode
	wildcard *ruleNode
	action   *compiledAction
}

// CompileRules validates rules and builds an immutable tree.
//
// A rule path must be non-empty. Every segment must either be "*" or a non-empty
// literal key. Identical repeated rules are deduplicated. An exact path with
// two different actions, or two overlapping equally specific paths, is rejected.
func CompileRules(rules []Rule) (*RuleSet, error) {
	normalized := make([]Rule, 0, len(rules))
	seen := make(map[string]Action, len(rules))

	for i, rule := range rules {
		if err := rule.Action.validate(); err != nil {
			return nil, fmt.Errorf("%w at rule %d", err, i)
		}
		if len(rule.Path) == 0 {
			return nil, &ConfigError{Reason: "empty rule path", RuleA: ruleLabel(i, rule.Path)}
		}
		for _, segment := range rule.Path {
			if segment == "" {
				return nil, &ConfigError{Reason: "empty path segment", RuleA: ruleLabel(i, rule.Path)}
			}
		}

		rule.Action = rule.Action.canonical()
		key := patternKey(rule.Path)
		if previous, ok := seen[key]; ok {
			if !previous.equal(rule.Action) {
				return nil, &ConfigError{
					Reason: "the same path has different actions",
					RuleA:  ruleLabel(i, rule.Path),
					RuleB:  ruleLabel(i, rule.Path),
				}
			}
			continue
		}
		seen[key] = rule.Action
		normalized = append(normalized, rule)
	}

	for i := 0; i < len(normalized); i++ {
		for j := i + 1; j < len(normalized); j++ {
			a, b := normalized[i], normalized[j]
			if !patternsOverlap(a.Path, b.Path) {
				continue
			}
			if literalCount(a.Path) != literalCount(b.Path) {
				continue
			}
			// Identical paths were deduplicated above, so this is a genuinely
			// different pair of rules with the same specificity.
			return nil, &ConfigError{
				Reason: "overlapping rules have equal specificity",
				RuleA:  ruleLabel(i, a.Path),
				RuleB:  ruleLabel(j, b.Path),
			}
		}
	}

	rs := &RuleSet{root: &ruleNode{}}
	for _, rule := range normalized {
		ac := &compiledAction{
			action:   rule.Action,
			literals: literalCount(rule.Path),
		}
		if rule.Action.Type == ActionHMAC {
			rs.hasHMAC = true
		}
		node := rs.root
		for _, segment := range rule.Path {
			if segment == "*" {
				if node.wildcard == nil {
					node.wildcard = &ruleNode{}
				}
				node = node.wildcard
				continue
			}
			if node.literal == nil {
				node.literal = make(map[string]*ruleNode)
			}
			child := node.literal[segment]
			if child == nil {
				child = &ruleNode{}
				node.literal[segment] = child
			}
			node = child
		}
		node.action = ac
	}
	return rs, nil
}

func (rs *RuleSet) usesHMAC() bool {
	return rs != nil && rs.hasHMAC
}

func patternKey(path []string) string {
	return strings.Join(path, "\x00")
}

func literalCount(path []string) int {
	count := 0
	for _, segment := range path {
		if segment != "*" {
			count++
		}
	}
	return count
}

func patternsOverlap(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != "*" && b[i] != "*" && a[i] != b[i] {
			return false
		}
	}
	return true
}

func ruleLabel(index int, path []string) string {
	return fmt.Sprintf("rule %d %s", index, formatPath(path))
}

func formatPath(path []string) string {
	if len(path) == 0 {
		return "<empty>"
	}
	return strings.Join(path, ".")
}
