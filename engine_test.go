package formal

import (
	"reflect"
	"sync"
	"testing"
	"time"
)

var testNow = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

func labels(pairs ...string) Labels {
	if len(pairs)%2 != 0 {
		panic("labels requires key/value pairs")
	}
	result := make(Labels, len(pairs)/2)
	for i := 0; i < len(pairs); i += 2 {
		result[pairs[i]] = pairs[i+1]
	}
	return result
}

func alert(start time.Time, pairs ...string) Alert {
	return Alert{Labels: labels(pairs...), StartsAt: start}
}

func mustEngine(t *testing.T, config Config) *Engine {
	t.Helper()
	engine, err := NewEngine(config)
	if err != nil {
		t.Fatalf("NewEngine() error = %v", err)
	}
	return engine
}

func decisionByFingerprint(report Report) map[string]Decision {
	decisions := make(map[string]Decision, len(report.Decisions))
	for _, decision := range report.Decisions {
		decisions[decision.Fingerprint] = decision
	}
	return decisions
}

func notificationIDs(notifications []Notification) []string {
	ids := make([]string, len(notifications))
	for i, notification := range notifications {
		ids[i] = notification.ID()
	}
	return ids
}

func TestMatcherSemantics(t *testing.T) {
	cases := []struct {
		name    string
		matcher Matcher
		labels  Labels
		want    bool
	}{
		{
			name:    "zero operator means equality",
			matcher: Matcher{Name: "env", Value: "prod"},
			labels:  labels("env", "prod"),
			want:    true,
		},
		{
			name:    "missing label is empty",
			matcher: Matcher{Name: "env", Type: MatchEqual, Value: ""},
			labels:  labels("service", "api"),
			want:    true,
		},
		{
			name:    "not equal",
			matcher: Matcher{Name: "env", Type: MatchNotEqual, Value: "prod"},
			labels:  labels("env", "dev"),
			want:    true,
		},
		{
			name:    "regex is anchored on the left",
			matcher: Matcher{Name: "env", Type: MatchRegexp, Value: "prod"},
			labels:  labels("env", "prod-eu"),
			want:    false,
		},
		{
			name:    "regex is anchored on the right",
			matcher: Matcher{Name: "env", Type: MatchRegexp, Value: "prod"},
			labels:  labels("env", "eu-prod"),
			want:    false,
		},
		{
			name:    "regex matches the whole value",
			matcher: Matcher{Name: "env", Type: MatchRegexp, Value: "pro.*"},
			labels:  labels("env", "prod"),
			want:    true,
		},
		{
			name:    "negative regex",
			matcher: Matcher{Name: "env", Type: MatchNotRegexp, Value: "prod"},
			labels:  labels("env", "dev"),
			want:    true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.matcher.Matches(tc.labels); got != tc.want {
				t.Fatalf("Matcher.Matches() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestConfigValidation(t *testing.T) {
	cases := []struct {
		name   string
		config Config
	}{
		{
			name: "empty group-by label",
			config: Config{
				GroupBy: []string{""},
			},
		},
		{
			name: "invalid regular expression",
			config: Config{
				Silences: []Silence{{
					ID:       "bad",
					Matchers: []Matcher{{Name: "env", Type: MatchRegexp, Value: "["}},
				}},
			},
		},
		{
			name: "duplicate silence ID",
			config: Config{
				Silences: []Silence{
					{ID: "same"},
					{ID: "same"},
				},
			},
		},
		{
			name: "silence ends before it starts",
			config: Config{
				Silences: []Silence{{
					StartsAt: testNow,
					EndsAt:   testNow.Add(-time.Minute),
				}},
			},
		},
		{
			name: "duplicate equal label",
			config: Config{
				Inhibitions: []InhibitionRule{{
					Equal: []string{"env", "env"},
				}},
			},
		},
		{
			name: "unknown matcher operator",
			config: Config{
				Inhibitions: []InhibitionRule{{
					SourceMatchers: []Matcher{{Name: "env", Type: "===", Value: "prod"}},
				}},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.config.Validate(); err == nil {
				t.Fatal("Config.Validate() = nil, want an error")
			}
		})
	}

	if err := (Config{GroupBy: []string{"env", "env", "service"}}).Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestInhibitionRequiresEveryLabelCondition(t *testing.T) {
	config := Config{
		GroupBy: []string{"service"},
		Inhibitions: []InhibitionRule{{
			Name:           "critical-hides-warning",
			SourceMatchers: []Matcher{{Name: "severity", Type: MatchEqual, Value: "critical"}},
			TargetMatchers: []Matcher{{Name: "severity", Type: MatchEqual, Value: "warning"}},
			Equal:          []string{"env", "service"},
		}},
	}

	source := alert(testNow, "env", "prod", "service", "api", "instance", "i-a", "severity", "critical")
	sameGroup := alert(testNow, "env", "prod", "service", "api", "instance", "i-b", "severity", "warning")
	differentEnv := alert(testNow, "env", "dev", "service", "api", "instance", "i-c", "severity", "warning")
	differentService := alert(testNow, "env", "prod", "service", "db", "instance", "i-d", "severity", "warning")
	notATarget := alert(testNow, "env", "prod", "service", "api", "instance", "i-e", "severity", "info")

	report, err := Evaluate(config, []Alert{source, sameGroup, differentEnv, differentService, notATarget}, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	decisions := decisionByFingerprint(report)

	inhibited := decisions[sameGroup.Fingerprint()]
	if inhibited.Kept || inhibited.Suppression != SuppressionInhibition {
		t.Fatalf("same-group target decision = %+v, want inhibition", inhibited)
	}
	if inhibited.Source != source.Fingerprint() {
		t.Fatalf("inhibition source = %q, want %q", inhibited.Source, source.Fingerprint())
	}

	for _, notInhibited := range []Alert{differentEnv, differentService, notATarget} {
		decision := decisions[notInhibited.Fingerprint()]
		if !decision.Kept {
			t.Fatalf("alert %q was suppressed, want kept: %+v", notInhibited.Fingerprint(), decision)
		}
	}
}

func TestSilenceWindowAndStableIntersection(t *testing.T) {
	config := Config{
		GroupBy: []string{"service"},
		Inhibitions: []InhibitionRule{{
			Name:           "critical-hides-warning",
			SourceMatchers: []Matcher{{Name: "severity", Value: "critical"}},
			TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
			Equal:          []string{"env", "service"},
		}},
		Silences: []Silence{{
			ID:       "mute-api",
			Matchers: []Matcher{{Name: "service", Value: "api"}},
			StartsAt: testNow.Add(-time.Hour),
			EndsAt:   testNow.Add(time.Hour),
		}},
	}

	source := alert(testNow, "env", "prod", "service", "api", "instance", "i-a", "severity", "critical")
	target := alert(testNow, "env", "prod", "service", "api", "instance", "i-b", "severity", "warning")

	cases := []struct {
		name string
		now  time.Time
		want SuppressionKind
	}{
		{
			name: "before silence only inhibition applies",
			now:  testNow.Add(-2 * time.Hour),
			want: SuppressionInhibition,
		},
		{
			name: "inside silence silence wins the intersection",
			now:  testNow,
			want: SuppressionSilence,
		},
		{
			name: "at silence end inhibition applies again",
			now:  testNow.Add(time.Hour),
			want: SuppressionInhibition,
		},
		{
			name: "after silence only inhibition applies",
			now:  testNow.Add(2 * time.Hour),
			want: SuppressionInhibition,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			first, err := Evaluate(config, []Alert{source, target}, tc.now)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			second, err := Evaluate(config, []Alert{target, source, source}, tc.now)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			if !reflect.DeepEqual(first, second) {
				t.Fatalf("evaluation depends on input order or duplicates:\nfirst:  %+v\nsecond: %+v", first, second)
			}

			decision := decisionByFingerprint(first)[target.Fingerprint()]
			if decision.Kept {
				t.Fatalf("target was kept at %v, want suppression", tc.now)
			}
			if decision.Suppression != tc.want {
				t.Fatalf("suppression = %q, want %q", decision.Suppression, tc.want)
			}
			if tc.want == SuppressionSilence && !decision.Silenced {
				t.Fatalf("silence-winning decision is not marked Silenced: %+v", decision)
			}
			if tc.want == SuppressionInhibition && decision.Inhibited == decision.Silenced {
				t.Fatalf("inhibition-only decision has inconsistent match flags: %+v", decision)
			}
			if tc.now.Equal(testNow) && (!decision.Silenced || !decision.Inhibited) {
				t.Fatalf("intersection decision should expose both matches: %+v", decision)
			}
		})
	}

	withoutSource, err := Evaluate(config, []Alert{target}, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if decision := decisionByFingerprint(withoutSource)[target.Fingerprint()]; decision.Suppression != SuppressionSilence {
		t.Fatalf("target without source = %+v, want silence", decision)
	}

	afterWindow, err := Evaluate(config, []Alert{target}, testNow.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if decision := decisionByFingerprint(afterWindow)[target.Fingerprint()]; !decision.Kept {
		t.Fatalf("target after silence and without source = %+v, want kept", decision)
	}
}

func TestStableSuppressionSelection(t *testing.T) {
	source := alert(testNow, "env", "prod", "service", "api", "severity", "critical")
	target := alert(testNow, "env", "prod", "service", "api", "severity", "warning")

	silenceCases := []struct {
		name     string
		silences []Silence
		wantID   string
	}{
		{
			name: "same window uses rule key",
			silences: []Silence{
				{
					ID:       "z-mute",
					Matchers: []Matcher{{Name: "service", Value: "api"}},
					StartsAt: testNow.Add(-time.Hour),
					EndsAt:   testNow.Add(time.Hour),
				},
				{
					ID:       "a-mute",
					Matchers: []Matcher{{Name: "env", Value: "prod"}},
					StartsAt: testNow.Add(-time.Hour),
					EndsAt:   testNow.Add(time.Hour),
				},
			},
			wantID: "a-mute",
		},
		{
			name: "earlier start wins",
			silences: []Silence{
				{
					ID:       "a-mute",
					Matchers: []Matcher{{Name: "service", Value: "api"}},
					StartsAt: testNow.Add(-time.Hour),
					EndsAt:   testNow.Add(2 * time.Hour),
				},
				{
					ID:       "z-mute",
					Matchers: []Matcher{{Name: "env", Value: "prod"}},
					StartsAt: testNow.Add(-3 * time.Hour),
					EndsAt:   testNow.Add(3 * time.Hour),
				},
			},
			wantID: "z-mute",
		},
		{
			name: "earlier end breaks a start tie",
			silences: []Silence{
				{
					ID:       "z-mute",
					Matchers: []Matcher{{Name: "service", Value: "api"}},
					StartsAt: testNow.Add(-time.Hour),
					EndsAt:   testNow.Add(3 * time.Hour),
				},
				{
					ID:       "a-mute",
					Matchers: []Matcher{{Name: "env", Value: "prod"}},
					StartsAt: testNow.Add(-time.Hour),
					EndsAt:   testNow.Add(2 * time.Hour),
				},
			},
			wantID: "a-mute",
		},
	}

	for _, tc := range silenceCases {
		t.Run("silence "+tc.name, func(t *testing.T) {
			config := Config{GroupBy: []string{"service"}, Silences: tc.silences}
			forward, err := Evaluate(config, []Alert{source, target}, testNow)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			reverse, err := Evaluate(config, []Alert{target, source}, testNow)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			if !reflect.DeepEqual(forward, reverse) {
				t.Fatal("silence selection depends on alert order")
			}
			decision := decisionByFingerprint(forward)[target.Fingerprint()]
			if decision.Suppression != SuppressionSilence || decision.Rule != tc.wantID {
				t.Fatalf("decision = %+v, want silence %q", decision, tc.wantID)
			}
		})
	}

	inhibitionConfig := Config{
		GroupBy: []string{"service"},
		Inhibitions: []InhibitionRule{
			{
				Name:           "z-rule",
				SourceMatchers: []Matcher{{Name: "service", Value: "api"}},
				TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
			},
			{
				Name:           "a-rule",
				SourceMatchers: []Matcher{{Name: "env", Value: "prod"}},
				TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
			},
		},
	}
	forward, err := Evaluate(inhibitionConfig, []Alert{source, target}, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	reverse, err := Evaluate(inhibitionConfig, []Alert{target, source}, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if !reflect.DeepEqual(forward, reverse) {
		t.Fatal("inhibition selection depends on alert order")
	}
	decision := decisionByFingerprint(forward)[target.Fingerprint()]
	if decision.Suppression != SuppressionInhibition || decision.Rule != "a-rule" {
		t.Fatalf("decision = %+v, want inhibition rule a-rule", decision)
	}
}

func TestPublicMatcherAndSilenceHelpers(t *testing.T) {
	now := testNow
	silence := Silence{
		Matchers: []Matcher{{Name: "env", Value: "prod"}},
		StartsAt: now.Add(-time.Minute),
		EndsAt:   now.Add(time.Minute),
	}
	if !silence.ActiveAt(now) {
		t.Fatal("Silence.ActiveAt() = false inside its window")
	}
	if silence.ActiveAt(now.Add(time.Minute)) {
		t.Fatal("Silence.ActiveAt() = true at its exclusive end")
	}
	if !silence.Matches(labels("env", "prod")) {
		t.Fatal("Silence.Matches() = false for matching labels")
	}
	if silence.Matches(labels("env", "dev")) {
		t.Fatal("Silence.Matches() = true for non-matching labels")
	}

	if got := (Labels{"env": "prod"}).Get("env"); got != "prod" {
		t.Fatalf("Labels.Get() = %q, want prod", got)
	}
	if !(Labels{"env": "prod"}).Equal(Labels{"env": "prod"}) {
		t.Fatal("Labels.Equal() = false for equal maps")
	}
	if (Labels{"env": "prod"}).Equal(Labels{"env": "dev"}) {
		t.Fatal("Labels.Equal() = true for different maps")
	}
	if err := (Matcher{Name: "env", Type: MatchRegexp, Value: "["}).Validate(); err == nil {
		t.Fatal("Matcher.Validate() = nil for invalid regex")
	}
}

func TestUnnamedRulesUseCanonicalIdentifiers(t *testing.T) {
	target := alert(testNow, "env", "prod", "service", "api", "severity", "warning")

	silence := Silence{
		Matchers: []Matcher{{Name: "env", Value: "prod"}},
		StartsAt: testNow.Add(-time.Hour),
		EndsAt:   testNow.Add(time.Hour),
	}
	config := Config{Silences: []Silence{silence}}
	report, err := Evaluate(config, []Alert{target}, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	decision := decisionByFingerprint(report)[target.Fingerprint()]
	if decision.Rule != silenceKey(silence) || decision.Rule == "" {
		t.Fatalf("unnamed silence rule = %q, want canonical %q", decision.Rule, silenceKey(silence))
	}

	source := alert(testNow, "env", "prod", "service", "api", "severity", "critical")
	rule := InhibitionRule{
		SourceMatchers: []Matcher{{Name: "severity", Value: "critical"}},
		TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
		Equal:          []string{"env", "service"},
	}
	config = Config{Inhibitions: []InhibitionRule{rule}}
	report, err = Evaluate(config, []Alert{source, target}, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	decision = decisionByFingerprint(report)[target.Fingerprint()]
	if decision.Rule != inhibitionKey(rule) || decision.Rule == "" {
		t.Fatalf("unnamed inhibition rule = %q, want canonical %q", decision.Rule, inhibitionKey(rule))
	}
}

func TestGroupingDedupAndCanonicalOrder(t *testing.T) {
	config := Config{GroupBy: []string{"service", "env", "missing"}}
	later := alert(testNow.Add(time.Minute), "env", "prod", "service", "api")
	earlier := alert(testNow, "service", "api", "env", "prod")
	database := alert(testNow, "env", "prod", "service", "db")

	input := []Alert{database, later, earlier, later}
	originalLater := later.Clone()
	originalDatabase := database.Clone()

	report, err := Evaluate(config, input, testNow)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if len(report.Decisions) != 2 {
		t.Fatalf("got %d decisions, want 2 unique alerts", len(report.Decisions))
	}
	if !reflect.DeepEqual(input[1], originalLater) || !reflect.DeepEqual(input[0], originalDatabase) {
		t.Fatal("Evaluate() mutated the input alerts")
	}

	if len(report.Notifications) != 2 {
		t.Fatalf("got %d notifications, want 2 groups", len(report.Notifications))
	}
	if report.Notifications[0].GroupKey >= report.Notifications[1].GroupKey {
		t.Fatalf("notifications are not sorted by group key: %q, %q",
			report.Notifications[0].GroupKey, report.Notifications[1].GroupKey)
	}

	var apiNotification *Notification
	for i := range report.Notifications {
		if report.Notifications[i].GroupLabels["service"] == "api" {
			apiNotification = &report.Notifications[i]
		}
	}
	if apiNotification == nil {
		t.Fatal("api notification not found")
	}
	if len(apiNotification.Alerts) != 1 {
		t.Fatalf("api notification has %d alerts, want duplicate collapsed to 1", len(apiNotification.Alerts))
	}
	if !apiNotification.Alerts[0].StartsAt.Equal(testNow) {
		t.Fatalf("duplicate merge kept StartsAt = %v, want earliest %v",
			apiNotification.Alerts[0].StartsAt, testNow)
	}
	if got := apiNotification.GroupLabels["missing"]; got != "" {
		t.Fatalf("missing group-by label = %q, want empty string", got)
	}
	if apiNotification.GroupKey != apiNotification.GroupLabels.String() {
		t.Fatalf("group key %q is not the canonical label form %q",
			apiNotification.GroupKey, apiNotification.GroupLabels.String())
	}
}

func TestEngineRuleUpdatesDoNotDuplicateDeliveries(t *testing.T) {
	configV1 := Config{
		GroupBy: []string{"env", "service"},
		Inhibitions: []InhibitionRule{{
			Name:           "critical-hides-warning",
			SourceMatchers: []Matcher{{Name: "severity", Value: "critical"}},
			TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
			Equal:          []string{"env", "service"},
		}},
		Silences: []Silence{{
			ID:       "mute-db",
			Matchers: []Matcher{{Name: "service", Value: "db"}},
			StartsAt: testNow.Add(-time.Hour),
			EndsAt:   testNow.Add(time.Hour),
		}},
	}
	configV2 := Config{
		GroupBy: []string{"service"},
		Inhibitions: []InhibitionRule{{
			Name:           "prod-critical-hides-prod-warning",
			SourceMatchers: []Matcher{{Name: "env", Value: "prod"}, {Name: "severity", Value: "critical"}},
			TargetMatchers: []Matcher{{Name: "env", Value: "prod"}, {Name: "severity", Value: "warning"}},
			Equal:          []string{"service"},
		}},
		Silences: []Silence{{
			ID:       "mute-db",
			Matchers: []Matcher{{Name: "service", Value: "db"}},
			StartsAt: testNow.Add(-time.Hour),
			EndsAt:   testNow.Add(time.Hour),
		}},
	}

	engine := mustEngine(t, configV1)
	apiCritical := alert(testNow, "env", "prod", "service", "api", "severity", "critical")
	apiWarning := alert(testNow, "env", "prod", "service", "api", "severity", "warning")
	dbCritical := alert(testNow, "env", "prod", "service", "db", "severity", "critical")
	devWarning := alert(testNow, "env", "dev", "service", "web", "severity", "warning")
	engine.AddAlerts(apiCritical, apiWarning, dbCritical, devWarning)

	delivered := make(map[string]struct{})
	take := func(label string) []Notification {
		t.Helper()
		fresh := engine.Poll(testNow)
		for _, notification := range fresh {
			id := notification.ID()
			if _, exists := delivered[id]; exists {
				t.Fatalf("%s re-delivered notification %q", label, id)
			}
			delivered[id] = struct{}{}
		}
		return fresh
	}

	first := take("initial")
	if len(first) != 2 {
		t.Fatalf("initial Poll() returned %d notifications, want 2", len(first))
	}
	if got := take("repeated poll"); len(got) != 0 {
		t.Fatalf("repeated Poll() returned %d notifications, want 0", len(got))
	}

	if added := engine.AddAlerts(apiCritical); added != 0 {
		t.Fatalf("duplicate AddAlerts() added %d alerts, want 0", added)
	}
	if got := take("duplicate alert"); len(got) != 0 {
		t.Fatalf("duplicate alert produced %d notifications, want 0", len(got))
	}

	if err := engine.UpdateRules(configV1); err != nil {
		t.Fatalf("UpdateRules() error = %v", err)
	}
	if got := take("no-op rule update"); len(got) != 0 {
		t.Fatalf("no-op rule update produced %d notifications, want 0", len(got))
	}

	if err := engine.UpdateRules(configV2); err != nil {
		t.Fatalf("UpdateRules() error = %v", err)
	}
	changed := take("grouping update")
	if len(changed) != 2 {
		t.Fatalf("grouping update produced %d notifications, want 2", len(changed))
	}
	if err := engine.UpdateRules(configV2); err != nil {
		t.Fatalf("UpdateRules() error = %v", err)
	}
	if got := take("no-op grouping update"); len(got) != 0 {
		t.Fatalf("second no-op-transition update produced %d notifications, want 0", len(got))
	}
	if err := engine.UpdateRules(configV1); err != nil {
		t.Fatalf("UpdateRules() error = %v", err)
	}
	if got := take("return to old rules"); len(got) != 0 {
		t.Fatalf("returning to old rules produced %d duplicate notifications, want 0", len(got))
	}

	beforeInvalid := engine.Config()
	invalid := configV2.Clone()
	invalid.Silences[0].Matchers = []Matcher{{Name: "service", Type: MatchRegexp, Value: "["}}
	if err := engine.UpdateRules(invalid); err == nil {
		t.Fatal("UpdateRules() with invalid regex = nil, want an error")
	}
	if !reflect.DeepEqual(engine.Config(), beforeInvalid) {
		t.Fatal("invalid UpdateRules() changed the configuration")
	}
	if got := take("invalid rule update"); len(got) != 0 {
		t.Fatalf("invalid rule update produced %d notifications, want 0", len(got))
	}

	engine.RemoveAlerts(apiCritical.Fingerprint())
	if got := take("alert resolution"); len(got) != 1 {
		t.Fatalf("removing the inhibiting source produced %d notifications, want 1", len(got))
	}
	if got := take("after resolution"); len(got) != 0 {
		t.Fatalf("post-resolution Poll() returned %d notifications, want 0", len(got))
	}
}

func TestEngineAlertLifecycle(t *testing.T) {
	engine := mustEngine(t, Config{GroupBy: []string{"service"}})
	first := alert(testNow, "service", "api")
	second := alert(testNow, "service", "db")

	if added := engine.AddAlerts(first, second, first); added != 2 {
		t.Fatalf("AddAlerts() = %d, want 2", added)
	}
	if got := len(engine.Alerts()); got != 2 {
		t.Fatalf("Alerts() has %d entries, want 2", got)
	}

	if removed := engine.ResolveAlerts(first); removed != 1 {
		t.Fatalf("ResolveAlerts() = %d, want 1", removed)
	}
	if removed := engine.RemoveAlerts("unknown"); removed != 0 {
		t.Fatalf("RemoveAlerts(unknown) = %d, want 0", removed)
	}
	if cleared := engine.ClearAlerts(); cleared != 1 {
		t.Fatalf("ClearAlerts() = %d, want 1", cleared)
	}
	if got := engine.Notifications(testNow); len(got) != 0 {
		t.Fatalf("Notifications() after clear = %d, want 0", len(got))
	}
}

func TestConcurrentUse(t *testing.T) {
	firstConfig := Config{
		GroupBy: []string{"env", "service"},
		Inhibitions: []InhibitionRule{{
			Name:           "critical-hides-warning",
			SourceMatchers: []Matcher{{Name: "severity", Value: "critical"}},
			TargetMatchers: []Matcher{{Name: "severity", Value: "warning"}},
			Equal:          []string{"env", "service"},
		}},
	}
	secondConfig := Config{GroupBy: []string{"service"}}
	engine := mustEngine(t, firstConfig)
	alerts := []Alert{
		alert(testNow, "env", "prod", "service", "api", "severity", "critical"),
		alert(testNow, "env", "prod", "service", "api", "severity", "warning"),
		alert(testNow, "env", "dev", "service", "db", "severity", "warning"),
	}

	var wait sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			for step := 0; step < 100; step++ {
				alert := alerts[(worker+step)%len(alerts)]
				switch (worker + step) % 5 {
				case 0:
					engine.AddAlerts(alert)
				case 1:
					engine.RemoveAlerts(alert.Fingerprint())
				case 2:
					engine.Snapshot(testNow)
				case 3:
					if worker%2 == 0 {
						_ = engine.UpdateRules(firstConfig)
					} else {
						_ = engine.UpdateRules(secondConfig)
					}
				case 4:
					engine.Poll(testNow)
				}
			}
		}(worker)
	}
	wait.Wait()
}
