package formal

import (
	"sort"
	"strings"
	"time"
)

// SuppressionKind identifies why an alert was removed from the notification
// set.
type SuppressionKind string

const (
	SuppressionNone       SuppressionKind = ""
	SuppressionSilence    SuppressionKind = "silence"
	SuppressionInhibition SuppressionKind = "inhibition"
)

// Decision records whether one unique alert is kept or suppressed.
//
// When both a silence and an inhibition match the same alert, silence wins:
// an explicit operator mute is a stronger statement than an inferred
// inhibition. The choice is deterministic and does not depend on map order.
type Decision struct {
	Fingerprint string
	Kept        bool
	Suppression SuppressionKind
	// Silenced and Inhibited expose both matches, including an intersection
	// where Suppression reports the winning silence.
	Silenced  bool
	Inhibited bool
	// Rule is the silence ID, or the inhibition rule name. For unnamed
	// rules it is a canonical rule key.
	Rule string
	// RuleIndex is the zero-based position in the active configuration.
	// It is -1 when the alert is kept.
	RuleIndex int
	// Source is the fingerprint of the inhibiting source alert, if any.
	Source string
	// GroupKey is set only for kept alerts.
	GroupKey string
}

// Suppressed reports whether the alert was removed from notifications.
func (d Decision) Suppressed() bool {
	return !d.Kept
}

// Notification is one deduplicated notification group.
type Notification struct {
	GroupKey    string
	GroupLabels Labels
	Alerts      []Alert
}

// Fingerprints returns the alert identities in stable order.
func (n Notification) Fingerprints() []string {
	fingerprints := make([]string, len(n.Alerts))
	for i, alert := range n.Alerts {
		fingerprints[i] = alert.Fingerprint()
	}
	return fingerprints
}

// ID is a stable identity for the exact group and alert membership. It is
// suitable for suppressing duplicate deliveries after rule updates.
func (n Notification) ID() string {
	return n.GroupKey + "\x00" + strings.Join(n.Fingerprints(), "\x00")
}

// Report is the result of evaluating all active alerts against one rule
// snapshot. Both decisions and notifications are complete and deduplicated.
type Report struct {
	Decisions     []Decision
	Notifications []Notification
}

// Evaluate computes a complete notification set from a rule set and an alert
// slice. It is a pure function: duplicate alerts are merged by fingerprint and
// neither the rules nor the alerts are mutated.
//
// Evaluation uses one consistent snapshot of all rules and alerts. A result
// can therefore not depend on the order in which alerts arrived.
func Evaluate(config Config, alerts []Alert, now time.Time) (Report, error) {
	compiled, err := compileConfig(config)
	if err != nil {
		return Report{}, err
	}
	return evaluateCompiled(compiled, alerts, now), nil
}

func evaluateCompiled(config compiledConfig, input []Alert, now time.Time) Report {
	alerts := dedupeAlerts(input)

	activeSilences := make([]compiledSilence, 0, len(config.silences))
	for _, silence := range config.silences {
		if silence.activeAt(now) {
			activeSilences = append(activeSilences, silence)
		}
	}

	decisions := make([]Decision, 0, len(alerts))
	groups := make(map[string]*groupAccumulator)

	for _, alert := range alerts {
		bestSilence, hasSilence := selectSilence(activeSilences, alert.Labels)
		bestInhibition, hasInhibition := selectInhibition(config.inhibitions, alerts, alert)

		decision := Decision{
			Fingerprint: alert.Fingerprint(),
			RuleIndex:   -1,
			Silenced:    hasSilence,
			Inhibited:   hasInhibition,
		}
		if hasInhibition {
			decision.Source = bestInhibition.source
		}
		switch {
		case hasSilence:
			decision.Suppression = SuppressionSilence
			decision.Rule = bestSilence.id
			if decision.Rule == "" {
				decision.Rule = bestSilence.key
			}
			decision.RuleIndex = bestSilence.index
		case hasInhibition:
			decision.Suppression = SuppressionInhibition
			decision.Rule = bestInhibition.rule.name
			if decision.Rule == "" {
				decision.Rule = bestInhibition.rule.key
			}
			decision.RuleIndex = bestInhibition.rule.index
		default:
			decision.Kept = true
			labels, key := groupLabels(config.groupBy, alert.Labels)
			decision.GroupKey = key
			accumulator := groups[key]
			if accumulator == nil {
				accumulator = &groupAccumulator{labels: labels}
				groups[key] = accumulator
			}
			accumulator.alerts = append(accumulator.alerts, alert.Clone())
		}
		decisions = append(decisions, decision)
	}

	notifications := make([]Notification, 0, len(groups))
	for key, accumulator := range groups {
		sort.Slice(accumulator.alerts, func(i, j int) bool {
			return accumulator.alerts[i].Fingerprint() < accumulator.alerts[j].Fingerprint()
		})
		notifications = append(notifications, Notification{
			GroupKey:    key,
			GroupLabels: accumulator.labels,
			Alerts:      accumulator.alerts,
		})
	}
	sort.Slice(notifications, func(i, j int) bool {
		return notifications[i].GroupKey < notifications[j].GroupKey
	})

	return Report{Decisions: decisions, Notifications: notifications}
}

