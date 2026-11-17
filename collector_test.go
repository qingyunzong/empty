package formal

import (
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

var testEpoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func boolPtr(v bool) *bool {
	return &v
}

func newTestCollector(t *testing.T, cfg Config) (*Collector, *ManualClock) {
	t.Helper()
	clock := NewManualClock(testEpoch)
	collector, err := NewCollectorWithClock(cfg, clock)
	if err != nil {
		t.Fatalf("NewCollectorWithClock: %v", err)
	}
	return collector, clock
}

func mustIngest(t *testing.T, c *Collector, f Fragment) IngestResult {
	t.Helper()
	result, err := c.Ingest(f)
	if err != nil {
		t.Fatalf("Ingest(%s): %v", f.TraceID, err)
	}
	return result
}

func decisionsByTrace(decisions []Decision) map[TraceID]Decision {
	out := make(map[TraceID]Decision, len(decisions))
	for _, decision := range decisions {
		out[decision.TraceID] = decision
	}
	return out
}

func summariesEqual(a, b TraceSummary) bool {
	if a.TraceID != b.TraceID ||
		!a.Start.Equal(b.Start) ||
		!a.End.Equal(b.End) ||
		a.Duration != b.Duration ||
		a.SpanCount != b.SpanCount ||
		a.ErrorCount != b.ErrorCount ||
		a.HasError != b.HasError {
		return false
	}
	if !reflect.DeepEqual(a.Services, b.Services) {
		return false
	}
	return reflect.DeepEqual(a.Attributes, b.Attributes)
}

func TestOutOfOrderMergeIsOrderIndependent(t *testing.T) {
	fragments := []Fragment{
		{
			TraceID: "trace-a", SpanID: "front",
			Service: "frontend",
			Start:   testEpoch, End: testEpoch.Add(100 * time.Millisecond),
			Attributes: map[string]string{"region": "us"},
		},
		{
			TraceID: "trace-a", SpanID: "checkout",
			Service: "checkout",
			Start:   testEpoch.Add(150 * time.Millisecond), End: testEpoch.Add(200 * time.Millisecond),
			Error:      true,
			Attributes: map[string]string{"tenant": "gold"},
		},
		{
			TraceID: "trace-a", SpanID: "worker",
			Service: "worker",
			Start:   testEpoch.Add(50 * time.Millisecond), End: testEpoch.Add(300 * time.Millisecond),
		},
	}
	duplicateCheckout := Fragment{
		TraceID: "trace-a", SpanID: "checkout",
		Service: "checkout",
		Start:   testEpoch.Add(150 * time.Millisecond), End: testEpoch.Add(200 * time.Millisecond),
		Error:      true,
		Attributes: map[string]string{"tenant": "gold"},
	}

	orders := [][]Fragment{
		{fragments[0], fragments[1], fragments[2], duplicateCheckout},
		{duplicateCheckout, fragments[2], fragments[1], fragments[0]},
	}

	var firstSummary TraceSummary
	for i, order := range orders {
		collector, _ := newTestCollector(t, Config{
			Timeout:        time.Second,
			MaxLateness:    2 * time.Second,
			DefaultVerdict: Keep,
		})
		for _, fragment := range order {
			mustIngest(t, collector, fragment)
		}

		stats := collector.Stats()
		if stats.Pending != 1 || stats.Spans != 3 {
			t.Fatalf("order %d: unexpected stats before decision: %+v", i, stats)
		}

		decisions := collector.Advance(time.Second)
		if len(decisions) != 1 {
			t.Fatalf("order %d: got %d decisions, want 1", i, len(decisions))
		}
		decision := decisions[0]
		if decision.Verdict != Keep {
			t.Fatalf("order %d: verdict = %s, want keep", i, decision.Verdict)
		}
		if decision.Summary.SpanCount != 3 {
			t.Fatalf("order %d: span count = %d, want 3", i, decision.Summary.SpanCount)
		}
		if decision.Summary.ErrorCount != 1 || !decision.Summary.HasError {
			t.Fatalf("order %d: errors = %d/%v, want 1/true", i, decision.Summary.ErrorCount, decision.Summary.HasError)
		}
		if got, want := decision.Summary.Duration, 300*time.Millisecond; got != want {
			t.Fatalf("order %d: duration = %s, want %s", i, got, want)
		}
		if !reflect.DeepEqual(decision.Summary.Services, []string{"checkout", "frontend", "worker"}) {
			t.Fatalf("order %d: services = %v", i, decision.Summary.Services)
		}
		if got := decision.Summary.Attributes["tenant"]; got != "gold" {
			t.Fatalf("order %d: tenant = %q, want gold", i, got)
		}
		if got := decision.Summary.Attributes["region"]; got != "us" {
			t.Fatalf("order %d: region = %q, want us", i, got)
		}

		if second := collector.Collect(); len(second) != 0 {
			t.Fatalf("order %d: duplicate decisions returned: %+v", i, second)
		}
		if i == 0 {
			firstSummary = decision.Summary
		} else if !summariesEqual(firstSummary, decision.Summary) {
			t.Fatalf("summaries depend on arrival order:\nfirst:  %+v\nsecond: %+v", firstSummary, decision.Summary)
		}
	}
}

func TestRulePriorityAndTieBreak(t *testing.T) {
	rules := []Rule{
		{
			ID: "slow-drop", Priority: 100, Verdict: Drop,
			Match: Match{MinDuration: 50 * time.Millisecond},
		},
		{
			ID: "error-keep", Priority: 10, Verdict: Keep,
			Match: Match{HasError: boolPtr(true)},
		},
		{
			ID: "gold-keep", Priority: 20, Verdict: Keep,
			Match: Match{Attributes: map[string]string{"tenant": "gold"}},
		},
	}
	policy, err := NewPolicy(Drop, rules)
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}

	tests := []struct {
		name    string
		summary TraceSummary
		verdict Verdict
		rule    string
	}{
		{
			name:    "highest priority wins",
			summary: TraceSummary{HasError: true, ErrorCount: 1, Duration: time.Second, Attributes: map[string]string{"tenant": "gold"}},
			verdict: Keep,
			rule:    "error-keep",
		},
		{
			name:    "business rule outranks latency",
			summary: TraceSummary{Duration: time.Second, Attributes: map[string]string{"tenant": "gold"}},
			verdict: Keep,
			rule:    "gold-keep",
		},
		{
			name:    "latency rule",
			summary: TraceSummary{Duration: time.Second},
			verdict: Drop,
			rule:    "slow-drop",
		},
		{
			name:    "default",
			summary: TraceSummary{Duration: time.Millisecond},
			verdict: Drop,
			rule:    "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verdict, rule := policy.Decide(test.summary)
			if verdict != test.verdict || rule != test.rule {
				t.Fatalf("Decide = (%s, %q), want (%s, %q)", verdict, rule, test.verdict, test.rule)
			}
		})
	}

	tieRules := []Rule{
		{ID: "b-drop", Priority: 5, Verdict: Drop, Match: Match{MinSpans: 1}},
		{ID: "a-keep", Priority: 5, Verdict: Keep, Match: Match{MinSpans: 1}},
	}
	for i := 0; i < 2; i++ {
		input := tieRules
		if i == 1 {
			input = []Rule{tieRules[1], tieRules[0]}
		}
		tiePolicy, err := NewPolicy(Drop, input)
		if err != nil {
			t.Fatalf("NewPolicy tie: %v", err)
		}
		verdict, rule := tiePolicy.Decide(TraceSummary{SpanCount: 1})
		if verdict != Keep || rule != "a-keep" {
			t.Fatalf("tie break = (%s, %q), want (keep, a-keep)", verdict, rule)
		}
		if got := tiePolicy.Rules()[0].ID; got != "a-keep" {
			t.Fatalf("first ordered rule = %q, want a-keep", got)
		}
	}
}

