package formal

import (
	"fmt"
	"regexp"
)

// MatchType is the operator of a label matcher.
type MatchType string

const (
	// MatchEqual selects labels whose value equals Matcher.Value. The zero
	// MatchType is treated as MatchEqual.
	MatchEqual MatchType = "="
	// MatchNotEqual selects labels whose value differs from Matcher.Value.
	MatchNotEqual MatchType = "!="
	// MatchRegexp selects labels whose value matches the anchored regular
	// expression in Matcher.Value.
	MatchRegexp MatchType = "=~"
	// MatchNotRegexp selects labels whose value does not match the anchored
	// regular expression in Matcher.Value.
	MatchNotRegexp MatchType = "!~"
)

// Matcher selects alerts by one label. A missing label is read as the empty
// string. Regular expressions are anchored at both ends, as in Prometheus and
// Alertmanager.
type Matcher struct {
	Name  string
	Type  MatchType
	Value string
}

// Matches reports whether the matcher accepts labels.
func (m Matcher) Matches(labels Labels) bool {
	compiled, err := compileMatcher(m)
	if err != nil {
		return false
	}
	return compiled.matches(labels)
}

// Validate checks the matcher operator and regular expression.
func (m Matcher) Validate() error {
	_, err := compileMatcher(m)
	return err
}

type compiledMatcher struct {
	name  string
	kind  MatchType
	value string
	re    *regexp.Regexp
}

func compileMatcher(m Matcher) (compiledMatcher, error) {
	if m.Name == "" {
		return compiledMatcher{}, fmt.Errorf("matcher label name must not be empty")
	}

	kind := m.Type
	if kind == "" {
		kind = MatchEqual
	}

	compiled := compiledMatcher{name: m.Name, kind: kind, value: m.Value}
	switch kind {
	case MatchEqual, MatchNotEqual:
		return compiled, nil
	case MatchRegexp, MatchNotRegexp:
		// Use absolute anchors so a pattern such as "prod" does not
		// accidentally match "prod-eu".
		re, err := regexp.Compile(`\A(?:` + m.Value + `)\z`)
		if err != nil {
			return compiledMatcher{}, fmt.Errorf("matcher %q has invalid regular expression %q: %w", m.Name, m.Value, err)
		}
		compiled.re = re
		return compiled, nil
	default:
		return compiledMatcher{}, fmt.Errorf("matcher %q has unknown operator %q", m.Name, kind)
	}
}

func (m compiledMatcher) matches(labels Labels) bool {
	value := labels[m.name]
	switch m.kind {
	case MatchEqual:
		return value == m.value
	case MatchNotEqual:
		return value != m.value
	case MatchRegexp:
		return m.re.MatchString(value)
	case MatchNotRegexp:
		return !m.re.MatchString(value)
	default:
		return false
	}
}

func compileMatchers(matchers []Matcher) ([]compiledMatcher, error) {
	compiled := make([]compiledMatcher, len(matchers))
	for i, matcher := range matchers {
		item, err := compileMatcher(matcher)
		if err != nil {
			return nil, err
		}
		compiled[i] = item
	}
	return compiled, nil
}

func matchesAll(matchers []compiledMatcher, labels Labels) bool {
	for _, matcher := range matchers {
		if !matcher.matches(labels) {
			return false
		}
	}
	return true
}
