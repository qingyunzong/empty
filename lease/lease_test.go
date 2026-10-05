package lease

import (
	"errors"
	"testing"
)

func TestGrantIncreasesFence(t *testing.T) {
	m := NewManager()
	a := m.Grant("A", 0, 10)
	b := m.Grant("B", 1, 10)
	if a.Fence != 1 || b.Fence != 2 {
		t.Fatalf("fences = %d, %d; want 1, 2", a.Fence, b.Fence)
	}
	if b.Start != 1 || b.Expiry != 11 {
		t.Fatalf("lease interval = [%d,%d); want [1,11)", b.Start, b.Expiry)
	}
}

func TestDeadlineIsExclusive(t *testing.T) {
	m := NewManager()
	s := NewStore(m)
	l := m.Grant("A", 0, 10) // valid on [0,10)

	if err := s.Write("A", l.Fence, 9, "ok"); err != nil {
		t.Fatalf("write at t=9 rejected: %v", err)
	}
	if l.Valid(10) {
		t.Fatal("lease must be invalid at t == Expiry")
	}
	if err := s.Write("A", l.Fence, 10, "late"); !errors.Is(err, ErrStaleFence) {
		if !errors.Is(err, ErrNotHolder) {
			t.Fatalf("write at t=10: got %v, want rejection", err)
		}
	}
}

func TestWriteAtExactExpiryRejected(t *testing.T) {
	m := NewManager()
	s := NewStore(m)
	l := m.Grant("A", 0, 5)
	if err := s.Write("A", l.Fence, 5, "boundary"); err == nil {
		t.Fatal("write at t == Expiry must be rejected (exclusive deadline)")
	}
}

func TestRenewExtendsAndBumpsFence(t *testing.T) {
	m := NewManager()
	l := m.Grant("A", 0, 10)
	r, err := m.Renew("A", l.Fence, 4, 20)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if r.Fence <= l.Fence {
		t.Fatalf("renew fence %d not greater than %d", r.Fence, l.Fence)
	}
	if r.Expiry != 24 {
		t.Fatalf("renew expiry = %d; want 24", r.Expiry)
	}
}

func TestRenewRejectsStaleFenceAndStranger(t *testing.T) {
	m := NewManager()
	l := m.Grant("A", 0, 10)
	if _, err := m.Renew("A", l.Fence+99, 1, 10); !errors.Is(err, ErrStaleFence) {
		t.Fatalf("stale fence renew: %v", err)
	}
	if _, err := m.Renew("B", l.Fence, 1, 10); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("stranger renew: %v", err)
	}
	if _, err := m.Renew("A", l.Fence, 10, 10); !errors.Is(err, ErrExpired) {
		t.Fatalf("renew at expiry: %v", err)
	}
}

func TestSwitchOnlyAfterExpiry(t *testing.T) {
	m := NewManager()
	m.Grant("A", 0, 10)
	if _, err := m.Switch("B", 9, 10); err == nil {
		t.Fatal("switch while A's lease is valid must fail")
	}
	if _, err := m.Switch("B", 10, 10); err != nil {
		t.Fatalf("switch at expiry must succeed: %v", err)
	}
}

func TestFencedOutHolderCannotWriteAfterForceSwitch(t *testing.T) {
	m := NewManager()
	s := NewStore(m)
	la := m.Grant("A", 0, 100)

	// Authority switches to B at t=10; A is partitioned and never learns.
	lb := m.ForceSwitch("B", 10, 50)
	if err := s.Write("B", lb.Fence, 11, "b1"); err != nil {
		t.Fatalf("B write: %v", err)
	}

	// A comes back still believing it holds the lease until t=100.
	if err := s.Write("A", la.Fence, 12, "a-stale"); err == nil {
		t.Fatal("stale holder A must not write after authoritative switch")
	}
	if got := s.Writes(); len(got) != 1 || got[0].Holder != "B" {
		t.Fatalf("store writes = %+v; want only B's write", got)
	}
}

func TestSameLeaseMayWriteRepeatedly(t *testing.T) {
	m := NewManager()
	s := NewStore(m)
	l := m.Grant("A", 0, 100)
	if err := s.Write("A", l.Fence, 1, "first"); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := s.Write("A", l.Fence, 2, "second"); err != nil {
		t.Fatalf("same-lease rewrite must be allowed: %v", err)
	}
	if n := len(s.Writes()); n != 2 {
		t.Fatalf("accepted writes = %d; want 2", n)
	}
}

func TestLowerFenceRejected(t *testing.T) {
	m := NewManager()
	s := NewStore(m)
	l := m.Grant("A", 0, 100)
	if err := s.Write("A", l.Fence, 1, "first"); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := s.Write("A", l.Fence-1, 2, "old"); !errors.Is(err, ErrStaleFence) {
		t.Fatalf("lower fence: got %v, want ErrStaleFence", err)
	}
}
