package hdrclient

import (
	"errors"
	"net/netip"
	"testing"
)

func pfx(s string) netip.Prefix {
	p, err := netip.ParsePrefix(s)
	if err != nil {
		panic(err)
	}
	return p
}

func addr(s string) netip.Addr {
	a, err := netip.ParseAddr(s)
	if err != nil {
		panic(err)
	}
	return a
}

func commit(t *testing.T, tx *Tx) {
	t.Helper()
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func TestTransactionVisibility(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.Trust("edge", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	if _, ok := tbl.Snapshot().Lookup(addr("10.1.2.3")); ok {
		t.Fatal("uncommitted rule visible in snapshot")
	}
	commit(t, tx)
	r, ok := tbl.Snapshot().Lookup(addr("10.1.2.3"))
	if !ok || r.Name != "edge" || r.Action != ActionTrust {
		t.Fatalf("committed rule not visible: %v %v", r, ok)
	}
}

func TestTransactionConflictAndRollback(t *testing.T) {
	tbl := NewTable()
	tx1 := tbl.Begin()
	tx2 := tbl.Begin()
	if err := tx1.Trust("a", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx1)
	if err := tx2.Trust("b", pfx("192.168.0.0/16")); err != nil {
		t.Fatal(err)
	}
	if err := tx2.Commit(); !errors.Is(err, ErrTxConflict) {
		t.Fatalf("want ErrTxConflict, got %v", err)
	}
	if err := tx1.Commit(); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("want ErrTxClosed, got %v", err)
	}
	tx3 := tbl.Begin()
	if err := tx3.Trust("c", pfx("172.16.0.0/12")); err != nil {
		t.Fatal(err)
	}
	tx3.Rollback()
	if _, ok := tbl.Snapshot().Lookup(addr("172.16.0.1")); ok {
		t.Fatal("rolled-back rule visible")
	}
	if err := tx3.Commit(); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("commit after rollback: want ErrTxClosed, got %v", err)
	}
}

func TestLongestMatchAndDenyException(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.Trust("broad", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	if err := tx.Deny("except-dmz", pfx("10.1.0.0/16")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)
	snap := tbl.Snapshot()

	r, ok := snap.Lookup(addr("10.2.3.4"))
	if !ok || r.Action != ActionTrust || r.Name != "broad" {
		t.Fatalf("10.2.3.4: got %v %v", r, ok)
	}
	r, ok = snap.Lookup(addr("10.1.2.3"))
	if !ok || r.Action != ActionDeny || r.Name != "except-dmz" {
		t.Fatalf("10.1.2.3: longest-match deny expected, got %v %v", r, ok)
	}
	if _, ok = snap.Lookup(addr("11.0.0.1")); ok {
		t.Fatal("11.0.0.1: unexpected match")
	}
}

func TestDenyWinsTie(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.Trust("t", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	if err := tx.Deny("d", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)
	r, ok := tbl.Snapshot().Lookup(addr("10.9.9.9"))
	if !ok || r.Action != ActionDeny {
		t.Fatalf("tie should resolve to deny, got %v %v", r, ok)
	}
}

func TestUnifyIPv4MappedSwitch(t *testing.T) {
	build := func(unify bool) *Snapshot {
		tbl := NewTable()
		tx := tbl.Begin()
		if err := tx.SetUnifyIPv4MappedIPv6(unify); err != nil {
			t.Fatal(err)
		}
		if err := tx.Trust("v4net", pfx("10.0.0.0/8")); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return tbl.Snapshot()
	}

	on := build(true)
	if !on.UnifyIPv4MappedIPv6() {
		t.Fatal("switch should be on")
	}
	mapped := on.normalize(addr("::ffff:10.1.2.3"))
	if mapped != addr("10.1.2.3") {
		t.Fatalf("unify on: normalized to %s", mapped)
	}
	if _, ok := on.Lookup(mapped); !ok {
		t.Fatal("unify on: ::ffff:10.1.2.3 should match 10.0.0.0/8")
	}

	off := build(false)
	mapped = off.normalize(addr("::ffff:10.1.2.3"))
	if mapped != addr("::ffff:10.1.2.3") {
		t.Fatalf("unify off: identity changed to %s", mapped)
	}
	if _, ok := off.Lookup(mapped); ok {
		t.Fatal("unify off: ::ffff:10.1.2.3 must not match 10.0.0.0/8")
	}
}

func TestUnifyNormalizesMappedRules(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.SetUnifyIPv4MappedIPv6(true); err != nil {
		t.Fatal(err)
	}
	if err := tx.Trust("mapped", pfx("::ffff:10.0.0.0/104")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)
	snap := tbl.Snapshot()
	r, ok := snap.Lookup(snap.normalize(addr("10.9.9.9")))
	if !ok || r.Name != "mapped" {
		t.Fatalf("mapped rule should unify to v4 and match 10.9.9.9: %v %v", r, ok)
	}
}

func TestUnifyRejectsBroadMappedPrefix(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.SetUnifyIPv4MappedIPv6(true); err != nil {
		t.Fatal(err)
	}
	if err := tx.Trust("toobroad", pfx("::ffff:0.0.0.0/95")); !errors.Is(err, ErrBadPrefix) {
		t.Fatalf("want ErrBadPrefix, got %v", err)
	}
}

func TestDuplicateRuleRejected(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.Trust("a", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	if err := tx.Trust("b", pfx("10.0.0.0/8")); !errors.Is(err, ErrDuplicateRule) {
		t.Fatalf("want ErrDuplicateRule, got %v", err)
	}
}

func TestRemoveRule(t *testing.T) {
	tbl := NewTable()
	tx := tbl.Begin()
	if err := tx.Trust("edge", pfx("10.0.0.0/8")); err != nil {
		t.Fatal(err)
	}
	commit(t, tx)

	tx2 := tbl.Begin()
	if err := tx2.Remove("edge"); err != nil {
		t.Fatal(err)
	}
	if err := tx2.Remove("edge"); !errors.Is(err, ErrRuleNotFound) {
		t.Fatalf("second remove: want ErrRuleNotFound, got %v", err)
	}
	commit(t, tx2)
	if _, ok := tbl.Snapshot().Lookup(addr("10.1.2.3")); ok {
		t.Fatal("removed rule still matches")
	}
}
