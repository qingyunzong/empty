package formal

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// InhibitionRule suppresses target alerts while a matching source alert is
// active.
//
// A target is inhibited only when all of the following hold:
//   - the source alert matches SourceMatchers;
//   - the target alert matches TargetMatchers;
//   - every label named in Equal has the same value on source and target;
//   - source and target are different alerts.
type InhibitionRule struct {
	Name           string
	SourceMatchers []Matcher
	TargetMatchers []Matcher
	Equal          []string
}

// Silence suppresses matching alerts during [StartsAt, EndsAt).
//
// A zero StartsAt means the silence is active from the beginning. A zero
// EndsAt means it has no expiry. Non-empty IDs must be unique within a Config.
type Silence struct {
	ID       string
	Matchers []Matcher
	StartsAt time.Time
	EndsAt   time.Time
}

// ActiveAt reports whether the silence covers now.
func (s Silence) ActiveAt(now time.Time) bool {
	if !s.StartsAt.IsZero() && now.Before(s.StartsAt) {
		return false
	}
	if !s.EndsAt.IsZero() && !now.Before(s.EndsAt) {
		return false
	}
	return true
}

// Matches reports whether all silence matchers accept labels.
func (s Silence) Matches(labels Labels) bool {
	for _, matcher := range s.Matchers {
		if !matcher.Matches(labels) {
			return false
		}
	}
	return true
}

// Config is the complete rule set used to turn active alerts into
// notifications.
type Config struct {
	// GroupBy names the labels that form a notification group. The order and
	// duplicates are ignored; group keys are canonical and sorted.
	GroupBy []string
	// Inhibitions are evaluated against every pair of active alerts.
	Inhibitions []InhibitionRule
	// Silences are time-windowed mutes.
	Silences []Silence
}

// Clone returns an independent copy of the configuration.
func (c Config) Clone() Config {
	cloned := Config{
		GroupBy:     append([]string(nil), c.GroupBy...),
		Inhibitions: make([]InhibitionRule, len(c.Inhibitions)),
		Silences:    make([]Silence, len(c.Silences)),
	}
	for i, rule := range c.Inhibitions {
		cloned.Inhibitions[i] = InhibitionRule{
			Name:           rule.Name,
			SourceMatchers: append([]Matcher(nil), rule.SourceMatchers...),
			TargetMatchers: append([]Matcher(nil), rule.TargetMatchers...),
			Equal:          append([]string(nil), rule.Equal...),
		}
	}
	for i, silence := range c.Silences {
		cloned.Silences[i] = Silence{
			ID:       silence.ID,
			Matchers: append([]Matcher(nil), silence.Matchers...),
			StartsAt: silence.StartsAt,
			EndsAt:   silence.EndsAt,
		}
	}
	return cloned
}

// Validate checks all rules without changing them.
func (c Config) Validate() error {
	_, err := compileConfig(c)
	return err
}

type compiledInhibitionRule struct {
	index  int
	name   string
	key    string
	source []compiledMatcher
	target []compiledMatcher
	equal  []string
}

type compiledSilence struct {
	index    int
	id       string
	key      string
	matchers []compiledMatcher
	starts   time.Time
	ends     time.Time
}

type compiledConfig struct {
	groupBy     []string
	inhibitions []compiledInhibitionRule
	silences    []compiledSilence
}

func compileConfig(config Config) (compiledConfig, error) {
	compiled := compiledConfig{
		groupBy:     normalizeGroupBy(config.GroupBy),
		inhibitions: make([]compiledInhibitionRule, len(config.Inhibitions)),
		silences:    make([]compiledSilence, len(config.Silences)),
	}

	for i, name := range config.GroupBy {
		if name == "" {
			return compiledConfig{}, fmt.Errorf("group-by entry %d has an empty label name", i)
		}
	}

	seenSilenceIDs := make(map[string]struct{}, len(config.Silences))
	for i, silence := range config.Silences {
		if silence.ID != "" {
			if _, exists := seenSilenceIDs[silence.ID]; exists {
				return compiledConfig{}, fmt.Errorf("silence ID %q is not unique", silence.ID)
			}
			seenSilenceIDs[silence.ID] = struct{}{}
		}
		if !silence.EndsAt.IsZero() && !silence.StartsAt.IsZero() && silence.EndsAt.Before(silence.StartsAt) {
			return compiledConfig{}, fmt.Errorf("silence %q ends before it starts", silence.ID)
		}
		matchers, err := compileMatchers(silence.Matchers)
		if err != nil {
			return compiledConfig{}, fmt.Errorf("silence %q: %w", silence.ID, err)
		}
		compiled.silences[i] = compiledSilence{
			index:    i,
			id:       silence.ID,
			key:      silenceKey(silence),
			matchers: matchers,
			starts:   silence.StartsAt,
			ends:     silence.EndsAt,
		}
	}

	for i, rule := range config.Inhibitions {
		if err := validateEqualLabels(rule.Equal); err != nil {
			return compiledConfig{}, fmt.Errorf("inhibition rule %q: %w", rule.Name, err)
		}
		source, err := compileMatchers(rule.SourceMatchers)
		if err != nil {
			return compiledConfig{}, fmt.Errorf("inhibition rule %q source: %w", rule.Name, err)
		}
		target, err := compileMatchers(rule.TargetMatchers)
		if err != nil {
			return compiledConfig{}, fmt.Errorf("inhibition rule %q target: %w", rule.Name, err)
		}
		compiled.inhibitions[i] = compiledInhibitionRule{
			index:  i,
			name:   rule.Name,
			key:    inhibitionKey(rule),
			source: source,
			target: target,
			equal:  append([]string(nil), rule.Equal...),
		}
	}

	return compiled, nil
}

func normalizeGroupBy(names []string) []string {
	if len(names) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(names))
	normalized := make([]string, 0, len(names))
	for _, name := range names {
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	sort.Strings(normalized)
	return normalized
}

func validateEqualLabels(names []string) error {
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if name == "" {
			return fmt.Errorf("equal label name must not be empty")
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("equal label %q is duplicated", name)
		}
		seen[name] = struct{}{}
	}
	return nil
}

func silenceKey(s Silence) string {
	if s.ID != "" {
		return "id:" + s.ID
	}
	var b strings.Builder
	b.WriteString("silence:")
	for _, matcher := range s.Matchers {
		writeMatcherKey(&b, "|", matcher)
	}
	b.WriteString("|")
	b.WriteString(s.StartsAt.UTC().Format(time.RFC3339Nano))
	b.WriteString("|")
	b.WriteString(s.EndsAt.UTC().Format(time.RFC3339Nano))
	return b.String()
}

func inhibitionKey(r InhibitionRule) string {
	if r.Name != "" {
		return "name:" + r.Name
	}
	var b strings.Builder
	b.WriteString("rule:")
	for _, matcher := range r.SourceMatchers {
		writeMatcherKey(&b, "|s:", matcher)
	}
	for _, matcher := range r.TargetMatchers {
		writeMatcherKey(&b, "|t:", matcher)
	}
	for _, name := range r.Equal {
		b.WriteString("|e:")
		b.WriteString(strconv.Quote(name))
	}
	return b.String()
}

func writeMatcherKey(b *strings.Builder, prefix string, matcher Matcher) {
	kind := matcher.Type
	if kind == "" {
		kind = MatchEqual
	}
	b.WriteString(prefix)
	b.WriteString(strconv.Quote(matcher.Name))
	b.WriteByte(':')
	b.WriteString(strconv.Quote(string(kind)))
	b.WriteByte('=')
	b.WriteString(strconv.Quote(matcher.Value))
}