func dedupeAlerts(input []Alert) []Alert {
	merged := make(map[string]Alert, len(input))
	for _, alert := range input {
		fingerprint := alert.Fingerprint()
		existing, exists := merged[fingerprint]
		if exists {
			merged[fingerprint] = earlierAlert(existing, alert)
			continue
		}
		merged[fingerprint] = alert.Clone()
	}

	alerts := make([]Alert, 0, len(merged))
	for _, alert := range merged {
		alerts = append(alerts, alert)
	}
	sort.Slice(alerts, func(i, j int) bool {
		return alerts[i].Fingerprint() < alerts[j].Fingerprint()
	})
	return alerts
}

type groupAccumulator struct {
	labels Labels
	alerts []Alert
}

func groupLabels(groupBy []string, alertLabels Labels) (Labels, string) {
	labels := make(Labels, len(groupBy))
	for _, name := range groupBy {
		labels[name] = alertLabels[name]
	}
	return labels, labels.String()
}

type inhibitionMatch struct {
	rule   compiledInhibitionRule
	source string
}

func selectSilence(silences []compiledSilence, labels Labels) (compiledSilence, bool) {
	var best compiledSilence
	found := false
	for _, silence := range silences {
		if !matchesAll(silence.matchers, labels) {
			continue
		}
		if !found || silenceLess(silence, best) {
			best = silence
			found = true
		}
	}
	return best, found
}

func selectInhibition(rules []compiledInhibitionRule, alerts []Alert, target Alert) (inhibitionMatch, bool) {
	// alerts is already sorted by fingerprint, so the first matching source
	// is deterministic.
	var best inhibitionMatch
	found := false
	for _, rule := range rules {
		if !matchesAll(rule.target, target.Labels) {
			continue
		}
		for _, source := range alerts {
			if source.Fingerprint() == target.Fingerprint() {
				continue
			}
			if !matchesAll(rule.source, source.Labels) {
				continue
			}
			if !equalLabels(rule.equal, source.Labels, target.Labels) {
				continue
			}
			candidate := inhibitionMatch{rule: rule, source: source.Fingerprint()}
			if !found || inhibitionLess(candidate, best) {
				best = candidate
				found = true
			}
			break
		}
	}
	return best, found
}

func equalLabels(names []string, source, target Labels) bool {
	for _, name := range names {
		if source[name] != target[name] {
			return false
		}
	}
	return true
}

func (s compiledSilence) activeAt(now time.Time) bool {
	if !s.starts.IsZero() && now.Before(s.starts) {
		return false
	}
	if !s.ends.IsZero() && !now.Before(s.ends) {
		return false
	}
	return true
}

func silenceLess(a, b compiledSilence) bool {
	if !a.starts.Equal(b.starts) {
		return startLess(a.starts, b.starts)
	}
	if !a.ends.Equal(b.ends) {
		return endLess(a.ends, b.ends)
	}
	if a.key != b.key {
		return a.key < b.key
	}
	return a.index < b.index
}

func inhibitionLess(a, b inhibitionMatch) bool {
	if a.rule.key != b.rule.key {
		return a.rule.key < b.rule.key
	}
	if a.rule.index != b.rule.index {
		return a.rule.index < b.rule.index
	}
	return a.source < b.source
}

func startLess(a, b time.Time) bool {
	switch {
	case a.IsZero():
		return !b.IsZero()
	case b.IsZero():
		return false
	default:
		return a.Before(b)
	}
}

func endLess(a, b time.Time) bool {
	// A zero EndsAt is an open-ended silence and sorts after every finite
	// end time.
	switch {
	case a.IsZero():
		return false
	case b.IsZero():
		return true
	default:
		return a.Before(b)
	}
}
