package formal_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"example.org/dlks/formal/q10059"
	"example.org/dlks/formal/q10059/internal/oracle"
)

func TestNDotsAdjacentValuesExhaustive(t *testing.T) {
	labels := []string{"host", "a", "b", "c", "d", "e"}
	search := []string{"one.test", "two.test"}

	for dots := 0; dots <= 4; dots++ {
		name := strings.Join(labels[:dots+1], ".")
		ndotsValues := []int{0, dots - 1, dots, dots + 1, 9}
		seen := map[int]bool{}
		for _, ndots := range ndotsValues {
			if ndots < 0 || seen[ndots] {
				continue
			}
			seen[ndots] = true

			t.Run(fmt.Sprintf("dots=%d/ndots=%d", dots, ndots), func(t *testing.T) {
				cfg := formal.Config{
					DefaultForwarders: forwarders("10.0.0.1"),
					SearchDomains:     search,
					Ndots:             ndots,
					Timeout:           time.Second,
				}
				tr := staticTransport(nil, formal.Reply{
					Rcode:   formal.RcodeNameError,
					Latency: time.Millisecond,
				})

				_, obs := runDifferential(t, scenario{
					name:      "ndots",
					config:    cfg,
					queryName: name,
					transport: tr,
				})

				absolute := name + "."
				var want []string
				if dots >= ndots {
					want = append(want, absolute)
				}
				for _, domain := range search {
					want = append(want, name+"."+domain+".")
				}
				if dots < ndots {
					want = append(want, absolute)
				}

				if len(obs.Queries) != len(want) {
					t.Fatalf("got %d queries, want %d", len(obs.Queries), len(want))
				}
				for i := range want {
					if obs.Queries[i].Name != want[i] {
						t.Fatalf("query[%d] = %q, want %q", i, obs.Queries[i].Name, want[i])
					}
				}
			})
		}
	}
}

func TestAbsoluteNameBypassesSearchList(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"one.test", "two.test"},
		Ndots:             0,
		Timeout:           time.Second,
	}
	tr := staticTransport(nil, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "absolute",
		config:    cfg,
		queryName: "Host.Example.",
		transport: tr,
	})

	if len(obs.Queries) != 1 || obs.Queries[0].Name != "host.example." {
		t.Fatalf("absolute name queried unpredictably: %#v", obs.Queries)
	}
}

func TestLongestStubSuffixWins(t *testing.T) {
	cfg := formal.Config{
		StubDomains: map[string][]formal.Forwarder{
			"example.com":     forwarders("10.0.0.1"),
			"c.example.com":   forwarders("10.0.0.3"),
			"b.c.example.com": forwarders("10.0.0.2"),
		},
		DefaultForwarders: forwarders("192.0.2.1"),
		Timeout:           time.Second,
	}
	tr := staticTransport(nil, formal.Reply{Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "longest stub",
		config:    cfg,
		queryName: "A.B.C.Example.COM.",
		transport: tr,
	})

	if len(obs.Attempts) != 1 {
		t.Fatalf("expected one attempt, got %#v", obs.Attempts)
	}
	got := obs.Attempts[0]
	if got.Forwarder != "10.0.0.2" || got.StubDomain != "b.c.example.com" {
		t.Fatalf("wrong stub route: %#v", got)
	}
	if obs.Source.Kind != "stub" || obs.Source.StubDomain != "b.c.example.com" {
		t.Fatalf("wrong source: %#v", obs.Source)
	}
}

func TestEqualLengthStubSiblingsAreNotATie(t *testing.T) {
	cfg := formal.Config{
		StubDomains: map[string][]formal.Forwarder{
			"a.example.com": forwarders("10.0.0.1"),
			"b.example.com": forwarders("10.0.0.2"),
		},
		DefaultForwarders: forwarders("192.0.2.1"),
		Timeout:           time.Second,
	}
	tr := staticTransport(nil, formal.Reply{Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "equal siblings",
		config:    cfg,
		queryName: "x.a.example.com.",
		transport: tr,
	})

	if len(obs.Attempts) != 1 || obs.Attempts[0].Forwarder != "10.0.0.1" {
		t.Fatalf("wrong sibling route: %#v", obs.Attempts)
	}
}