func TestCollectorAppliesRulesPerTrace(t *testing.T) {
	collector, _ := newTestCollector(t, Config{
		Timeout:        time.Second,
		MaxLateness:    time.Minute,
		DefaultVerdict: Drop,
		Rules: []Rule{
			{
				ID: "errors", Priority: 10, Verdict: Keep,
				Match: Match{HasError: boolPtr(true)},
			},
			{
				ID: "gold", Priority: 20, Verdict: Keep,
				Match: Match{Attributes: map[string]string{"tenant": "gold"}},
			},
			{
				ID: "slow", Priority: 100, Verdict: Drop,
				Match: Match{MinDuration: 100 * time.Millisecond},
			},
		},
	})

	fragments := []Fragment{
		{TraceID: "error", SpanID: "s", Start: testEpoch, End: testEpoch.Add(20 * time.Millisecond), Error: true},
		{TraceID: "gold", SpanID: "s", Start: testEpoch, End: testEpoch.Add(20 * time.Millisecond), Attributes: map[string]string{"tenant": "gold"}},
		{TraceID: "slow", SpanID: "s", Start: testEpoch, End: testEpoch.Add(200 * time.Millisecond)},
		{TraceID: "normal", SpanID: "s", Start: testEpoch, End: testEpoch.Add(20 * time.Millisecond)},
	}
	for _, fragment := range fragments {
		mustIngest(t, collector, fragment)
	}

	decisions := decisionsByTrace(collector.Advance(time.Second))
	if len(decisions) != 4 {
		t.Fatalf("got %d decisions, want 4", len(decisions))
	}
	want := map[TraceID]struct {
		verdict Verdict
		rule    string
	}{
		"error":  {Keep, "errors"},
		"gold":   {Keep, "gold"},
		"slow":   {Drop, "slow"},
		"normal": {Drop, ""},
	}
	for traceID, expected := range want {
		decision, ok := decisions[traceID]
		if !ok {
			t.Fatalf("missing decision for %s", traceID)
		}
		if decision.Verdict != expected.verdict || decision.RuleID != expected.rule {
			t.Fatalf("%s decision = (%s, %q), want (%s, %q)",
				traceID, decision.Verdict, decision.RuleID, expected.verdict, expected.rule)
		}
	}
}

