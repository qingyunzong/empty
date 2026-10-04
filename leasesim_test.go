package leasesim

import (
	"errors"
	"testing"
)

func TestGrantAndExclusiveDeadline(t *testing.T) {
	m := &Manager{}
	lease, err := m.Grant("A", 0, 10)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if lease.Fence != 1 || lease.Expiry != 10 {
		t.Fatalf("unexpected lease %+v", lease)
	}
	if !lease.Valid(9) {
		t.Fatal("lease must be valid at t=9")
	}
	if lease.Valid(10) {
		t.Fatal("deadline is exclusive: lease must be invalid at t=10")
	}
	if got := m.Holder(9); got != "A" {
		t.Fatalf("holder at t=9 = %q, want A", got)
	}
	if got := m.Holder(10); got != "" {
		t.Fatalf("holder at t=10 = %q, want none", got)
	}
}

func TestGrantConflictAndRenew(t *testing.T) {
	m := &Manager{}
	if _, err := m.Grant("A", 0, 10); err != nil {
		t.Fatalf("grant A: %v", err)
	}
	if _, err := m.Grant("B", 5, 10); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("grant B while A valid: err = %v, want ErrLeaseHeld", err)
	}
	if _, err := m.Renew("B", 5, 10); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("renew by non-holder: err = %v, want ErrNotHolder", err)
	}
	lease, err := m.Renew("A", 5, 10)
	if err != nil {
		t.Fatalf("renew A: %v", err)
	}
	if lease.Fence != 2 || lease.Expiry != 15 {
		t.Fatalf("renewal must bump fence and extend expiry, got %+v", lease)
	}
	if _, err := m.Renew("A", 15, 10); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("renew at exclusive deadline: err = %v, want ErrLeaseExpired", err)
	}
	if _, err := m.Grant("B", 15, 10); err != nil {
		t.Fatalf("grant B after expiry: %v", err)
	}
}

func TestTakeoverFencesOutOldHolder(t *testing.T) {
	m := &Manager{}
	s := NewStore(m)

	a, err := m.Grant("A", 0, 100)
	if err != nil {
		t.Fatalf("grant A: %v", err)
	}
	if err := s.Write("A", a.Fence, "k", "a1", 1); err != nil {
		t.Fatalf("A write: %v", err)
	}

	// Authoritative switch while A lease is still valid. A never observes
	// the invalidation and keeps using its old fence.
	if _, err := m.Takeover("B", 2, 100); err != nil {
		t.Fatalf("takeover B: %v", err)
	}
	if err := s.Write("A", a.Fence, "k", "a2", 3); err == nil {
		t.Fatal("stale holder A must not write after takeover")
	}
	if got, _ := s.Get("k"); got != "a1" {
		t.Fatalf("stale write must not change data, got %q", got)
	}

	b, _ := m.Current()
	if err := s.Write("B", b.Fence, "k", "b1", 3); err != nil {
		t.Fatalf("B write: %v", err)
	}
	if got, _ := s.Get("k"); got != "b1" {
		t.Fatalf("got %q, want b1", got)
	}
}

func TestStoreRejectsBadFenceAndExpiry(t *testing.T) {
	m := &Manager{}
	s := NewStore(m)
	lease, _ := m.Grant("A", 0, 10)

	if err := s.Write("A", lease.Fence+1, "k", "v", 1); !errors.Is(err, ErrFenceMismatch) {
		t.Fatalf("future fence: err = %v, want ErrFenceMismatch", err)
	}
	if err := s.Write("B", lease.Fence, "k", "v", 1); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("wrong holder: err = %v, want ErrNotHolder", err)
	}
	if err := s.Write("A", lease.Fence, "k", "v", 10); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("write at exclusive deadline: err = %v, want ErrNotHolder", err)
	}
	if err := s.Write("A", lease.Fence, "k", "v", 9); err != nil {
		t.Fatalf("valid write: %v", err)
	}
	// A renewed lease bumps the fence; replaying the old fence is stale.
	if _, err := m.Renew("A", 9, 10); err != nil {
		t.Fatalf("renew: %v", err)
	}
	if err := s.Write("A", lease.Fence, "k", "v2", 10); !errors.Is(err, ErrFenceMismatch) {
		t.Fatalf("old fence after renew: err = %v, want ErrFenceMismatch", err)
	}
}