func TestCanonicalDuplicateStubDomainsAreTiesAndRejected(t *testing.T) {
	cases := map[string]formal.Config{
		"case": {
			StubDomains: map[string][]formal.Forwarder{
				"Example.COM.": forwarders("10.0.0.1"),
				"example.com":  forwarders("10.0.0.2"),
			},
			DefaultForwarders: forwarders("192.0.2.1"),
		},
		"trailing dot": {
			StubDomains: map[string][]formal.Forwarder{
				"corp.example.com.": forwarders("10.0.0.1"),
				"CORP.EXAMPLE.COM":  forwarders("10.0.0.2"),
			},
			DefaultForwarders: forwarders("192.0.2.1"),
		},
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			requireBothConfigErrors(t, scenario{config: cfg, queryName: "host.corp.example.com."})
		})
	}
}

func TestStubTakesPriorityOverDefault(t *testing.T) {
	cfg := formal.Config{
		StubDomains: map[string][]formal.Forwarder{
			"corp.example.com": forwarders("10.0.0.9"),
		},
		DefaultForwarders: forwarders("192.0.2.1"),
		Timeout:           time.Second,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "host.corp.example.com.", forwarder: "10.0.0.9"}:  {Latency: time.Millisecond},
		{name: "host.corp.example.com.", forwarder: "192.0.2.1"}: {Latency: time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "stub priority",
		config:    cfg,
		queryName: "host.corp.example.com.",
		transport: tr,
	})

	if len(obs.Attempts) != 1 || obs.Attempts[0].Forwarder != "10.0.0.9" {
		t.Fatalf("default forwarder was consulted for a stub name: %#v", obs.Attempts)
	}
}

func TestSearchSuffixCanSelectStubRoute(t *testing.T) {
	cfg := formal.Config{
		StubDomains: map[string][]formal.Forwarder{
			"corp.local": forwarders("10.0.0.9"),
		},
		DefaultForwarders: forwarders("192.0.2.1"),
		SearchDomains:     []string{"corp.local"},
		Ndots:             1,
		Timeout:           time.Second,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "api.corp.local.", forwarder: "10.0.0.9"}: {Rcode: formal.RcodeNameError, Latency: time.Millisecond},
		{name: "api.", forwarder: "192.0.2.1"}:           {Latency: 2 * time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "search suffix stub",
		config:    cfg,
		queryName: "api",
		transport: tr,
	})

	if len(obs.Attempts) != 2 {
		t.Fatalf("attempts: %#v", obs.Attempts)
	}
	if obs.Attempts[0].Name != "api.corp.local." ||
		obs.Attempts[0].Forwarder != "10.0.0.9" ||
		obs.Attempts[0].StubDomain != "corp.local" {
		t.Fatalf("first attempt: %#v", obs.Attempts[0])
	}
	if obs.Attempts[1].Name != "api." ||
		obs.Attempts[1].Forwarder != "192.0.2.1" ||
		obs.Attempts[1].StubDomain != "" {
		t.Fatalf("second attempt: %#v", obs.Attempts[1])
	}
	if obs.Source.Kind != "default" || obs.Source.Name != "api." {
		t.Fatalf("source: %#v", obs.Source)
	}
}

func TestStubDoesNotFallBackToDefaultAfterTimeout(t *testing.T) {
	cfg := formal.Config{
		StubDomains: map[string][]formal.Forwarder{
			"corp.example.com": forwarders("10.0.0.9"),
		},
		DefaultForwarders: forwarders("192.0.2.1"),
		Timeout:           10 * time.Millisecond,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "host.corp.example.com.", forwarder: "10.0.0.9"}:  {Latency: 11 * time.Millisecond},
		{name: "host.corp.example.com.", forwarder: "192.0.2.1"}: {Latency: time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "stub no default fallback",
		config:    cfg,
		queryName: "host.corp.example.com.",
		transport: tr,
	})

	if len(obs.Attempts) != 1 || obs.Attempts[0].Forwarder != "10.0.0.9" {
		t.Fatalf("default was tried after stub timeout: %#v", obs.Attempts)
	}
	if obs.Source.Kind != "none" || obs.Source.Reason != "timeout" {
		t.Fatalf("unexpected source: %#v", obs.Source)
	}
}