func TestLateFragmentsSupplementOnlyRetainedTraces(t *testing.T) {
	collector, clock := newTestCollector(t, Config{
		Timeout:        time.Second,
		MaxLateness:    2 * time.Second,
		DefaultVerdict: Drop,
		Rules: []Rule{
			{
				ID: "slow-keep", Priority: 10, Verdict: Keep,
				Match: Match{MinDuration: 100 * time.Millisecond},
			},
		},
	})

	mustIngest(t, collector, Fragment{
		TraceID: "kept", SpanID: "root",
		Start: testEpoch, End: testEpoch.Add(200 * time.Millisecond),
	})
	mustIngest(t, collector, Fragment{
		TraceID: "dropped", SpanID: "root",
		Start: testEpoch, End: testEpoch.Add(10 * time.Millisecond),
	})

	decisions := decisionsByTrace(collector.Advance(time.Second))
	if decisions["kept"].Verdict != Keep || decisions["dropped"].Verdict != Drop {
		t.Fatalf("unexpected initial decisions: %+v", decisions)
	}

	result := mustIngest(t, collector, Fragment{
		TraceID: "kept", SpanID: "late",
		Service: "backend",
		Start:   testEpoch.Add(50 * time.Millisecond), End: testEpoch.Add(260 * time.Millisecond),
		Error:      true,
		Attributes: map[string]string{"tenant": "gold"},
	})
	if result.Status != IngestSupplemented || result.Verdict != Keep || result.AddedSpans != 1 {
		t.Fatalf("retained late result = %+v, want supplemented/keep/1", result)
	}
	kept, ok := collector.Snapshot("kept")
	if !ok {
		t.Fatal("retained trace was not found")
	}
	if kept.Verdict != Keep || kept.RuleID != "slow-keep" {
		t.Fatalf("retained verdict changed: %+v", kept)
	}
	if kept.Summary.SpanCount != 2 || kept.Summary.ErrorCount != 1 {
		t.Fatalf("late span was not merged: %+v", kept.Summary)
	}
	if got, want := kept.Summary.Duration, 260*time.Millisecond; got != want {
		t.Fatalf("late span duration = %s, want %s", got, want)
	}
	if kept.Summary.Attributes["tenant"] != "gold" || !kept.Summary.HasService("backend") {
		t.Fatalf("late business data missing: %+v", kept.Summary)
	}
	if kept.LateFragments != 1 || kept.LateSpans != 1 {
		t.Fatalf("late counters = %d/%d, want 1/1", kept.LateFragments, kept.LateSpans)
	}

	result = mustIngest(t, collector, Fragment{
		TraceID: "dropped", SpanID: "late",
		Start: testEpoch.Add(50 * time.Millisecond), End: testEpoch.Add(60 * time.Millisecond),
		Error: true,
	})
	if result.Status != IngestIgnoredDropped || result.Verdict != Drop {
		t.Fatalf("dropped late result = %+v, want ignored_dropped/drop", result)
	}
	dropped, _ := collector.Snapshot("dropped")
	if dropped.Verdict != Drop || dropped.LateIgnored != 1 || dropped.Summary.SpanCount != 1 || dropped.Summary.HasError {
		t.Fatalf("dropped trace was modified or revived: %+v", dropped)
	}
	if extra := collector.Collect(); len(extra) != 0 {
		t.Fatalf("late fragments produced decisions: %+v", extra)
	}

	// A trace never observed before its deadline cannot be created from a late
	// fragment, even while the trace's lateness window is still open.
	result = mustIngest(t, collector, Fragment{
		TraceID: "never-seen", SpanID: "s",
		Start: testEpoch, End: testEpoch.Add(10 * time.Millisecond),
	})
	if result.Status != IngestTooLate {
		t.Fatalf("unknown late trace status = %s, want too_late", result.Status)
	}
	if _, ok := collector.Snapshot("never-seen"); ok {
		t.Fatal("late fragment created a brand-new trace")
	}

	// After the lateness window everything is reclaimed and late fragments are
	// rejected without creating state. The fragment keeps the trace's original
	// start, as all fragments of one distributed trace do.
	clock.Advance(2*time.Second + time.Nanosecond)
	collector.Collect()
	if stats := collector.Stats(); stats.Tracked != 0 || stats.Spans != 0 {
		t.Fatalf("state was not reclaimed: %+v", stats)
	}
	result = mustIngest(t, collector, Fragment{
		TraceID: "kept", SpanID: "too-late",
		Start: testEpoch, End: testEpoch.Add(120 * time.Millisecond),
		Error: true,
	})
	if result.Status != IngestExpired {
		t.Fatalf("post-window status = %s, want expired", result.Status)
	}
	if stats := collector.Stats(); stats.Tracked != 0 {
		t.Fatalf("expired fragment recreated trace state: %+v", stats)
	}
}

