package hdrclient

import (
	"net/netip"
	"testing"
)

func mustPrefix(t *testing.T, s string, unify bool) netip.Prefix {
	t.Helper()
	p, err := ParsePrefix(s, unify)
	if err != nil {
		t.Fatalf("ParsePrefix(%q): %v", s, err)
	}
	return p
}

func mustCommit(t *testing.T, tx *Tx) {
	t.Helper()
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

func TestLongestMatchException(t *testing.T) {
	tab := NewTable(false)
	mustCommit(t, tab.Begin().
		Trust(mustPrefix(t, "10.0.0.0/8", false)).
		Deny(mustPrefix(t, "10.9.0.0/16", false)).
		Trust(mustPrefix(t, "2001:db8::/32", false)))
	snap := tab.Snapshot()

	cases := []struct {
		addr    string
		trusted bool
		prefix  string
	}{
		{"10.1.2.3", true, "10.0.0.0/8"},
		{"10.9.1.1", false, "10.9.0.0/16"}, // exception rejects inside trusted range
		{"10.9.255.254", false, "10.9.0.0/16"},
		{"192.168.0.1", false, ""}, // no match: untrusted by default
		{"2001:db8::5", true, "2001:db8::/32"},
		{"2001:db9::5", false, ""},
	}
	for _, c := range cases {
		rule := snap.Lookup(netip.MustParseAddr(c.addr))
		if rule.Trusted() != c.trusted {
			t.Errorf("Lookup(%s).Trusted() = %v, want %v (rule %s)", c.addr, rule.Trusted(), c.trusted, rule)
		}
		if c.prefix == "" {
			if rule.Matched {
				t.Errorf("Lookup(%s) matched %s, want no match", c.addr, rule)
			}
		} else if !rule.Matched || rule.Prefix != netip.MustParsePrefix(c.prefix) {
			t.Errorf("Lookup(%s) rule = %s, want prefix %s", c.addr, rule, c.prefix)
		}
	}
}

func TestTxRollback(t *testing.T) {
	tab := NewTable(false)
	tx := tab.Begin().Trust(mustPrefix(t, "10.0.0.0/8", false))
	tx.Rollback()
	if rule := tab.Snapshot().Lookup(netip.MustParseAddr("10.1.1.1")); rule.Matched {
		t.Fatalf("rolled-back entry visible: %s", rule)
	}
	if err := tx.Commit(); err == nil {
		t.Fatal("Commit after Rollback should fail")
	}
}

func TestTxCommitAtomicOnError(t *testing.T) {
	tab := NewTable(false)
	mustCommit(t, tab.Begin().Trust(mustPrefix(t, "10.0.0.0/8", false)))

	tx := tab.Begin().
		Trust(mustPrefix(t, "172.16.0.0/12", false)).
		Trust(netip.Prefix{}) // invalid: must abort the whole commit
	if err := tx.Commit(); err == nil {
		t.Fatal("Commit with invalid prefix should fail")
	}
	snap := tab.Snapshot()
	if rule := snap.Lookup(netip.MustParseAddr("172.16.1.1")); rule.Matched {
		t.Errorf("aborted commit leaked entry: %s", rule)
	}
	if rule := snap.Lookup(netip.MustParseAddr("10.1.1.1")); !rule.Trusted() {
		t.Error("pre-existing entry lost after aborted commit")
	}
}

func TestTxRemove(t *testing.T) {
	tab := NewTable(false)
	p := mustPrefix(t, "10.0.0.0/8", false)
	mustCommit(t, tab.Begin().Trust(p))
	mustCommit(t, tab.Begin().Remove(p))
	if rule := tab.Snapshot().Lookup(netip.MustParseAddr("10.1.1.1")); rule.Matched {
		t.Fatalf("removed entry still visible: %s", rule)
	}
}

func TestUnifyNormalizesMappedPrefixes(t *testing.T) {
	tab := NewTable(true)
	mustCommit(t, tab.Begin().Trust(mustPrefix(t, "::ffff:10.0.0.0/104", true)))
	snap := tab.Snapshot()
	rule := snap.Lookup(netip.MustParseAddr("10.1.2.3"))
	if !rule.Trusted() || rule.Prefix != netip.MustParsePrefix("10.0.0.0/8") {
		t.Errorf("Lookup(10.1.2.3) = %s, want trust 10.0.0.0/8", rule)
	}
}

func TestSnapshotIsolation(t *testing.T) {
	tab := NewTable(false)
	mustCommit(t, tab.Begin().Trust(mustPrefix(t, "10.0.0.0/8", false)))
	before := tab.Snapshot()
	mustCommit(t, tab.Begin().Trust(mustPrefix(t, "192.168.0.0/16", false)))
	if rule := before.Lookup(netip.MustParseAddr("192.168.1.1")); rule.Matched {
		t.Errorf("old snapshot sees later commit: %s", rule)
	}
	if rule := tab.Snapshot().Lookup(netip.MustParseAddr("192.168.1.1")); !rule.Trusted() {
		t.Error("new snapshot missing committed entry")
	}
}