func TestSearchDomainCompletionHitsAtEveryPosition(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"corp.local", "local"},
		Ndots:             2,
		Timeout:           time.Second,
	}
	candidates := []string{
		"svc.corp.corp.local.",
		"svc.corp.local.",
		"svc.corp.",
	}

	for i, cachedName := range candidates {
		t.Run(fmt.Sprintf("hit-at-%d", i), func(t *testing.T) {
			cache := map[string]formal.CacheEntry{
				cachedName: {Values: []string{fmt.Sprintf("192.0.2.%d", i+10)}},
			}
			replies := map[exchangeKey]formal.Reply{}
			productionTransport := &recordingTransport{
				replies:  replies,
				fallback: formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond},
			}
			oracleTransport := &recordingTransport{
				replies:  replies,
				fallback: formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond},
			}

			clock := formal.NewVirtualClock(time.Unix(0, 0))
			gotResult, err := formal.Resolve(formal.Query{
				Name:      "svc.corp",
				Config:    cfg,
				Cache:     formal.MapCache(cache),
				Clock:     clock,
				Transport: productionTransport,
			})
			if err != nil {
				t.Fatal(err)
			}
			want, err := oracle.Run(oracle.Input{
				Name:      "svc.corp",
				Config:    cfg,
				Cache:     cache,
				Transport: oracleTransport,
			})
			if err != nil {
				t.Fatal(err)
			}
			requireDeepEqual(t, observe(gotResult), want)

			if len(gotResult.Queries) != i+1 {
				t.Fatalf("queries = %d, want %d", len(gotResult.Queries), i+1)
			}
			if !gotResult.Queries[i].CacheHit {
				t.Fatalf("query %d was not marked as a cache hit", i)
			}
			if len(gotResult.Attempts) != i {
				t.Fatalf("attempts = %d, want %d", len(gotResult.Attempts), i)
			}
			if len(productionTransport.calls) != i {
				t.Fatalf("transport calls = %d, want %d", len(productionTransport.calls), i)
			}
			for _, call := range productionTransport.calls {
				if call.name == cachedName {
					t.Fatalf("cache-hit name %q was forwarded", cachedName)
				}
			}
			if gotResult.Source.Kind != formal.SourceCache {
				t.Fatalf("source = %#v, want cache", gotResult.Source)
			}
		})
	}
}

func TestNegativeCacheHitDoesNotForwardThatName(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"corp.local", "local"},
		Ndots:             2,
		Timeout:           time.Second,
	}
	cache := map[string]formal.CacheEntry{
		"svc.corp.corp.local.": {Rcode: formal.RcodeNameError},
		"svc.corp.local.":      {Values: []string{"192.0.2.44"}},
	}
	tr := &recordingTransport{
		replies:  map[exchangeKey]formal.Reply{},
		fallback: formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond},
	}

	res, err := formal.Resolve(formal.Query{
		Name:      "svc.corp",
		Config:    cfg,
		Cache:     formal.MapCache(cache),
		Clock:     formal.NewVirtualClock(time.Unix(0, 0)),
		Transport: tr,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.calls) != 0 {
		t.Fatalf("negative cache hit caused forwarding: %#v", tr.calls)
	}
	if res.Source.Kind != formal.SourceCache || res.Source.Name != "svc.corp.local." {
		t.Fatalf("unexpected source: %#v", res.Source)
	}
}

func TestCacheHitNeedsNoTransport(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		Timeout:           time.Second,
	}
	res, err := formal.Resolve(formal.Query{
		Name:   "host.example.",
		Config: cfg,
		Cache: formal.MapCache{
			"HOST.EXAMPLE": {Values: []string{"192.0.2.1"}},
		},
	})
	if err != nil {
		t.Fatalf("cache hit should not require a transport: %v", err)
	}
	if res.Source.Kind != formal.SourceCache || len(res.Attempts) != 0 {
		t.Fatalf("unexpected cache result: %#v", res)
	}
}

