package formal

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// ErrInvalidConfig is returned for an invalid collector or policy
// configuration.
var ErrInvalidConfig = errors.New("formal: invalid config")

// Match is a declarative rule predicate. The zero value matches every trace.
// All non-zero fields are ANDed together.
type Match struct {
	// HasError, when non-nil, requires the trace error flag to equal *HasError.
	HasError *bool

	// MinDuration and MaxDuration bound the trace's wall-clock duration.
	// Zero values leave the corresponding bound unset.
	MinDuration time.Duration
	MaxDuration time.Duration

	MinErrors int
	MinSpans  int

	// Service requires at least one span from the named service.
	Service string
	// AnyServices requires at least one of the named services.
	AnyServices []string
	// AllServices requires every named service.
	AllServices []string

	// Attributes requires exact equality for every named attribute.
	Attributes map[string]string
}

// Matches reports whether the summary satisfies all constraints in m.
func (m Match) Matches(s TraceSummary) bool {
	if m.HasError != nil && s.HasError != *m.HasError {
		return false
	}
	if m.MinDuration > 0 && s.Duration < m.MinDuration {
		return false
	}
	if m.MaxDuration > 0 && s.Duration > m.MaxDuration {
		return false
	}
	if m.MinErrors > 0 && s.ErrorCount < m.MinErrors {
		return false
	}
	if m.MinSpans > 0 && s.SpanCount < m.MinSpans {
		return false
	}
	if m.Service != "" && !s.HasService(m.Service) {
		return false
	}
	if len(m.AnyServices) > 0 {
		found := false
		for _, service := range m.AnyServices {
			if s.HasService(service) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	for _, service := range m.AllServices {
		if !s.HasService(service) {
			return false
		}
	}
	for key, want := range m.Attributes {
		got, ok := s.Attributes[key]
		if !ok || got != want {
			return false
		}
	}
	return true
}

// Rule maps a matching trace summary to a sampling verdict.
//
// Rules are evaluated in ascending Priority order; ties are broken by
// ascending ID. The first matching rule wins. A Predicate, when set, must be
// pure: its result must depend only on the summary.
type Rule struct {
	ID        string
	Priority  int
	Verdict   Verdict
	Match     Match
	Predicate func(TraceSummary) bool
}

// Matches reports whether the rule applies to s.
func (r Rule) Matches(s TraceSummary) bool {
	if !r.Match.Matches(s) {
		return false
	}
	return r.Predicate == nil || r.Predicate(s)
}

// Policy is an immutable, deterministically ordered set of rules.
type Policy struct {
	defaultVerdict Verdict
	rules          []Rule
}

// NewPolicy validates and orders rules. Lower Priority values are evaluated
// first; equal priorities are ordered by rule ID.
func NewPolicy(defaultVerdict Verdict, rules []Rule) (*Policy, error) {
	if !defaultVerdict.Valid() {
		return nil, fmt.Errorf("%w: default verdict must be keep or drop", ErrInvalidConfig)
	}

	ordered := make([]Rule, len(rules))
	copy(ordered, rules)

	seen := make(map[string]struct{}, len(ordered))
	for i := range ordered {
		rule := &ordered[i]
		if rule.ID == "" {
			return nil, fmt.Errorf("%w: rule %d has an empty id", ErrInvalidConfig, i)
		}
		if _, ok := seen[rule.ID]; ok {
			return nil, fmt.Errorf("%w: duplicate rule id %q", ErrInvalidConfig, rule.ID)
		}
		seen[rule.ID] = struct{}{}
		if !rule.Verdict.Valid() {
			return nil, fmt.Errorf("%w: rule %q has invalid verdict", ErrInvalidConfig, rule.ID)
		}
		if rule.Priority < 0 {
			return nil, fmt.Errorf("%w: rule %q has negative priority", ErrInvalidConfig, rule.ID)
		}
		if rule.Match.MinDuration < 0 || rule.Match.MaxDuration < 0 {
			return nil, fmt.Errorf("%w: rule %q has negative duration bound", ErrInvalidConfig, rule.ID)
		}
		if rule.Match.MaxDuration > 0 && rule.Match.MinDuration > rule.Match.MaxDuration {
			return nil, fmt.Errorf("%w: rule %q has empty duration range", ErrInvalidConfig, rule.ID)
		}
		if rule.Match.MinErrors < 0 || rule.Match.MinSpans < 0 {
			return nil, fmt.Errorf("%w: rule %q has negative count bound", ErrInvalidConfig, rule.ID)
		}
		if err := validateServices(rule.ID, rule.Match); err != nil {
			return nil, err
		}
		if len(rule.Match.Attributes) != 0 {
			attrs := make(map[string]string, len(rule.Match.Attributes))
			for k, v := range rule.Match.Attributes {
				if k == "" {
					return nil, fmt.Errorf("%w: rule %q has an empty attribute key", ErrInvalidConfig, rule.ID)
				}
				attrs[k] = v
			}
			rule.Match.Attributes = attrs
		}
		if rule.Match.HasError != nil {
			value := *rule.Match.HasError
			rule.Match.HasError = &value
		}
		rule.Match.AnyServices = append([]string(nil), rule.Match.AnyServices...)
		rule.Match.AllServices = append([]string(nil), rule.Match.AllServices...)
	}

	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].Priority != ordered[j].Priority {
			return ordered[i].Priority < ordered[j].Priority
		}
		return ordered[i].ID < ordered[j].ID
	})

	return &Policy{defaultVerdict: defaultVerdict, rules: ordered}, nil
}

func validateServices(ruleID string, match Match) error {
	// An empty service in AnyServices/AllServices would silently do the wrong
	// thing, so reject it at configuration time.
	for _, service := range match.AnyServices {
		if service == "" {
			return fmt.Errorf("%w: rule %q has an empty service", ErrInvalidConfig, ruleID)
		}
	}
	for _, service := range match.AllServices {
		if service == "" {
			return fmt.Errorf("%w: rule %q has an empty service", ErrInvalidConfig, ruleID)
		}
	}
	return nil
}

// Decide returns the verdict and ID of the first matching rule, or the default
// verdict with an empty rule ID when no rule matches.
func (p *Policy) Decide(s TraceSummary) (Verdict, string) {
	for _, rule := range p.rules {
		if rule.Matches(s) {
			return rule.Verdict, rule.ID
		}
	}
	return p.defaultVerdict, ""
}

// DefaultVerdict returns the verdict used when no rule matches.
func (p *Policy) DefaultVerdict() Verdict {
	return p.defaultVerdict
}

// Rules returns a copy of the ordered rules.
func (p *Policy) Rules() []Rule {
	out := make([]Rule, len(p.rules))
	copy(out, p.rules)
	for i := range out {
		if len(out[i].Match.Attributes) != 0 {
			attrs := make(map[string]string, len(out[i].Match.Attributes))
			for k, v := range out[i].Match.Attributes {
				attrs[k] = v
			}
			out[i].Match.Attributes = attrs
		}
		if out[i].Match.HasError != nil {
			value := *out[i].Match.HasError
			out[i].Match.HasError = &value
		}
		out[i].Match.AnyServices = append([]string(nil), out[i].Match.AnyServices...)
		out[i].Match.AllServices = append([]string(nil), out[i].Match.AllServices...)
	}
	return out
}
