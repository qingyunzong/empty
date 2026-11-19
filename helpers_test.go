package formal_test

import (
	"reflect"
	"testing"
	"time"

	"example.org/dlks/formal/q10059"
	"example.org/dlks/formal/q10059/internal/oracle"
)

type exchangeKey struct {
	name      string
	forwarder string
}

type transportFunc func(name, forwarder string) formal.Reply

func (f transportFunc) Exchange(name, forwarder string) formal.Reply {
	return f(name, forwarder)
}

type recordingTransport struct {
	replies  map[exchangeKey]formal.Reply
	fallback formal.Reply
	calls    []exchangeKey
}

func (t *recordingTransport) Exchange(name, forwarder string) formal.Reply {
	key := exchangeKey{name: name, forwarder: forwarder}
	t.calls = append(t.calls, key)
	if reply, ok := t.replies[key]; ok {
		return reply
	}
	return t.fallback
}

func staticTransport(replies map[exchangeKey]formal.Reply, fallback formal.Reply) transportFunc {
	return func(name, forwarder string) formal.Reply {
		if reply, ok := replies[exchangeKey{name: name, forwarder: forwarder}]; ok {
			return reply
		}
		return fallback
	}
}

func forwarders(addrs ...string) []formal.Forwarder {
	out := make([]formal.Forwarder, len(addrs))
	for i, addr := range addrs {
		out[i] = formal.Forwarder{Address: addr}
	}
	return out
}

func timedForwarder(addr string, timeout time.Duration) formal.Forwarder {
	return formal.Forwarder{Address: addr, Timeout: timeout}
}

type scenario struct {
	name      string
	config    formal.Config
	queryName string
	cache     map[string]formal.CacheEntry
	transport formal.Transport
}

func observe(r *formal.Result) oracle.Observation {
	obs := oracle.Observation{
		Name:    r.Name,
		Elapsed: r.Elapsed,
	}
	for _, step := range r.Queries {
		obs.Queries = append(obs.Queries, oracle.QueryStep{
			Name:     step.Name,
			CacheHit: step.CacheHit,
		})
	}
	for _, attempt := range r.Attempts {
		obs.Attempts = append(obs.Attempts, oracle.Attempt{
			Name:       attempt.Name,
			Forwarder:  attempt.Forwarder,
			StubDomain: attempt.StubDomain,
			Outcome:    string(attempt.Outcome),
			Rcode:      attempt.Rcode,
			Latency:    attempt.Latency,
			Waited:     attempt.Waited,
			Err:        attempt.Err,
		})
	}
	obs.Source = oracle.Source{
		Kind:       string(r.Source.Kind),
		Name:       r.Source.Name,
		Forwarder:  r.Source.Forwarder,
		StubDomain: r.Source.StubDomain,
		Rcode:      r.Source.Rcode,
		Reason:     r.Source.Reason,
	}
	if r.Entry != nil {
		obs.CachedValues = append([]string(nil), r.Entry.Values...)
	}
	return obs
}

// runDifferential executes a scenario through both the package under test and
// the independent oracle, compares the complete traces, and verifies that the
// virtual clock advanced by exactly the reported elapsed time.
func runDifferential(t *testing.T, sc scenario) (formal.Result, oracle.Observation) {
	t.Helper()

	start := time.Unix(1_700_000_000, 0).UTC()
	clock := formal.NewVirtualClock(start)
	q := formal.Query{
		Name:      sc.queryName,
		Config:    sc.config,
		Clock:     clock,
		Transport: sc.transport,
	}
	if sc.cache != nil {
		q.Cache = formal.MapCache(sc.cache)
	}

	gotResult, err := formal.Resolve(q)
	if err != nil {
		t.Fatalf("package Resolve() error = %v", err)
	}
	want, err := oracle.Run(oracle.Input{
		Name:      sc.queryName,
		Config:    sc.config,
		Cache:     sc.cache,
		Transport: sc.transport,
	})
	if err != nil {
		t.Fatalf("oracle Run() error = %v", err)
	}

	got := observe(gotResult)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("trace mismatch\n got: %#v\nwant: %#v", got, want)
	}
	if advanced := clock.Now().Sub(start); advanced != gotResult.Elapsed {
		t.Fatalf("clock advanced %v, result elapsed %v", advanced, gotResult.Elapsed)
	}
	return *gotResult, want
}

func requireBothConfigErrors(t *testing.T, sc scenario) {
	t.Helper()

	_, gotErr := formal.Resolve(formal.Query{
		Name:   sc.queryName,
		Config: sc.config,
	})
	if gotErr == nil {
		t.Fatalf("package accepted invalid config")
	}
	_, wantErr := oracle.Run(oracle.Input{
		Name:   sc.queryName,
		Config: sc.config,
	})
	if wantErr == nil {
		t.Fatalf("oracle accepted invalid config")
	}
}

func requireDeepEqual(t *testing.T, got, want oracle.Observation) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("observation mismatch\n got: %#v\nwant: %#v", got, want)
	}
}
