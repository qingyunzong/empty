package formal_test

import (
	"testing"
	"time"

	"example.org/dlks/formal/q10059"
	"example.org/dlks/formal/q10059/internal/oracle"
)

// These expectations are written by hand from the specification. They are not
// produced by either the implementation or the oracle.
func TestGoldenAbsoluteFirstThenSearch(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1", "10.0.0.2"),
		SearchDomains:     []string{"corp.local", "local"},
		Ndots:             1,
		Timeout:           100 * time.Millisecond,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "svc.corp.", forwarder: "10.0.0.1"}:            {Rcode: formal.RcodeNameError, Latency: time.Millisecond},
		{name: "svc.corp.corp.local.", forwarder: "10.0.0.1"}: {Rcode: formal.RcodeNameError, Latency: time.Millisecond},
		{name: "svc.corp.local.", forwarder: "10.0.0.1"}:      {Rcode: formal.RcodeSuccess, Latency: 2 * time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "absolute first",
		config:    cfg,
		queryName: "svc.corp",
		transport: tr,
	})

	want := oracle.Observation{
		Name: "svc.corp.",
		Queries: []oracle.QueryStep{
			{Name: "svc.corp."},
			{Name: "svc.corp.corp.local."},
			{Name: "svc.corp.local."},
		},
		Attempts: []oracle.Attempt{
			{Name: "svc.corp.", Forwarder: "10.0.0.1", Outcome: "nxdomain", Rcode: formal.RcodeNameError, Latency: time.Millisecond, Waited: time.Millisecond},
			{Name: "svc.corp.corp.local.", Forwarder: "10.0.0.1", Outcome: "nxdomain", Rcode: formal.RcodeNameError, Latency: time.Millisecond, Waited: time.Millisecond},
			{Name: "svc.corp.local.", Forwarder: "10.0.0.1", Outcome: "success", Latency: 2 * time.Millisecond, Waited: 2 * time.Millisecond},
		},
		Source: oracle.Source{
			Kind:      "default",
			Name:      "svc.corp.local.",
			Forwarder: "10.0.0.1",
		},
		Elapsed: 4 * time.Millisecond,
	}
	requireDeepEqual(t, obs, want)
}

func TestGoldenSearchFirstCacheHit(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"corp.local", "local"},
		Ndots:             2,
		Timeout:           100 * time.Millisecond,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "svc.corp.corp.local.", forwarder: "10.0.0.1"}: {Rcode: formal.RcodeNameError, Latency: time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "search first cache",
		config:    cfg,
		queryName: "svc.corp",
		cache: map[string]formal.CacheEntry{
			"svc.corp.local.": {Values: []string{"10.9.8.7"}},
		},
		transport: tr,
	})

	want := oracle.Observation{
		Name: "svc.corp.",
		Queries: []oracle.QueryStep{
			{Name: "svc.corp.corp.local."},
			{Name: "svc.corp.local.", CacheHit: true},
		},
		Attempts: []oracle.Attempt{
			{Name: "svc.corp.corp.local.", Forwarder: "10.0.0.1", Outcome: "nxdomain", Rcode: formal.RcodeNameError, Latency: time.Millisecond, Waited: time.Millisecond},
		},
		Source: oracle.Source{
			Kind: "cache",
			Name: "svc.corp.local.",
		},
		Elapsed:      time.Millisecond,
		CachedValues: []string{"10.9.8.7"},
	}
	requireDeepEqual(t, obs, want)
}

func TestGoldenLongestStubAndTimeoutBoundary(t *testing.T) {
	cfg := formal.Config{
		StubDomains: map[string][]formal.Forwarder{
			"example.com":       forwarders("10.1.0.1"),
			"corp.example.com.": forwarders("10.2.0.1", "10.2.0.2"),
		},
		DefaultForwarders: forwarders("192.0.2.1"),
		Timeout:           50 * time.Millisecond,
	}
	tr := staticTransport(map[exchangeKey]formal.Reply{
		{name: "x.a.corp.example.com.", forwarder: "10.2.0.1"}: {Latency: 51 * time.Millisecond},
		{name: "x.a.corp.example.com.", forwarder: "10.2.0.2"}: {Rcode: formal.RcodeSuccess, Latency: 50 * time.Millisecond},
	}, formal.Reply{Rcode: formal.RcodeSuccess})

	_, obs := runDifferential(t, scenario{
		name:      "stub timeout",
		config:    cfg,
		queryName: "x.a.corp.example.com.",
		transport: tr,
	})

	want := oracle.Observation{
		Name: "x.a.corp.example.com.",
		Queries: []oracle.QueryStep{
			{Name: "x.a.corp.example.com."},
		},
		Attempts: []oracle.Attempt{
			{
				Name:       "x.a.corp.example.com.",
				Forwarder:  "10.2.0.1",
				StubDomain: "corp.example.com",
				Outcome:    "timeout",
				Latency:    51 * time.Millisecond,
				Waited:     50 * time.Millisecond,
			},
			{
				Name:       "x.a.corp.example.com.",
				Forwarder:  "10.2.0.2",
				StubDomain: "corp.example.com",
				Outcome:    "success",
				Latency:    50 * time.Millisecond,
				Waited:     50 * time.Millisecond,
			},
		},
		Source: oracle.Source{
			Kind:       "stub",
			Name:       "x.a.corp.example.com.",
			Forwarder:  "10.2.0.2",
			StubDomain: "corp.example.com",
		},
		Elapsed: 100 * time.Millisecond,
	}
	requireDeepEqual(t, obs, want)
}

func TestGoldenAllNXDomain(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"one.test", "two.test"},
		Ndots:             1,
		Timeout:           time.Second,
	}
	tr := staticTransport(nil, formal.Reply{Rcode: formal.RcodeNameError, Latency: time.Millisecond})

	_, obs := runDifferential(t, scenario{
		name:      "all nxdomain",
		config:    cfg,
		queryName: "host",
		transport: tr,
	})

	want := oracle.Observation{
		Name: "host.",
		Queries: []oracle.QueryStep{
			{Name: "host.one.test."},
			{Name: "host.two.test."},
			{Name: "host."},
		},
		Attempts: []oracle.Attempt{
			{Name: "host.one.test.", Forwarder: "10.0.0.1", Outcome: "nxdomain", Rcode: formal.RcodeNameError, Latency: time.Millisecond, Waited: time.Millisecond},
			{Name: "host.two.test.", Forwarder: "10.0.0.1", Outcome: "nxdomain", Rcode: formal.RcodeNameError, Latency: time.Millisecond, Waited: time.Millisecond},
			{Name: "host.", Forwarder: "10.0.0.1", Outcome: "nxdomain", Rcode: formal.RcodeNameError, Latency: time.Millisecond, Waited: time.Millisecond},
		},
		Source: oracle.Source{
			Kind:   "none",
			Name:   "host.",
			Rcode:  formal.RcodeNameError,
			Reason: "nxdomain",
		},
		Elapsed: 3 * time.Millisecond,
	}
	requireDeepEqual(t, obs, want)
}
