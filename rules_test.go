package formal

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestMatchConstraints(t *testing.T) {
	summary := TraceSummary{
		Duration:   500 * time.Millisecond,
		SpanCount:  3,
		ErrorCount: 2,
		HasError:   true,
		Services:   []string{"checkout", "frontend"},
		Attributes: map[string]string{"tenant": "gold", "region": "us"},
	}
	tests := []struct {
		name  string
		match Match
		want  bool
	}{
		{name: "zero match", match: Match{}, want: true},
		{name: "has error", match: Match{HasError: boolPtr(true)}, want: true},
		{name: "no error", match: Match{HasError: boolPtr(false)}, want: false},
		{name: "min duration", match: Match{MinDuration: 400 * time.Millisecond}, want: true},
		{name: "below min duration", match: Match{MinDuration: 600 * time.Millisecond}, want: false},
		{name: "max duration", match: Match{MaxDuration: 600 * time.Millisecond}, want: true},
		{name: "above max duration", match: Match{MaxDuration: 400 * time.Millisecond}, want: false},
		{name: "min errors", match: Match{MinErrors: 2}, want: true},
		{name: "insufficient errors", match: Match{MinErrors: 3}, want: false},
		{name: "min spans", match: Match{MinSpans: 3}, want: true},
		{name: "insufficient spans", match: Match{MinSpans: 4}, want: false},
		{name: "service", match: Match{Service: "checkout"}, want: true},
		{name: "missing service", match: Match{Service: "payments"}, want: false},
		{name: "any services", match: Match{AnyServices: []string{"payments", "checkout"}}, want: true},
		{name: "no any service", match: Match{AnyServices: []string{"payments", "search"}}, want: false},
		{name: "all services", match: Match{AllServices: []string{"checkout", "frontend"}}, want: true},
		{name: "missing all service", match: Match{AllServices: []string{"checkout", "payments"}}, want: false},
		{
			name: "attributes",
			match: Match{Attributes: map[string]string{
				"tenant": "gold",
				"region": "us",
			}},
			want: true,
		},
		{
			name:  "attribute mismatch",
			match: Match{Attributes: map[string]string{"tenant": "silver"}},
			want:  false,
		},
		{
			name: "combined",
			match: Match{
				HasError:    boolPtr(true),
				MinDuration: 100 * time.Millisecond,
				MinSpans:    2,
				Service:     "checkout",
				Attributes:  map[string]string{"tenant": "gold"},
			},
			want: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.match.Matches(summary); got != test.want {
				t.Fatalf("Matches = %v, want %v", got, test.want)
			}
		})
	}
}

func TestRulePredicateAndPolicyHelpers(t *testing.T) {
	predicateCalled := false
	policy, err := NewPolicy(Keep, []Rule{
		{
			ID: "predicate", Priority: 1, Verdict: Drop,
			Predicate: func(summary TraceSummary) bool {
				predicateCalled = true
				return summary.SpanCount == 2
			},
		},
	})
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	if policy.DefaultVerdict() != Keep {
		t.Fatalf("DefaultVerdict = %s", policy.DefaultVerdict())
	}
	if verdict, rule := policy.Decide(TraceSummary{SpanCount: 1}); verdict != Keep || rule != "" {
		t.Fatalf("predicate false decision = (%s, %q)", verdict, rule)
	}
	if !predicateCalled {
		t.Fatal("predicate was not evaluated")
	}
	if verdict, rule := policy.Decide(TraceSummary{SpanCount: 2}); verdict != Drop || rule != "predicate" {
		t.Fatalf("predicate true decision = (%s, %q)", verdict, rule)
	}

	rules := policy.Rules()
	rules[0].ID = "mutated"
	if policy.Rules()[0].ID != "predicate" {
		t.Fatal("Rules returned internal state")
	}

	attrs := map[string]string{"tenant": "gold"}
	hasError := true
	original, err := NewPolicy(Drop, []Rule{{
		ID: "guarded", Verdict: Keep,
		Match: Match{
			HasError:    &hasError,
			Attributes:  attrs,
			AnyServices: []string{"checkout"},
		},
	}})
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	attrs["tenant"] = "silver"
	hasError = false
	copied := original.Rules()
	copied[0].Match.Attributes["tenant"] = "bronze"
	copied[0].Match.AnyServices[0] = "payments"
	*copied[0].Match.HasError = false
	got := original.Rules()[0]
	if got.Match.Attributes["tenant"] != "gold" ||
		got.Match.AnyServices[0] != "checkout" ||
		!*got.Match.HasError {
		t.Fatalf("policy config was mutated through caller data: %+v", got)
	}
}

