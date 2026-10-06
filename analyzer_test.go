package hdrclient

import (
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func newAnalyzer(t *testing.T, unify bool, prefixes ...string) *Analyzer {
	t.Helper()
	tab := NewTable(unify)
	tx := tab.Begin()
	for _, p := range prefixes {
		tx.Trust(mustPrefix(t, p, unify))
	}
	mustCommit(t, tx)
	return NewAnalyzer(tab.Snapshot(), "X-Forwarded-For")
}

func header(vals ...string) http.Header {
	h := http.Header{}
	for _, v := range vals {
		h.Add("X-Forwarded-For", v)
	}
	return h
}

// A client forges leading entries; the proxies append the real addresses.
// Only the first untrusted address from the right may be attributed.
func TestForgedChainAttribution(t *testing.T) {
	an := newAnalyzer(t, false, "10.0.0.0/8", "2001:db8::/32")
	res, err := an.Analyze(header("6.6.6.6, 7.7.7.7, 203.0.113.9, 10.1.1.1, 10.2.2.2"))
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if !res.ClientValid || res.Client.Addr != netip.MustParseAddr("203.0.113.9") {
		t.Fatalf("Client = %v, want 203.0.113.9", res.Client)
	}
	if res.Stop.Reason != StopFirstUntrusted || res.Stop.Index != 2 {
		t.Fatalf("Stop = %v, want first-untrusted at index 2", res.Stop)
	}
	// Exactly three elements evaluated; forged entries never consulted.
	if len(res.Steps) != 3 {
		t.Fatalf("len(Steps) = %d, want 3: %v", len(res.Steps), res.Steps)
	}
	for i, want := range []struct {
		idx     int
		raw     string
		trusted bool
	}{
		{4, "10.2.2.2", true},
		{3, "10.1.1.1", true},
		{2, "203.0.113.9", false},
	} {
		step := res.Steps[i]
		if step.Index != want.idx || step.Raw != want.raw || step.Rule.Trusted() != want.trusted {
			t.Errorf("Steps[%d] = %v, want idx=%d raw=%q trusted=%v", i, step, want.idx, want.raw, want.trusted)
		}
	}
	// The stop rule must show the concrete evidence: no table entry matched.
	if res.Stop.Rule.Matched {
		t.Errorf("Stop.Rule = %s, want no-match", res.Stop.Rule)
	}
	if res.Steps[0].Rule.Prefix != netip.MustParsePrefix("10.0.0.0/8") {
		t.Errorf("Steps[0].Rule = %s, want trust 10.0.0.0/8", res.Steps[0].Rule)
	}
}

// An invalid element stops analysis immediately; it must not be skipped to
// reach the (attacker-controlled) entries to its left.
func TestInvalidAddressStopsAndIsNotSkipped(t *testing.T) {
	an := newAnalyzer(t, false, "10.0.0.0/8")
	res, err := an.Analyze(header("203.0.113.9, garbage, 10.1.1.1"))
	if err == nil {
		t.Fatal("want error for invalid element")
	}
	if res == nil || res.ClientValid {
		t.Fatalf("ClientValid = %v, want false", res.ClientValid)
	}
	if res.Stop.Reason != StopInvalidAddress || res.Stop.Index != 1 || res.Stop.Raw != "garbage" {
		t.Fatalf("Stop = %v, want invalid-address at index 1", res.Stop)
	}
	if res.Stop.Err == nil {
		t.Error("Stop.Err must carry the parse failure")
	}
	// Only the rightmost proxy was stripped before the stop.
	if len(res.Steps) != 1 || res.Steps[0].Raw != "10.1.1.1" {
		t.Fatalf("Steps = %v, want single strip of 10.1.1.1", res.Steps)
	}
}

func TestDuplicateHeaderRejected(t *testing.T) {
	an := newAnalyzer(t, false, "10.0.0.0/8")
	_, err := an.Analyze(header("1.1.1.1", "2.2.2.2"))
	if !errors.Is(err, ErrDuplicateHeader) {
		t.Fatalf("err = %v, want ErrDuplicateHeader", err)
	}
}

func TestMissingHeader(t *testing.T) {
	an := newAnalyzer(t, false, "10.0.0.0/8")
	if _, err := an.Analyze(http.Header{}); !errors.Is(err, ErrNoHeader) {
		t.Fatalf("err = %v, want ErrNoHeader", err)
	}
}

func TestChainExhaustedAttributesLeftmost(t *testing.T) {
	an := newAnalyzer(t, false, "10.0.0.0/8")
	res, err := an.Analyze(header("10.1.1.1, 10.2.2.2"))
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Stop.Reason != StopChainExhausted {
		t.Fatalf("Stop = %v, want chain-exhausted", res.Stop)
	}
	if res.Client.Addr != netip.MustParseAddr("10.1.1.1") {
		t.Fatalf("Client = %v, want leftmost 10.1.1.1", res.Client)
	}
}

// A longest-match Deny exception inside a trusted range rejects the proxy,
// so it becomes the attributed client with the deny rule as evidence.
func TestExceptionRejectsProxy(t *testing.T) {
	tab := NewTable(false)
	mustCommit(t, tab.Begin().
		Trust(mustPrefix(t, "10.0.0.0/8", false)).
		Deny(mustPrefix(t, "10.9.0.0/16", false)))
	an := NewAnalyzer(tab.Snapshot(), "X-Forwarded-For")

	res, err := an.Analyze(header("10.9.1.5, 10.0.0.6"))
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Client.Addr != netip.MustParseAddr("10.9.1.5") {
		t.Fatalf("Client = %v, want 10.9.1.5", res.Client)
	}
	if res.Stop.Rule.Decision != Deny || res.Stop.Rule.Prefix != netip.MustParsePrefix("10.9.0.0/16") {
		t.Fatalf("Stop.Rule = %s, want deny 10.9.0.0/16", res.Stop.Rule)
	}
}

func TestPortsAndIPv6(t *testing.T) {
	an := newAnalyzer(t, false, "2001:db8::/32", "10.0.0.0/8")
	res, err := an.Analyze(header("2606:4700::1, [2001:db8::2]:443, 10.0.0.1:8080"))
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Client.Addr != netip.MustParseAddr("2606:4700::1") || res.Client.HasPort {
		t.Fatalf("Client = %v, want 2606:4700::1 without port", res.Client)
	}
	if !res.Steps[1].Addr.HasPort || res.Steps[1].Addr.Port != 443 {
		t.Errorf("Steps[1].Addr = %v, want [2001:db8::2]:443", res.Steps[1].Addr)
	}
	if !res.Steps[0].Addr.HasPort || res.Steps[0].Addr.Port != 8080 {
		t.Errorf("Steps[0].Addr = %v, want 10.0.0.1:8080", res.Steps[0].Addr)
	}
}

// With unification on, ::ffff:10.1.2.3 shares the identity of 10.1.2.3 and
// matches the trusted IPv4 range; with it off, it does not.
func TestUnifyIPv4MappedSwitch(t *testing.T) {
	on := newAnalyzer(t, true, "10.0.0.0/8")
	res, err := on.Analyze(header("::ffff:10.1.2.3, 10.0.0.9"))
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Stop.Reason != StopChainExhausted {
		t.Fatalf("unify on: Stop = %v, want chain-exhausted", res.Stop)
	}
	if res.Client.Addr != netip.MustParseAddr("10.1.2.3") {
		t.Fatalf("unify on: Client = %v, want unified 10.1.2.3", res.Client)
	}

	off := newAnalyzer(t, false, "10.0.0.0/8")
	res, err = off.Analyze(header("::ffff:10.1.2.3, 10.0.0.9"))
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Stop.Reason != StopFirstUntrusted {
		t.Fatalf("unify off: Stop = %v, want first-untrusted", res.Stop)
	}
	if res.Client.Addr != netip.MustParseAddr("::ffff:10.1.2.3") {
		t.Fatalf("unify off: Client = %v, want ::ffff:10.1.2.3", res.Client)
	}
}

// An analyzer bound to a snapshot is unaffected by later table updates.
func TestAnalyzerBindsSnapshot(t *testing.T) {
	tab := NewTable(false)
	mustCommit(t, tab.Begin().Trust(mustPrefix(t, "10.0.0.0/8", false)))
	an := NewAnalyzer(tab.Snapshot(), "X-Forwarded-For")

	// Later update: 203.0.113.0/24 becomes trusted too.
	mustCommit(t, tab.Begin().Trust(mustPrefix(t, "203.0.113.0/24", false)))

	h := header("203.0.113.9, 10.1.1.1")
	res, err := an.Analyze(h)
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Client.Addr != netip.MustParseAddr("203.0.113.9") {
		t.Fatalf("old snapshot: Client = %v, want 203.0.113.9", res.Client)
	}

	res, err = NewAnalyzer(tab.Snapshot(), "X-Forwarded-For").Analyze(h)
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if res.Stop.Reason != StopChainExhausted || res.Client.Addr != netip.MustParseAddr("203.0.113.9") {
		t.Fatalf("new snapshot: Stop = %v Client = %v, want exhausted at 203.0.113.9", res.Stop, res.Client)
	}
}

func TestEvidenceStrings(t *testing.T) {
	an := newAnalyzer(t, false, "10.0.0.0/8")
	res, err := an.Analyze(header("bad-token, 10.1.1.1"))
	if err == nil {
		t.Fatal("want error")
	}
	if !strings.Contains(res.Stop.String(), "invalid-address") {
		t.Errorf("Stop.String() = %q", res.Stop)
	}
	if !strings.Contains(res.Steps[0].String(), "trust 10.0.0.0/8") {
		t.Errorf("Steps[0].String() = %q", res.Steps[0])
	}
}