func TestLateDataCannotOverrideRetainedVerdict(t *testing.T) {
	collector, _ := newTestCollector(t, Config{
		Timeout:        time.Second,
		MaxLateness:    2 * time.Second,
		DefaultVerdict: Drop,
		Rules: []Rule{
			{
				ID: "errors-drop", Priority: 10, Verdict: Drop,
				Match: Match{HasError: boolPtr(true)},
			},
			{
				ID: "slow-keep", Priority: 20, Verdict: Keep,
				Match: Match{MinDuration: 100 * time.Millisecond},
			},
		},
	})

	mustIngest(t, collector, Fragment{
		TraceID: "trace", SpanID: "root",
		Start: testEpoch, End: testEpoch.Add(200 * time.Millisecond),
	})
	decisions := collector.Advance(time.Second)
	if len(decisions) != 1 || decisions[0].Verdict != Keep || decisions[0].RuleID != "slow-keep" {
		t.Fatalf("initial decision = %+v", decisions)
	}

	// If late data were allowed to re-evaluate rules, the higher-priority
	// error-drop rule would now match. A retained verdict must be immutable.
	result := mustIngest(t, collector, Fragment{
		TraceID: "trace", SpanID: "late",
		Start: testEpoch.Add(50 * time.Millisecond), End: testEpoch.Add(60 * time.Millisecond),
		Error: true,
	})
	if result.Verdict != Keep {
		t.Fatalf("late error changed verdict to %s", result.Verdict)
	}
	snapshot, _ := collector.Snapshot("trace")
	if snapshot.Verdict != Keep || snapshot.RuleID != "slow-keep" || !snapshot.Summary.HasError {
		t.Fatalf("late rule re-evaluation occurred: %+v", snapshot)
	}
}

func TestIngestFinalizesExpiredTraceBeforeSupplementing(t *testing.T) {
	collector, clock := newTestCollector(t, Config{
		Timeout:        time.Second,
		MaxLateness:    time.Minute,
		DefaultVerdict: Drop,
		Rules: []Rule{
			{ID: "slow", Priority: 1, Verdict: Keep, Match: Match{MinDuration: 100 * time.Millisecond}},
		},
	})

	mustIngest(t, collector, Fragment{
		TraceID: "trace", SpanID: "root",
		Start: testEpoch, End: testEpoch.Add(200 * time.Millisecond),
	})
	// Move time without calling Collect. Ingest must still finalize the trace
	// before treating the new fragment as late.
	clock.Advance(time.Second)

	result := mustIngest(t, collector, Fragment{
		TraceID: "trace", SpanID: "late",
		Start: testEpoch.Add(50 * time.Millisecond), End: testEpoch.Add(210 * time.Millisecond),
	})
	if result.Status != IngestSupplemented || result.Verdict != Keep {
		t.Fatalf("result = %+v, want supplemented/keep", result)
	}
	if decisions := collector.Collect(); len(decisions) != 1 || decisions[0].Verdict != Keep {
		t.Fatalf("collect after lazy finalization = %+v", decisions)
	}
	if decisions := collector.Collect(); len(decisions) != 0 {
		t.Fatalf("decision was returned twice: %+v", decisions)
	}
}