func TestTimeoutFallbackBoundaries(t *testing.T) {
	const timeout = 100 * time.Millisecond
	tests := []struct {
		name        string
		first       formal.Forwarder
		second      formal.Forwarder
		cfgTimeout  time.Duration
		firstReply  formal.Reply
		secondReply formal.Reply
		wantOutcome []formal.AttemptOutcome
		wantElapsed time.Duration
		wantSource  formal.SourceKind
		wantReason  string
	}{
		{
			name:        "one nanosecond before boundary",
			first:       timedForwarder("10.0.0.1", 0),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  timeout,
			firstReply:  formal.Reply{Latency: timeout - time.Nanosecond},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptSuccess},
			wantElapsed: timeout - time.Nanosecond,
			wantSource:  formal.SourceDefault,
		},
		{
			name:        "exactly at boundary is accepted",
			first:       timedForwarder("10.0.0.1", 0),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  timeout,
			firstReply:  formal.Reply{Latency: timeout},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptSuccess},
			wantElapsed: timeout,
			wantSource:  formal.SourceDefault,
		},
		{
			name:        "one nanosecond after boundary falls back",
			first:       timedForwarder("10.0.0.1", 0),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  timeout,
			firstReply:  formal.Reply{Latency: timeout + time.Nanosecond},
			secondReply: formal.Reply{Latency: time.Millisecond},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptTimeout, formal.AttemptSuccess},
			wantElapsed: timeout + time.Millisecond,
			wantSource:  formal.SourceDefault,
		},
		{
			name:        "per-forwarder timeout boundary",
			first:       timedForwarder("10.0.0.1", 50*time.Millisecond),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  time.Second,
			firstReply:  formal.Reply{Latency: 50 * time.Millisecond},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptSuccess},
			wantElapsed: 50 * time.Millisecond,
			wantSource:  formal.SourceDefault,
		},
		{
			name:        "per-forwarder override times out into config timeout",
			first:       timedForwarder("10.0.0.1", 50*time.Millisecond),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  time.Second,
			firstReply:  formal.Reply{Latency: 51 * time.Millisecond},
			secondReply: formal.Reply{Latency: time.Second},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptTimeout, formal.AttemptSuccess},
			wantElapsed: 1050 * time.Millisecond,
			wantSource:  formal.SourceDefault,
		},
		{
			name:        "all forwarders time out",
			first:       timedForwarder("10.0.0.1", 0),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  timeout,
			firstReply:  formal.Reply{Latency: timeout + time.Nanosecond},
			secondReply: formal.Reply{Latency: timeout + time.Nanosecond},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptTimeout, formal.AttemptTimeout},
			wantElapsed: 200 * time.Millisecond,
			wantSource:  formal.SourceNone,
			wantReason:  "timeout",
		},
		{
			name:        "nxdomain does not try the next forwarder",
			first:       timedForwarder("10.0.0.1", 0),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  timeout,
			firstReply:  formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond},
			secondReply: formal.Reply{Latency: time.Millisecond},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptNXDomain},
			wantElapsed: time.Millisecond,
			wantSource:  formal.SourceNone,
			wantReason:  "nxdomain",
		},
		{
			name:        "transport failure falls back",
			first:       timedForwarder("10.0.0.1", 0),
			second:      timedForwarder("10.0.0.2", 0),
			cfgTimeout:  timeout,
			firstReply:  formal.Reply{Err: errors.New("connection reset"), Latency: time.Millisecond},
			secondReply: formal.Reply{Latency: time.Millisecond},
			wantOutcome: []formal.AttemptOutcome{formal.AttemptFailure, formal.AttemptSuccess},
			wantElapsed: 2 * time.Millisecond,
			wantSource:  formal.SourceDefault,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := formal.Config{
				DefaultForwarders: []formal.Forwarder{tc.first, tc.second},
				Timeout:           tc.cfgTimeout,
			}
			tr := staticTransport(map[exchangeKey]formal.Reply{
				{name: "host.example.", forwarder: tc.first.Address}:  tc.firstReply,
				{name: "host.example.", forwarder: tc.second.Address}: tc.secondReply,
			}, formal.Reply{Latency: time.Millisecond})

			res, obs := runDifferential(t, scenario{
				name:      tc.name,
				config:    cfg,
				queryName: "host.example.",
				transport: tr,
			})

			if len(res.Attempts) != len(tc.wantOutcome) {
				t.Fatalf("attempts = %d, want %d: %#v", len(res.Attempts), len(tc.wantOutcome), res.Attempts)
			}
			for i, outcome := range tc.wantOutcome {
				if res.Attempts[i].Outcome != outcome {
					t.Fatalf("attempt[%d] outcome = %s, want %s", i, res.Attempts[i].Outcome, outcome)
				}
			}
			if res.Elapsed != tc.wantElapsed {
				t.Fatalf("elapsed = %v, want %v", res.Elapsed, tc.wantElapsed)
			}
			if res.Source.Kind != tc.wantSource {
				t.Fatalf("source kind = %s, want %s", res.Source.Kind, tc.wantSource)
			}
			if tc.wantReason != "" && res.Source.Reason != tc.wantReason {
				t.Fatalf("source reason = %q, want %q", res.Source.Reason, tc.wantReason)
			}
			if obs.Elapsed != tc.wantElapsed {
				t.Fatalf("oracle elapsed = %v, want %v", obs.Elapsed, tc.wantElapsed)
			}
		})
	}
}

