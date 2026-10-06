package hdrclient

import "testing"

// Forged-chain scenarios: the leftmost X-Forwarded-For entries are
// attacker-controlled. Attribution must anchor on the first untrusted
// address from the right, never on spoofed entries.

func forgedAnalyzer(t *testing.T, unify bool) *Analyzer {
	t.Helper()
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.SetUnifyIPv4MappedIPv6(unify); err != nil {
		t.Fatal(err)
	}
	if err := tx.Trust("proxy", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)
	return NewAnalyzer(tbl.Snapshot(), "X-Forwarded-For")
}

// Attacker prepends fake victim addresses; the real client is the first
// untrusted hop from the right and spoofed entries are never consulted.
func TestForgedLeftEntriesIgnored(t *testing.T) {
	a := forgedAnalyzer(t, false)
	res := a.Analyze([]string{"9.9.9.9, 8.8.8.8, 203.0.113.50, 10.0.0.1"}, "10.0.0.2")
	if !res.OK() {
		t.Fatalf("unexpected rejection: %v", res.Err)
	}
	if res.Client.String() != "203.0.113.50" {
		t.Fatalf("attributed %s, attacker spoof won", res.Client)
	}
	if len(res.Strips) != 2 {
		t.Fatalf("strips = %+v", res.Strips)
	}
}

// Attacker appends unparseable garbage on the left: it sits left of the
// client position, so the walk never reaches it and attribution stands.
func TestForgedGarbageLeftOfClientHarmless(t *testing.T) {
	a := forgedAnalyzer(t, false)
	res := a.Analyze([]string{"not-an-ip, 203.0.113.50, 10.0.0.1"}, "")
	if !res.OK() || res.Client.String() != "203.0.113.50" {
		t.Fatalf("res = %+v", res)
	}
}

// Garbage injected at a position the walk must cross stops the analysis
// with an error instead of being skipped.
func TestForgedGarbageInPathStopsWalk(t *testing.T) {
	a := forgedAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.50, not-an-ip, 10.0.0.1"}, "")
	if res.Err == nil || res.Stop != StopMalformed {
		t.Fatalf("res = %+v", res)
	}
}

// Attacker claims a trusted proxy address on the far left; the walk stops
// at the real untrusted client before ever trusting the forged hop.
func TestForgedTrustedAddressOnLeftIgnored(t *testing.T) {
	a := forgedAnalyzer(t, false)
	res := a.Analyze([]string{"10.0.0.5, 203.0.113.50, 10.0.0.1"}, "")
	if !res.OK() || res.Client.String() != "203.0.113.50" {
		t.Fatalf("res = %+v", res)
	}
}

// Attacker hides behind a 4-in-6 spelling of a trusted proxy. With the
// unify switch on it is the same identity and gets stripped; with the
// switch off it is a distinct identity and becomes the client.
func TestForgedMappedAddressRespectsSwitch(t *testing.T) {
	on := forgedAnalyzer(t, true)
	res := on.Analyze([]string{"203.0.113.50, ::ffff:10.0.0.7"}, "")
	if !res.OK() || res.Client.String() != "203.0.113.50" {
		t.Fatalf("unify on: res = %+v", res)
	}
	if res.Strips[0].Address.String() != "10.0.0.7" {
		t.Fatalf("unify on: strip = %+v", res.Strips[0])
	}

	off := forgedAnalyzer(t, false)
	res = off.Analyze([]string{"203.0.113.50, ::ffff:10.0.0.7"}, "")
	if !res.OK() || res.Client.String() != "::ffff:10.0.0.7" {
		t.Fatalf("unify off: res = %+v", res)
	}
	if len(res.Strips) != 0 {
		t.Fatalf("unify off: strips = %+v", res.Strips)
	}
}

// Two header lines (a classic smuggling shape) are rejected outright.
func TestForgedDuplicateHeaderRejected(t *testing.T) {
	a := forgedAnalyzer(t, false)
	res := a.Analyze([]string{"203.0.113.50", "1.1.1.1"}, "10.0.0.1")
	if res.Err == nil || res.Stop != StopDuplicateHeader {
		t.Fatalf("res = %+v", res)
	}
}
