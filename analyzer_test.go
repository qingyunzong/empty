package hdrclient

import (
	"strings"
	"testing"
)

// newAnalyzer builds an analyzer trusting 10.0.0.0/8 and 2001:db8::/32,
// with a deny exception on 10.9.0.0/16.
func newAnalyzer(t *testing.T, unify bool) *Analyzer {
	t.Helper()
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.SetUnifyIPv4MappedIPv6(unify); err != nil {
		t.Fatal(err)
	}
	if err := tx.Trust("edge-v4", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	if err := tx.Trust("edge-v6", pfx("2001:db8::/32")); err != nil {
		t.Fatal(err)
	}
	if err := tx.Deny("dmz-untrusted", pfx("10.9.0.0/16")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)
	return NewAnalyzer(tbl.Snapshot(), "X-Forwarded-For")
}

func TestStripRightToLeft(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.7, 10.1.0.1, 10.2.0.2"}, "")
	if !res.OK() {
		t.Fatalf("unexpected rejection: %v", res.Err)
	}
	if res.Client.String() != "203.0.113.7" {
		t.Fatalf("client = %s", res.Client)
	}
	if res.Stop != StopUntrusted {
		t.Fatalf("stop = %v", res.Stop)
	}
	if len(res.Strips) != 2 {
		t.Fatalf("strips = %d", len(res.Strips))
	}
	if res.Strips[0].Hop != 0 || res.Strips[0].Address.String() != "10.2.0.2" ||
		res.Strips[0].Rule.Name != "edge-v4" {
		t.Fatalf("strip 0 wrong: %+v", res.Strips[0])
	}
	if res.Strips[1].Hop != 1 || res.Strips[1].Address.String() != "10.1.0.1" {
		t.Fatalf("strip 1 wrong: %+v", res.Strips[1])
	}
	if !strings.Contains(res.Evidence, "first untrusted") {
		t.Fatalf("evidence missing stop proof: %q", res.Evidence)
	}
}

func TestIPv6AndPorts(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"198.51.100.9:5555, [2001:db8::5]:8443"}, "10.0.0.9:443")
	if !res.OK() {
		t.Fatalf("unexpected rejection: %v", res.Err)
	}
	if res.Client.String() != "198.51.100.9" {
		t.Fatalf("client = %s", res.Client)
	}
	if len(res.Strips) != 2 || res.Strips[0].Address.String() != "10.0.0.9" ||
		res.Strips[1].Address.String() != "2001:db8::5" {
		t.Fatalf("strips wrong: %+v", res.Strips)
	}
	if res.Strips[1].Rule.Name != "edge-v6" {
		t.Fatalf("v6 hop matched wrong rule: %+v", res.Strips[1].Rule)
	}
}

func TestMalformedStopsAndReports(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.7, garbage!!, 10.0.0.1"}, "")
	if res.Err == nil {
		t.Fatal("expected rejection")
	}
	if res.Stop != StopMalformed {
		t.Fatalf("stop = %v", res.Stop)
	}
	// The trusted hop peeled before the failure must still be recorded.
	if len(res.Strips) != 1 || res.Strips[0].Address.String() != "10.0.0.1" {
		t.Fatalf("strips = %+v", res.Strips)
	}
	if !strings.Contains(res.Evidence, "never skipped") {
		t.Fatalf("evidence = %q", res.Evidence)
	}
}

func TestDuplicateHeaderRejected(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.7", "10.0.0.1"}, "")
	if res.Err == nil || res.Stop != StopDuplicateHeader {
		t.Fatalf("res = %+v", res)
	}
}

func TestEmptyChainRejected(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze(nil, "")
	if res.Err == nil || res.Stop != StopEmptyChain {
		t.Fatalf("res = %+v", res)
	}
}

func TestAllTrustedExhaustsChain(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"10.1.1.1, 10.2.2.2"}, "")
	if !res.OK() || res.Stop != StopChainExhausted {
		t.Fatalf("res = %+v", res)
	}
	if res.Client.String() != "10.1.1.1" {
		t.Fatalf("client = %s, want leftmost", res.Client)
	}
}

func TestDenyExceptionBecomesClient(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.7, 10.9.0.5, 10.0.0.1"}, "")
	if !res.OK() {
		t.Fatalf("unexpected rejection: %v", res.Err)
	}
	if res.Client.String() != "10.9.0.5" {
		t.Fatalf("client = %s, want deny-exception address", res.Client)
	}
	if !strings.Contains(res.Evidence, "dmz-untrusted") {
		t.Fatalf("evidence should name the deny rule: %q", res.Evidence)
	}
}

func TestAnalyzerBindsSnapshot(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.Trust("old-edge", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)
	a := NewAnalyzer(tbl.Snapshot(), "X-Forwarded-For")

	// Rotate the table: 10.0.0.0/8 is no longer trusted.
	tx2 := tbl.Begin()
	if err := tx2.Remove("old-edge"); err != nil {
		t.Fatal(err)
	}
	if err := tx2.Trust("new-edge", pfx("192.168.0.0/16")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx2)

	res := a.Analyze([]string{"203.0.113.7, 10.0.0.1"}, "")
	if !res.OK() || res.Client.String() != "203.0.113.7" {
		t.Fatalf("bound analyzer must still trust old rules: %+v", res)
	}
	if res.Strips[0].Rule.Name != "old-edge" {
		t.Fatalf("strip used rule %+v, want old-edge", res.Strips[0].Rule)
	}
	if !strings.Contains(res.Report(), "old-edge") {
		t.Fatalf("report missing rule evidence:\n%s", res.Report())
	}

	fresh := NewAnalyzer(tbl.Snapshot(), "X-Forwarded-For")
	res2 := fresh.Analyze([]string{"203.0.113.7, 10.0.0.1"}, "")
	if res2.Client.String() != "10.0.0.1" {
		t.Fatalf("fresh analyzer should see rotated table, client = %s", res2.Client)
	}
}

func TestReportRendersStripsAndStop(t *testing.T) {
	a := newAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.7, 10.0.0.1"}, "")
	rep := res.Report()
	for _, want := range []string{"strip hop 0", "edge-v4", "stop: untrusted-address"} {
		if !strings.Contains(rep, want) {
			t.Fatalf("report missing %q:\n%s", want, rep)
		}
	}
}