func TestIngestBatch(t *testing.T) {
	collector, _ := newTestCollector(t, Config{
		Timeout: time.Second, MaxLateness: time.Minute, DefaultVerdict: Keep,
	})
	results, err := collector.IngestBatch([]Fragment{
		{TraceID: "one", SpanID: "a", Start: testEpoch, End: testEpoch.Add(time.Millisecond)},
		{TraceID: "one", SpanID: "b", Start: testEpoch, End: testEpoch.Add(2 * time.Millisecond)},
	})
	if err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	if len(results) != 2 || results[0].Status != IngestNew || results[1].Status != IngestMerged {
		t.Fatalf("results = %+v", results)
	}

	results, err = collector.IngestBatch([]Fragment{
		{TraceID: "two", SpanID: "a", Start: testEpoch, End: testEpoch.Add(time.Millisecond)},
		{TraceID: "", SpanID: "bad"},
		{TraceID: "three", SpanID: "a", Start: testEpoch},
	})
	if !errors.Is(err, ErrInvalidFragment) {
		t.Fatalf("error = %v, want ErrInvalidFragment", err)
	}
	if len(results) != 1 {
		t.Fatalf("partial results = %+v, want one successful ingest", results)
	}
	if _, ok := collector.Snapshot("three"); ok {
		t.Fatal("batch continued after a malformed fragment")
	}
}

func TestSingleAdvancePastDeadlineAndExpiry(t *testing.T) {
	collector, _ := newTestCollector(t, Config{
		Timeout: time.Second, MaxLateness: 2 * time.Second, DefaultVerdict: Keep,
	})
	mustIngest(t, collector, Fragment{
		TraceID: "trace", SpanID: "a",
		Start: testEpoch, End: testEpoch.Add(10 * time.Millisecond),
	})
	decisions := collector.Advance(3*time.Second + time.Nanosecond)
	if len(decisions) != 1 || decisions[0].Verdict != Keep {
		t.Fatalf("decisions = %+v", decisions)
	}
	if stats := collector.Stats(); stats.Tracked != 0 {
		t.Fatalf("state survived a jump past expiry: %+v", stats)
	}
}

func TestClockAndVerdictHelpers(t *testing.T) {
	if (RealClock{}).Now().IsZero() {
		t.Fatal("RealClock returned zero time")
	}
	clock := NewManualClock(testEpoch)
	if got := clock.Now(); !got.Equal(testEpoch) {
		t.Fatalf("Now = %s, want %s", got, testEpoch)
	}
	if got := clock.Advance(time.Second); !got.Equal(testEpoch.Add(time.Second)) {
		t.Fatalf("Advance = %s", got)
	}
	clock.Set(testEpoch.Add(-time.Hour))
	if got := clock.Now(); !got.Equal(testEpoch.Add(-time.Hour)) {
		t.Fatalf("Now after Set = %s", got)
	}

	for _, test := range []struct {
		verdict Verdict
		name    string
		valid   bool
	}{
		{Undecided, "undecided", false},
		{Keep, "keep", true},
		{Drop, "drop", true},
		{Verdict(99), "invalid", false},
	} {
		if got := test.verdict.String(); got != test.name {
			t.Fatalf("Verdict(%d).String() = %q, want %q", test.verdict, got, test.name)
		}
		if got := test.verdict.Valid(); got != test.valid {
			t.Fatalf("Verdict(%d).Valid() = %v, want %v", test.verdict, got, test.valid)
		}
	}
}

func TestSummaryHelpers(t *testing.T) {
	summary := TraceSummary{
		Services:   []string{"a", "b"},
		Attributes: map[string]string{"tenant": "gold"},
	}
	if value, ok := summary.Attribute("tenant"); !ok || value != "gold" {
		t.Fatalf("Attribute = (%q, %v)", value, ok)
	}
	if _, ok := summary.Attribute("missing"); ok {
		t.Fatal("Attribute reported a missing key")
	}
	if !summary.HasService("b") || summary.HasService("c") {
		t.Fatal("HasService returned the wrong result")
	}

	clone := summary.clone()
	clone.Services[0] = "mutated"
	clone.Attributes["tenant"] = "mutated"
	if !reflect.DeepEqual(summary.Services, []string{"a", "b"}) || summary.Attributes["tenant"] != "gold" {
		t.Fatal("clone shares mutable state with the original summary")
	}
}