func TestAttributeConflictResolutionIsOrderIndependent(t *testing.T) {
	early := Fragment{
		TraceID: "trace", SpanID: "z-early",
		Start: testEpoch, End: testEpoch.Add(10 * time.Millisecond),
		Attributes: map[string]string{"tenant": "early", "shared": "early"},
	}
	late := Fragment{
		TraceID: "trace", SpanID: "a-late",
		Start: testEpoch.Add(100 * time.Millisecond), End: testEpoch.Add(110 * time.Millisecond),
		Attributes: map[string]string{"tenant": "late", "shared": "late"},
	}
	tieA := Fragment{
		TraceID: "tie", SpanID: "b", Start: testEpoch, End: testEpoch.Add(10 * time.Millisecond),
		Attributes: map[string]string{"tenant": "b"},
	}
	tieB := Fragment{
		TraceID: "tie", SpanID: "a", Start: testEpoch, End: testEpoch.Add(10 * time.Millisecond),
		Attributes: map[string]string{"tenant": "a"},
	}

	orders := [][]Fragment{
		{early, late, tieA, tieB},
		{late, early, tieB, tieA},
	}
	got := make(map[TraceID]TraceSummary)
	for _, order := range orders {
		collector, _ := newTestCollector(t, Config{
			Timeout: time.Second, MaxLateness: time.Minute, DefaultVerdict: Keep,
		})
		for _, fragment := range order {
			mustIngest(t, collector, fragment)
		}
		for _, decision := range collector.Advance(time.Second) {
			previous, exists := got[decision.TraceID]
			if exists && !summariesEqual(previous, decision.Summary) {
				t.Fatalf("%s summary depends on arrival order:\n%+v\n%+v", decision.TraceID, previous, decision.Summary)
			}
			got[decision.TraceID] = decision.Summary
		}
	}
	if len(got) != 2 {
		t.Fatalf("got %d summaries, want 2", len(got))
	}
	if got["trace"].Attributes["tenant"] != "early" || got["trace"].Attributes["shared"] != "early" {
		t.Fatalf("trace attributes = %v, want earliest span values", got["trace"].Attributes)
	}
	if got["tie"].Attributes["tenant"] != "a" {
		t.Fatalf("tie break attribute = %v, want a", got["tie"].Attributes)
	}
}

func TestMemoryReclamation(t *testing.T) {
	for _, verdict := range []Verdict{Keep, Drop} {
		t.Run(verdict.String(), func(t *testing.T) {
			collector, _ := newTestCollector(t, Config{
				Timeout: time.Second, MaxLateness: 2 * time.Second, DefaultVerdict: verdict,
			})
			const traces = 50
			for trace := 0; trace < traces; trace++ {
				id := TraceID("trace-" + string(rune('a'+trace%26)) + "-" + itoa(trace))
				for span := 0; span < 2; span++ {
					mustIngest(t, collector, Fragment{
						TraceID: id,
						SpanID:  "span-" + itoa(span),
						Start:   testEpoch,
						End:     testEpoch.Add(time.Duration(span+1) * time.Millisecond),
					})
				}
			}
			if stats := collector.Stats(); stats.Pending != traces || stats.Spans != 2*traces {
				t.Fatalf("pending stats = %+v", stats)
			}

			decisions := collector.Advance(time.Second)
			if len(decisions) != traces {
				t.Fatalf("got %d decisions, want %d", len(decisions), traces)
			}
			seen := make(map[TraceID]struct{}, traces)
			for _, decision := range decisions {
				if _, ok := seen[decision.TraceID]; ok {
					t.Fatalf("duplicate decision for %s", decision.TraceID)
				}
				seen[decision.TraceID] = struct{}{}
			}
			if second := collector.Collect(); len(second) != 0 {
				t.Fatalf("decisions returned twice: %d", len(second))
			}

			stats := collector.Stats()
			if stats.Tracked != traces {
				t.Fatalf("tracked after decision = %d, want %d", stats.Tracked, traces)
			}
			if verdict == Keep && stats.Spans != 2*traces {
				t.Fatalf("retained spans = %d, want %d", stats.Spans, 2*traces)
			}
			if verdict == Drop && stats.Spans != 0 {
				t.Fatalf("dropped spans = %d, want 0", stats.Spans)
			}

			collector.Advance(2*time.Second + time.Nanosecond)
			if stats := collector.Stats(); stats.Tracked != 0 || stats.Spans != 0 {
				t.Fatalf("state not reclaimed: %+v", stats)
			}
		})
	}
}