func TestTimeoutExhaustsCandidateThenSearchContinues(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1", "10.0.0.2"),
		SearchDomains:     []string{"s.test"},
		Ndots:             0,
		Timeout:           10 * time.Millisecond,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "host.", forwarder: "10.0.0.1"}:        {Latency: 11 * time.Millisecond},
		{name: "host.", forwarder: "10.0.0.2"}:        {Latency: 11 * time.Millisecond},
		{name: "host.s.test.", forwarder: "10.0.0.1"}: {Latency: 10 * time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	res, _ := runDifferential(t, scenario{
		name:      "candidate timeout",
		config:    cfg,
		queryName: "host",
		transport: tr,
	})

	if len(res.Queries) != 2 ||
		res.Queries[0].Name != "host." ||
		res.Queries[1].Name != "host.s.test." {
		t.Fatalf("unexpected query sequence: %#v", res.Queries)
	}
	if len(res.Attempts) != 3 {
		t.Fatalf("attempts = %#v", res.Attempts)
	}
	if res.Attempts[0].Outcome != formal.AttemptTimeout ||
		res.Attempts[1].Outcome != formal.AttemptTimeout ||
		res.Attempts[2].Outcome != formal.AttemptSuccess {
		t.Fatalf("unexpected outcomes: %#v", res.Attempts)
	}
	if res.Source.Kind != formal.SourceDefault || res.Source.Name != "host.s.test." {
		t.Fatalf("unexpected source: %#v", res.Source)
	}
	if res.Elapsed != 30*time.Millisecond {
		t.Fatalf("elapsed = %v", res.Elapsed)
	}
}