// TestReplayPartitionNoDoubleLegalWrite is the acceptance test: it replays a
// partition event log and verifies that at no point do two holders both
// perform legal writes. The partitioned old holder keeps writing with its
// stale fence without ever observing invalidation, and every such write must
// be rejected.
func TestReplayPartitionNoDoubleLegalWrite(t *testing.T) {
	events := []Event{
		{Kind: EvGrant, Time: 0, Holder: "A", TTL: 10},
		{Kind: EvWrite, Time: 1, Holder: "A", Key: "x", Value: "a1"},
		{Kind: EvRenew, Time: 5, Holder: "A", TTL: 10},                // valid until t=15
		{Kind: EvPartition, Time: 6, Holder: "A"},                     // A cut off from manager
		{Kind: EvRenew, Time: 10, Holder: "A", TTL: 10},               // fails: partitioned
		{Kind: EvWrite, Time: 12, Holder: "A", Key: "x", Value: "a2"}, // still legal: lease valid
		{Kind: EvGrant, Time: 15, Holder: "B", TTL: 10},               // A expired at 15 (exclusive)
		{Kind: EvWrite, Time: 16, Holder: "A", Key: "x", Value: "a3"}, // stale, must fail
		{Kind: EvWrite, Time: 16, Holder: "B", Key: "x", Value: "b1"},
		{Kind: EvWrite, Time: 17, Holder: "A", Key: "y", Value: "a4"}, // stale, must fail
		{Kind: EvHeal, Time: 18, Holder: "A"},
		{Kind: EvWrite, Time: 19, Holder: "A", Key: "y", Value: "a5"}, // learned B fence, still not holder
		{Kind: EvTakeover, Time: 20, Holder: "A", TTL: 10},            // authority switches back
		{Kind: EvWrite, Time: 21, Holder: "B", Key: "x", Value: "b2"}, // stale, must fail
		{Kind: EvWrite, Time: 21, Holder: "A", Key: "x", Value: "a6"},
	}

	sim := NewSimulator()
	results := sim.Replay(events)

	wantErr := map[int]bool{4: true, 7: true, 9: true, 11: true, 13: true}
	for i, res := range results {
		if wantErr[i] && res.Err == nil {
			t.Errorf("event %d (%+v): expected error, got none", i, res.Event)
		}
		if !wantErr[i] && res.Err != nil {
			t.Errorf("event %d (%+v): unexpected error %v", i, res.Event, res.Err)
		}
	}

	// Reconstruct lease history from successful grant/renew/takeover events.
	type interval struct {
		holder string
		fence  uint64
		start  int64
		expiry int64 // exclusive
	}
	var history []interval
	for _, res := range results {
		if res.Err == nil && (res.Event.Kind == EvGrant || res.Event.Kind == EvRenew || res.Event.Kind == EvTakeover) {
			history = append(history, interval{res.Lease.Holder, res.Lease.Fence, res.Event.Time, res.Lease.Expiry})
		}
	}
	holderAt := func(t int64) (interval, bool) {
		for i := len(history) - 1; i >= 0; i-- {
			if iv := history[i]; iv.start <= t && t < iv.expiry {
				return iv, true
			}
		}
		return interval{}, false
	}

	// Acceptance invariant: every accepted write was performed by the
	// unique valid holder at that time, carrying exactly that lease fence,
	// and accepted fences strictly increase. Hence no double legal writes.
	accepted := sim.Store.Accepted()
	var lastFence uint64
	writers := map[int64]string{}
	for _, w := range accepted {
		iv, ok := holderAt(w.Time)
		if !ok || iv.holder != w.Holder || iv.fence != w.Fence {
			t.Fatalf("write %+v accepted but lease history at t=%d is %+v", w, w.Time, iv)
		}
		if w.Fence <= lastFence {
			t.Fatalf("accepted fences not strictly increasing at %+v", w)
		}
		lastFence = w.Fence
		if prev, ok := writers[w.Time]; ok && prev != w.Holder {
			t.Fatalf("double legal write at t=%d by %q and %q", w.Time, prev, w.Holder)
		}
		writers[w.Time] = w.Holder
	}

	// The store must reflect exactly the legal writes, in order.
	got := make([]string, 0, len(accepted))
	for _, w := range accepted {
		got = append(got, w.Holder+":"+w.Value)
	}
	want := []string{"A:a1", "A:a2", "B:b1", "A:a6"}
	if len(got) != len(want) {
		t.Fatalf("accepted writes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("accepted writes = %v, want %v", got, want)
		}
	}
	if v, _ := sim.Store.Get("x"); v != "a6" {
		t.Fatalf("final x = %q, want a6", v)
	}
	if _, ok := sim.Store.Get("y"); ok {
		t.Fatal("no legal write to y ever occurred; key must be absent")
	}
}

func TestFenceNumbersIncreaseAcrossAuthoritySwitch(t *testing.T) {
	m := &Manager{}
	l1, _ := m.Grant("A", 0, 10)
	l2, _ := m.Renew("A", 1, 10)
	l3, _ := m.Takeover("B", 2, 10)
	l4, _ := m.Takeover("C", 3, 10)
	fences := []uint64{l1.Fence, l2.Fence, l3.Fence, l4.Fence}
	for i := 1; i < len(fences); i++ {
		if fences[i] <= fences[i-1] {
			t.Fatalf("fences not strictly increasing: %v", fences)
		}
	}
	if m.LastFence() != fences[len(fences)-1] {
		t.Fatalf("LastFence = %d, want %d", m.LastFence(), fences[len(fences)-1])
	}
}