func TestConcurrentIngest(t *testing.T) {
	collector, _ := newTestCollector(t, Config{
		Timeout: time.Second, MaxLateness: time.Minute, DefaultVerdict: Keep,
	})
	const (
		traces     = 10
		perTrace   = 50
		goroutines = 8
	)

	var wg sync.WaitGroup
	for worker := 0; worker < goroutines; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := worker; i < traces*perTrace; i += goroutines {
				traceID := TraceID("trace-" + itoa(i%traces))
				fragment := Fragment{
					TraceID: traceID,
					SpanID:  "span-" + itoa(i/traces),
					Start:   testEpoch,
					End:     testEpoch.Add(time.Duration(i%perTrace+1) * time.Millisecond),
					Error:   true,
				}
				if _, err := collector.Ingest(fragment); err != nil {
					t.Errorf("Ingest: %v", err)
					return
				}
			}
		}(worker)
	}
	wg.Wait()

	stats := collector.Stats()
	if stats.Pending != traces || stats.Spans != traces*perTrace {
		t.Fatalf("stats = %+v, want %d pending and %d spans", stats, traces, traces*perTrace)
	}
	decisions := collector.Advance(time.Second)
	if len(decisions) != traces {
		t.Fatalf("got %d decisions, want %d", len(decisions), traces)
	}
	for _, decision := range decisions {
		if decision.Summary.SpanCount != perTrace || decision.Summary.ErrorCount != perTrace {
			t.Fatalf("trace %s summary = %+v", decision.TraceID, decision.Summary)
		}
	}
}

func TestConfigValidation(t *testing.T) {
	valid := Config{Timeout: time.Second, MaxLateness: time.Second, DefaultVerdict: Drop}
	tests := []struct {
		name string
		cfg  Config
	}{
		{name: "zero timeout", cfg: Config{DefaultVerdict: Drop}},
		{name: "negative lateness", cfg: Config{Timeout: time.Second, MaxLateness: -time.Second, DefaultVerdict: Drop}},
		{name: "undecided default", cfg: Config{Timeout: time.Second}},
		{
			name: "duplicate rule ids",
			cfg: Config{
				Timeout: time.Second, DefaultVerdict: Drop,
				Rules: []Rule{
					{ID: "same", Verdict: Keep},
					{ID: "same", Verdict: Drop},
				},
			},
		},
		{
			name: "negative priority",
			cfg: Config{
				Timeout: time.Second, DefaultVerdict: Drop,
				Rules: []Rule{{ID: "bad", Priority: -1, Verdict: Keep}},
			},
		},
		{
			name: "invalid rule verdict",
			cfg: Config{
				Timeout: time.Second, DefaultVerdict: Drop,
				Rules: []Rule{{ID: "bad", Verdict: Undecided}},
			},
		},
		{
			name: "empty duration range",
			cfg: Config{
				Timeout: time.Second, DefaultVerdict: Drop,
				Rules: []Rule{{
					ID: "bad", Verdict: Keep,
					Match: Match{MinDuration: time.Second, MaxDuration: time.Millisecond},
				}},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewCollectorWithClock(test.cfg, NewManualClock(testEpoch)); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("error = %v, want ErrInvalidConfig", err)
			}
		})
	}
	if _, err := NewCollectorWithClock(valid, nil); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil clock error = %v, want ErrInvalidConfig", err)
	}
}

func TestInvalidFragments(t *testing.T) {
	collector, _ := newTestCollector(t, Config{
		Timeout: time.Second, MaxLateness: time.Second, DefaultVerdict: Drop,
	})
	tests := []Fragment{
		{SpanID: "s", Start: testEpoch},
		{TraceID: "t", Start: testEpoch},
		{TraceID: "t", SpanID: "s", Start: testEpoch.Add(time.Second), End: testEpoch},
		{TraceID: "t", SpanID: "s", Duration: -time.Second},
	}
	for _, fragment := range tests {
		if _, err := collector.Ingest(fragment); !errors.Is(err, ErrInvalidFragment) {
			t.Fatalf("Ingest(%+v) error = %v, want ErrInvalidFragment", fragment, err)
		}
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
