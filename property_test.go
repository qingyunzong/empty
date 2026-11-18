package formal

import (
	"fmt"
	"math/rand"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

type naiveDecision struct {
	kept        bool
	suppression SuppressionKind
}

type naiveReport struct {
	decisions     map[string]naiveDecision
	notifications map[string][]string
}

type naiveState struct {
	config Config
	alerts map[string]Alert
}

func newNaiveState(config Config) *naiveState {
	return &naiveState{
		config: config.Clone(),
		alerts: make(map[string]Alert),
	}
}

func (s *naiveState) add(alert Alert) {
	fingerprint := alert.Fingerprint()
	existing, exists := s.alerts[fingerprint]
	if !exists {
		s.alerts[fingerprint] = alert.Clone()
		return
	}
	s.alerts[fingerprint] = earlierAlert(existing, alert)
}

func (s *naiveState) remove(alert Alert) {
	delete(s.alerts, alert.Fingerprint())
}

// naiveEvaluate deliberately uses straightforward loops and its own matcher,
// grouping and suppression rules. It is kept independent of the engine's
// selection helpers so that the property test can detect shared mistakes.
func naiveEvaluate(config Config, alerts map[string]Alert, now time.Time) naiveReport {
	unique := make([]Alert, 0, len(alerts))
	for _, alert := range alerts {
		unique = append(unique, alert.Clone())
	}
	sort.Slice(unique, func(i, j int) bool {
		return unique[i].Fingerprint() < unique[j].Fingerprint()
	})

	groupBy := naiveGroupBy(config.GroupBy)
	report := naiveReport{
		decisions:     make(map[string]naiveDecision, len(unique)),
		notifications: make(map[string][]string),
	}

	for _, target := range unique {
		silenced := false
		for _, silence := range config.Silences {
			if !naiveSilenceActive(silence, now) {
				continue
			}
			if naiveMatchesAll(silence.Matchers, target.Labels) {
				silenced = true
				break
			}
		}

		inhibited := false
		for _, rule := range config.Inhibitions {
			if !naiveMatchesAll(rule.TargetMatchers, target.Labels) {
				continue
			}
			for _, source := range unique {
				if source.Fingerprint() == target.Fingerprint() {
					continue
				}
				if !naiveMatchesAll(rule.SourceMatchers, source.Labels) {
					continue
				}
				if !naiveEqualLabels(rule.Equal, source.Labels, target.Labels) {
					continue
				}
				inhibited = true
				break
			}
			if inhibited {
				break
			}
		}

		decision := naiveDecision{kept: !silenced && !inhibited}
		switch {
		case silenced:
			decision.suppression = SuppressionSilence
		case inhibited:
			decision.suppression = SuppressionInhibition
		}
		report.decisions[target.Fingerprint()] = decision

		if decision.kept {
			key := naiveGroupKey(groupBy, target.Labels)
			report.notifications[key] = append(report.notifications[key], target.Fingerprint())
		}
	}

	for key := range report.notifications {
		sort.Strings(report.notifications[key])
	}
	return report
}

func naiveGroupBy(names []string) []string {
	seen := make(map[string]struct{}, len(names))
	result := make([]string, 0, len(names))
	for _, name := range names {
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func naiveGroupKey(groupBy []string, labels Labels) string {
	var b strings.Builder
	for i, name := range groupBy {
		if i > 0 {
			b.WriteByte('\x1f')
		}
		b.WriteString(strconv.Quote(name))
		b.WriteByte('=')
		b.WriteString(strconv.Quote(labels[name]))
	}
	return b.String()
}

func naiveSilenceActive(silence Silence, now time.Time) bool {
	if !silence.StartsAt.IsZero() && now.Before(silence.StartsAt) {
		return false
	}
	if !silence.EndsAt.IsZero() && !now.Before(silence.EndsAt) {
		return false
	}
	return true
}

func naiveMatchesAll(matchers []Matcher, labels Labels) bool {
	for _, matcher := range matchers {
		value := labels[matcher.Name]
		switch matcher.Type {
		case "", MatchEqual:
			if value != matcher.Value {
				return false
			}
		case MatchNotEqual:
			if value == matcher.Value {
				return false
			}
		case MatchRegexp, MatchNotRegexp:
			re, err := regexp.Compile(`\A(?:` + matcher.Value + `)\z`)
			if err != nil {
				return false
			}
			matched := re.MatchString(value)
			if matcher.Type == MatchRegexp && !matched {
				return false
			}
			if matcher.Type == MatchNotRegexp && matched {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func naiveEqualLabels(names []string, source, target Labels) bool {
	for _, name := range names {
		if source[name] != target[name] {
			return false
		}
	}
	return true
}

func compareWithNaive(t *testing.T, report Report, expected naiveReport, config Config, context string) {
	t.Helper()

	if len(report.Decisions) != len(expected.decisions) {
		t.Fatalf("%s: got %d decisions, want %d", context, len(report.Decisions), len(expected.decisions))
	}
	seenDecisions := make(map[string]struct{}, len(report.Decisions))
	for _, decision := range report.Decisions {
		if _, exists := seenDecisions[decision.Fingerprint]; exists {
			t.Fatalf("%s: duplicate decision for %q", context, decision.Fingerprint)
		}
		seenDecisions[decision.Fingerprint] = struct{}{}

		want, exists := expected.decisions[decision.Fingerprint]
		if !exists {
			t.Fatalf("%s: unexpected decision for %q", context, decision.Fingerprint)
		}
		if decision.Kept != want.kept {
			t.Fatalf("%s: alert %q kept = %v, want %v (got %+v)",
				context, decision.Fingerprint, decision.Kept, want.kept, decision)
		}
		if !decision.Kept && decision.Suppression != want.suppression {
			t.Fatalf("%s: alert %q suppression = %q, want %q",
				context, decision.Fingerprint, decision.Suppression, want.suppression)
		}
	}

	groupBy := naiveGroupBy(config.GroupBy)
	gotGroups := make(map[string][]string, len(report.Notifications))
	seenGroupKeys := make(map[string]struct{}, len(report.Notifications))
	seenAlertFingerprints := make(map[string]struct{}, len(report.Decisions))
	for _, notification := range report.Notifications {
		if _, exists := seenGroupKeys[notification.GroupKey]; exists {
			t.Fatalf("%s: duplicate notification group key %q", context, notification.GroupKey)
		}
		seenGroupKeys[notification.GroupKey] = struct{}{}
		if notification.GroupKey != notification.GroupLabels.String() {
			t.Fatalf("%s: group key %q is not canonical labels %q",
				context, notification.GroupKey, notification.GroupLabels.String())
		}

		key := naiveGroupKey(groupBy, notification.GroupLabels)
		if _, exists := gotGroups[key]; exists {
			t.Fatalf("%s: duplicate notification group %q", context, key)
		}

		fingerprints := notification.Fingerprints()
		for i, fingerprint := range fingerprints {
			if i > 0 && fingerprints[i-1] >= fingerprint {
				t.Fatalf("%s: notification alerts are not in strict order: %v", context, fingerprints)
			}
			if _, exists := seenAlertFingerprints[fingerprint]; exists {
				t.Fatalf("%s: alert %q appears in more than one position", context, fingerprint)
			}
			seenAlertFingerprints[fingerprint] = struct{}{}
		}
		gotGroups[key] = fingerprints
	}

	if !reflect.DeepEqual(gotGroups, expected.notifications) {
		t.Fatalf("%s: notifications = %#v, want %#v", context, gotGroups, expected.notifications)
	}
}

type sequenceOp struct {
	name  string
	apply func(*Engine, *naiveState) error
}

func addAlertOp(alert Alert) sequenceOp {
	return sequenceOp{
		name: "add:" + alert.Labels["instance"],
		apply: func(engine *Engine, state *naiveState) error {
			engine.AddAlerts(alert)
			state.add(alert)
			return nil
		},
	}
}

func duplicateAlertOp(alert Alert) sequenceOp {
	return sequenceOp{
		name: "duplicate:" + alert.Labels["instance"],
		apply: func(engine *Engine, state *naiveState) error {
			engine.AddAlerts(alert)
			state.add(alert)
			return nil
		},
	}
}

func removeAlertOp(alert Alert) sequenceOp {
	return sequenceOp{
		name: "remove:" + alert.Labels["instance"],
		apply: func(engine *Engine, state *naiveState) error {
			engine.RemoveAlerts(alert.Fingerprint())
			state.remove(alert)
			return nil
		},
	}
}

func updateRulesOp(name string, config Config) sequenceOp {
	return sequenceOp{
		name: "rules:" + name,
		apply: func(engine *Engine, state *naiveState) error {
			if err := engine.UpdateRules(config); err != nil {
				return err
			}
			state.config = config.Clone()
			return nil
		},
	}
}

func runSequence(t *testing.T, ops []sequenceOp, sequence []int, context string) {
	t.Helper()

	base := mustEngine(t, sequenceConfig0)
	state := newNaiveState(sequenceConfig0)
	delivered := make(map[string]struct{})

	for step, operationIndex := range sequence {
		operation := ops[operationIndex]
		stepContext := fmt.Sprintf("%s step %d (%s)", context, step, operation.name)
		if err := operation.apply(base, state); err != nil {
			t.Fatalf("%s: %v", stepContext, err)
		}

		report := base.Snapshot(testNow)
		compareWithNaive(t, report, naiveEvaluate(state.config, state.alerts, testNow), state.config, stepContext)

		byID := make(map[string]Notification, len(report.Notifications))
		expectedFresh := make([]string, 0, len(report.Notifications))
		for _, notification := range report.Notifications {
			id := notification.ID()
			byID[id] = notification
			if _, exists := delivered[id]; !exists {
				expectedFresh = append(expectedFresh, id)
			}
		}

		fresh := base.Poll(testNow)
		if got := notificationIDs(fresh); !reflect.DeepEqual(got, expectedFresh) {
			t.Fatalf("%s: Poll() = %v, want %v", stepContext, got, expectedFresh)
		}
		for _, notification := range fresh {
			id := notification.ID()
			if _, exists := delivered[id]; exists {
				t.Fatalf("%s: Poll() repeated notification %q", stepContext, id)
			}
			delivered[id] = struct{}{}
			want, exists := byID[id]
			if !exists {
				t.Fatalf("%s: Poll() returned notification %q absent from Snapshot", stepContext, id)
			}
			if !reflect.DeepEqual(notification, want) {
				t.Fatalf("%s: Poll() notification differs from Snapshot:\ngot:  %+v\nwant: %+v",
					stepContext, notification, want)
			}
		}
	}
}

func enumerateSequences(ops []sequenceOp, depth int, visit func([]int)) {
	sequence := make([]int, depth)
	var enumerate func(int)
	enumerate = func(position int) {
		if position == depth {
			visit(sequence)
			return
		}
		for i := range ops {
			sequence[position] = i
			enumerate(position + 1)
		}
	}
	enumerate(0)
}

var sequenceConfig0 = Config{
	GroupBy: []string{"env", "service"},
	Inhibitions: []InhibitionRule{{
		Name:           "critical-hides-warning",
		SourceMatchers: []Matcher{{Name: "severity", Value: "critical"}},
		TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
		Equal:          []string{"env", "service", "instance"},
	}},
	Silences: []Silence{{
		ID:       "mute-db",
		Matchers: []Matcher{{Name: "service", Value: "db"}},
		StartsAt: testNow.Add(-time.Hour),
		EndsAt:   testNow.Add(time.Hour),
	}},
}

var sequenceConfig1 = Config{
	GroupBy: []string{"service"},
	Inhibitions: []InhibitionRule{{
		Name:           "prod-critical-hides-prod-warning",
		SourceMatchers: []Matcher{{Name: "env", Value: "prod"}, {Name: "severity", Value: "critical"}},
		TargetMatchers: []Matcher{{Name: "env", Value: "prod"}, {Name: "severity", Value: "warning"}},
		Equal:          []string{"service"},
	}},
	Silences: []Silence{
		{
			ID:       "mute-db",
			Matchers: []Matcher{{Name: "service", Value: "db"}},
			StartsAt: testNow.Add(-time.Hour),
			EndsAt:   testNow.Add(time.Hour),
		},
		{
			ID:       "mute-dev-api",
			Matchers: []Matcher{{Name: "env", Value: "dev"}, {Name: "service", Value: "api"}},
			StartsAt: testNow.Add(-time.Hour),
			EndsAt:   testNow.Add(time.Hour),
		},
	},
}

var sequenceConfig2 = Config{
	GroupBy: []string{"env"},
	Silences: []Silence{{
		ID:       "mute-db",
		Matchers: []Matcher{{Name: "service", Value: "db"}},
		StartsAt: testNow.Add(-time.Hour),
		EndsAt:   testNow.Add(time.Hour),
	}},
}

var sequenceConfig3 = Config{}

func sequenceOperations() []sequenceOp {
	apiCritical := alert(testNow, "env", "prod", "service", "api", "instance", "a", "severity", "critical")
	apiWarning := alert(testNow, "env", "prod", "service", "api", "instance", "b", "severity", "warning")
	dbCritical := alert(testNow, "env", "prod", "service", "db", "instance", "c", "severity", "critical")
	devWarning := alert(testNow, "env", "dev", "service", "api", "instance", "d", "severity", "warning")
	devCritical := alert(testNow, "env", "dev", "service", "api", "instance", "e", "severity", "critical")
	duplicate := alert(testNow.Add(-time.Minute), "instance", "a", "severity", "critical", "service", "api", "env", "prod")

	return []sequenceOp{
		addAlertOp(apiCritical),
		addAlertOp(apiWarning),
		addAlertOp(dbCritical),
		addAlertOp(devWarning),
		addAlertOp(devCritical),
		duplicateAlertOp(duplicate),
		removeAlertOp(apiCritical),
		removeAlertOp(apiWarning),
		removeAlertOp(dbCritical),
		updateRulesOp("v0", sequenceConfig0),
		updateRulesOp("v1", sequenceConfig1),
		updateRulesOp("v2", sequenceConfig2),
		updateRulesOp("v3-empty-grouping", sequenceConfig3),
	}
}

func TestExhaustiveShortSequencesAgainstNaiveModel(t *testing.T) {
	ops := sequenceOperations()
	const depth = 4

	count := 0
	enumerateSequences(ops, depth, func(sequence []int) {
		count++
		names := make([]string, len(sequence))
		for i, index := range sequence {
			names[i] = ops[index].name
		}
		runSequence(t, ops, sequence, "exhaustive "+strings.Join(names, ","))
	})

	want := 1
	for i := 0; i < depth; i++ {
		want *= len(ops)
	}
	if count != want {
		t.Fatalf("enumerated %d sequences, want %d", count, want)
	}
}

func TestRandomLongInterleavingsAgainstNaiveModel(t *testing.T) {
	ops := sequenceOperations()
	const (
		seeds       = 120
		sequenceLen = 60
	)

	for seed := int64(0); seed < seeds; seed++ {
		rng := rand.New(rand.NewSource(seed))
		sequence := make([]int, sequenceLen)
		for i := range sequence {
			sequence[i] = rng.Intn(len(ops))
		}
		runSequence(t, ops, sequence, fmt.Sprintf("random seed %d", seed))
	}
}