func TestInvalidConfigsReturnExplicitErrors(t *testing.T) {
	cases := []struct {
		name  string
		field string
		cfg   formal.Config
	}{
		{
			name:  "negative ndots",
			field: "ndots",
			cfg:   formal.Config{DefaultForwarders: forwarders("10.0.0.1"), Ndots: -1},
		},
		{
			name:  "negative timeout",
			field: "timeout",
			cfg:   formal.Config{DefaultForwarders: forwarders("10.0.0.1"), Timeout: -time.Second},
		},
		{
			name:  "no default forwarder",
			field: "default_forwarders",
			cfg:   formal.Config{},
		},
		{
			name:  "empty forwarder address",
			field: "default_forwarders",
			cfg:   formal.Config{DefaultForwarders: forwarders("")},
		},
		{
			name:  "whitespace forwarder address",
			field: "default_forwarders",
			cfg:   formal.Config{DefaultForwarders: forwarders(" 10.0.0.1")},
		},
		{
			name:  "duplicate default forwarder",
			field: "default_forwarders",
			cfg:   formal.Config{DefaultForwarders: forwarders("10.0.0.1", "10.0.0.1")},
		},
		{
			name:  "negative forwarder timeout",
			field: "default_forwarders",
			cfg: formal.Config{DefaultForwarders: []formal.Forwarder{
				timedForwarder("10.0.0.1", -time.Second),
			}},
		},
		{
			name:  "empty search domain",
			field: "search_domains",
			cfg:   formal.Config{DefaultForwarders: forwarders("10.0.0.1"), SearchDomains: []string{""}},
		},
		{
			name:  "root search domain",
			field: "search_domains",
			cfg:   formal.Config{DefaultForwarders: forwarders("10.0.0.1"), SearchDomains: []string{"."}},
		},
		{
			name:  "empty search label",
			field: "search_domains",
			cfg:   formal.Config{DefaultForwarders: forwarders("10.0.0.1"), SearchDomains: []string{"a..b"}},
		},
		{
			name:  "duplicate search domain",
			field: "search_domains",
			cfg: formal.Config{
				DefaultForwarders: forwarders("10.0.0.1"),
				SearchDomains:     []string{"Corp.Test.", "corp.test"},
			},
		},
		{
			name:  "invalid search character",
			field: "search_domains",
			cfg: formal.Config{
				DefaultForwarders: forwarders("10.0.0.1"),
				SearchDomains:     []string{"bad domain.test"},
			},
		},
		{
			name:  "root stub domain",
			field: "stub_domains",
			cfg: formal.Config{
				StubDomains:       map[string][]formal.Forwarder{".": forwarders("10.0.0.1")},
				DefaultForwarders: forwarders("10.0.0.2"),
			},
		},
		{
			name:  "empty stub label",
			field: "stub_domains",
			cfg: formal.Config{
				StubDomains:       map[string][]formal.Forwarder{"a..b": forwarders("10.0.0.1")},
				DefaultForwarders: forwarders("10.0.0.2"),
			},
		},
		{
			name:  "empty stub forwarder list",
			field: "stub_domains",
			cfg: formal.Config{
				StubDomains:       map[string][]formal.Forwarder{"corp.test": {}},
				DefaultForwarders: forwarders("10.0.0.2"),
			},
		},
		{
			name:  "empty stub forwarder address",
			field: "stub_domains",
			cfg: formal.Config{
				StubDomains:       map[string][]formal.Forwarder{"corp.test": forwarders("")},
				DefaultForwarders: forwarders("10.0.0.2"),
			},
		},
		{
			name:  "duplicate stub forwarder",
			field: "stub_domains",
			cfg: formal.Config{
				StubDomains:       map[string][]formal.Forwarder{"corp.test": forwarders("10.0.0.1", "10.0.0.1")},
				DefaultForwarders: forwarders("10.0.0.2"),
			},
		},
		{
			name:  "canonical duplicate stub domain",
			field: "stub_domains",
			cfg: formal.Config{
				StubDomains: map[string][]formal.Forwarder{
					"Corp.Test.": forwarders("10.0.0.1"),
					"corp.test":  forwarders("10.0.0.2"),
				},
				DefaultForwarders: forwarders("10.0.0.3"),
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := formal.Resolve(formal.Query{Name: "host.test.", Config: tc.cfg})
			if !errors.Is(err, formal.ErrInvalidConfig) {
				t.Fatalf("error = %v, want ErrInvalidConfig", err)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("error %q does not name field %q", err, tc.field)
			}

			_, oracleErr := oracle.Run(oracle.Input{Name: "host.test.", Config: tc.cfg})
			if !errors.Is(oracleErr, formal.ErrInvalidConfig) {
				t.Fatalf("oracle error = %v, want ErrInvalidConfig", oracleErr)
			}
		})
	}
}

func TestInvalidQueryNames(t *testing.T) {
	cfg := formal.Config{DefaultForwarders: forwarders("10.0.0.1")}
	for _, name := range []string{"", "a..b", ".a", " a", "a b", strings.Repeat("a", 64) + ".test"} {
		t.Run(fmt.Sprintf("%q", name), func(t *testing.T) {
			_, err := formal.Resolve(formal.Query{Name: name, Config: cfg})
			if !errors.Is(err, formal.ErrInvalidName) {
				t.Fatalf("error = %v, want ErrInvalidName", err)
			}
		})
	}
}

func TestMissingTransportIsExplicit(t *testing.T) {
	cfg := formal.Config{DefaultForwarders: forwarders("10.0.0.1")}
	_, err := formal.Resolve(formal.Query{Name: "host.test.", Config: cfg})
	if !errors.Is(err, formal.ErrNoTransport) {
		t.Fatalf("error = %v, want ErrNoTransport", err)
	}
}
