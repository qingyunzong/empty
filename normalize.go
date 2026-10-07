package fieldsync

import "strings"

// EquivalenceRule is a declared normalization applied to field values before
// comparison. Only rules passed to Config.Rules are ever applied; undeclared
// differences are always reported as mismatches.
type EquivalenceRule interface {
	Name() string
	Normalize(value string) string
}

type ruleFunc struct {
	name string
	fn   func(string) string
}

func (r ruleFunc) Name() string                  { return r.name }
func (r ruleFunc) Normalize(value string) string { return r.fn(value) }

// TrimSpace declares leading/trailing whitespace insignificant.
func TrimSpace() EquivalenceRule { return ruleFunc{"trim_space", strings.TrimSpace} }

// FoldCase declares ASCII/Unicode case differences insignificant.
func FoldCase() EquivalenceRule { return ruleFunc{"fold_case", strings.ToLower} }

// CollapseWhitespace declares runs of internal whitespace insignificant.
func CollapseWhitespace() EquivalenceRule {
	return ruleFunc{"collapse_whitespace", func(v string) string {
		return strings.Join(strings.Fields(v), " ")
	}}
}

func normalizeValue(value string, rules []EquivalenceRule) string {
	for _, rule := range rules {
		value = rule.Normalize(value)
	}
	return value
}
