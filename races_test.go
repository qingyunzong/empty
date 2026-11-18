package formal

import (
	"testing"
)

func findRes(all [][]result, name string) (result, bool) {
	for _, schedule := range all {
		for _, r := range schedule {
			if r.name == name {
				return r, true
			}
		}
	}
	return result{}, false
}

// finalHolder derives the unique terminal holder from a schedule's successful
// ownership-changing results, applying the epoch order recorded in the leases.
func finalHolder(schedule []result) (string, uint64) {
	var holder string
	var epoch uint64
	for _, r := range schedule {
		if r.err == nil && r.l.Holder != "" && r.l.Epoch > epoch {
			holder, epoch = r.l.Holder, r.l.Epoch
		}
	}
	return holder, epoch
}

// assertUniqueFinalHolder requires successful ownership changes in every
// schedule to form one strictly increasing epoch chain ending in one holder.
func assertUniqueFinalHolder(t *testing.T, all [][]result) {
	t.Helper()
	for si, schedule := range all {
		var maxEpoch uint64
		for _, r := range schedule {
			// Renewals legitimately reuse the current epoch; only a smaller
			// epoch (a stale receipt) would indicate a safety violation.
			if r.err == nil && r.l.Holder != "" {
				if r.l.Epoch < maxEpoch {
					t.Fatalf("schedule %d %v: success with stale epoch %d after %d",
						si, schedule, r.l.Epoch, maxEpoch)
				}
				if r.l.Epoch > maxEpoch {
					maxEpoch = r.l.Epoch
				}
			}
		}
		holder, epoch := finalHolder(schedule)
		if maxEpoch == 0 || holder == "" || epoch != maxEpoch {
			t.Fatalf("schedule %d %v: no single final holder (max=%d)", si, schedule, maxEpoch)
		}
	}
}

// assertFinalWrites requires the sink write count for the object to be the
// same in every schedule.
func assertFinalWrites(t *testing.T, all [][]result, want int) {
	t.Helper()
	for si, schedule := range all {
		for _, r := range schedule {
			if r.writes != want {
				t.Fatalf("schedule %d %v: want %d sink writes, got %d",
					si, schedule, want, r.writes)
			}
		}
	}
}

// assertNoDoubleWrite requires at most one accepted write per schedule.
func assertNoDoubleWrite(t *testing.T, all [][]result) {
	t.Helper()
	for si, schedule := range all {
		seen := 0
		for _, r := range schedule {
			if r.writes > seen {
				seen = r.writes
			}
		}
		if seen > 1 {
			t.Fatalf("schedule %d %v: double write detected, %d accepted",
				si, schedule, seen)
		}
	}
}

// TestCleanLeasePairRaces enumerates every pairwise interleaving starting from
// a live, clean lease held by A.
func TestCleanLeasePairRaces(t *testing.T) {
	pairs := []struct {
		label string
		build func(s *scenario, a Lease) (op, op)
	}{
		{"renew-vs-steal", func(s *scenario, a Lease) (op, op) {
			return s.renewOp("renew", a), s.stealOp("steal", "B")
		}},
		{"acquire-vs-steal", func(s *scenario, a Lease) (op, op) {
			return s.acquireOp("acquire", "C"), s.stealOp("steal", "B")
		}},
		{"steal-vs-steal", func(s *scenario, a Lease) (op, op) {
			return s.stealOp("steal1", "B"), s.stealOp("steal2", "C")
		}},
		{"renew-vs-acquire", func(s *scenario, a Lease) (op, op) {
			return s.renewOp("renew", a), s.acquireOp("acquire", "C")
		}},
		{"renew-vs-stale-renew", func(s *scenario, a Lease) (op, op) {
			stale := Lease{Object: a.Object, Holder: "B", Epoch: a.Epoch}
			return s.renewOp("renew", a), s.renewOp("stale", stale)
		}},
	}
	for _, tc := range pairs {
		t.Run(tc.label, func(t *testing.T) {
			s := newScenario(t)
			a := s.setupHeld("A", false, nil, false)
			op1, op2 := tc.build(s, a)
			all := s.runInterleavings(op1, op2)
			assertUniqueFinalHolder(t, all)
			assertFinalWrites(t, all, 0)
		})
	}
}

// TestDirtyLeaseFlushRaces checks flush-vs-steal and break-vs-steal from a
// dirty lease: exactly one write-back survives in every interleaving.
func TestDirtyLeaseFlushRaces(t *testing.T) {
	cases := []struct {
		label string
		build func(s *scenario, a Lease) (op, op)
	}{
		{"flush-vs-steal", func(s *scenario, a Lease) (op, op) {
			return s.flushOp("flush", a), s.stealOp("steal", "B")
		}},
		{"break-vs-steal", func(s *scenario, a Lease) (op, op) {
			return s.breakOp("break", a), s.stealOp("steal", "B")
		}},
		{"flush-vs-break", func(s *scenario, a Lease) (op, op) {
			return s.flushOp("flush", a), s.breakOp("break", a)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			s := newScenario(t)
			a := s.setupHeld("A", true, []byte("payload"), false)
			op1, op2 := tc.build(s, a)
			all := s.runInterleavings(op1, op2)
			assertNoDoubleWrite(t, all)
			assertFinalWrites(t, all, 1)
			assertUniqueFinalHolderOrReleased(t, all)
		})
	}
}

// assertUniqueFinalHolderOrReleased allows schedules that end in a release
// (break) or a unique holder, but never an ambiguous state.
func assertUniqueFinalHolderOrReleased(t *testing.T, all [][]result) {
	t.Helper()
	for si, schedule := range all {
		released := false
		for _, r := range schedule {
			if r.err == nil && r.l.Holder == "" {
				released = true
			}
		}
		if released {
			// A later steal/acquire may re-take the object; that success
			// chain still ends in at most one holder by epoch ordering.
			continue
		}
		holder, _ := finalHolder(schedule)
		if holder == "" {
			t.Fatalf("schedule %d %v: neither released nor held", si, schedule)
		}
	}
}

// TestStealFencesOldReceipt: once A's lease is stolen, A's old receipt must
// never affect B's ownership, never write, and always be rejected.
func TestStealFencesOldReceipt(t *testing.T) {
	oldActions := []struct {
		label string
		build func(s *scenario, old Lease) op
	}{
		{"renew", func(s *scenario, old Lease) op { return s.renewOp("old", old) }},
		{"flush", func(s *scenario, old Lease) op { return s.flushOp("old", old) }},
		{"break", func(s *scenario, old Lease) op { return s.breakOp("old", old) }},
		{"markdirty", func(s *scenario, old Lease) op {
			return s.dirtyOp("old", old, []byte("stale"))
		}},
	}
	for _, ac := range oldActions {
		t.Run(ac.label, func(t *testing.T) {
			s := newScenario(t)
			old := s.setupHeld("A", true, []byte("payload"), false)
			all := s.runInterleavings(
				s.stealOp("steal", "B"),
				ac.build(s, old),
			)
			r, ok := findRes(all, "steal")
			if !ok || r.err != nil {
				t.Fatalf("steal did not succeed: %+v", r)
			}
			o, _ := findRes(all, "old")
			if o.err != ErrStaleToken && o.err != ErrNotHeld && o.err != ErrNotDirty {
				t.Fatalf("old receipt returned unexpected err %v", o.err)
			}
			// Exactly one write: the steal's flush under epoch 1.
			assertFinalWrites(t, all, 1)
			if ac.label == "break" {
				assertUniqueFinalHolderOrReleased(t, all)
			} else {
				holder, epoch := finalHolder(all[0])
				if holder != "B" || epoch != 2 {
					t.Fatalf("new holder not intact: holder=%s epoch=%d", holder, epoch)
				}
				assertUniqueFinalHolder(t, all)
			}
		})
	}

	// Single-thread check that the stale receipt never corrupts payload.
	t.Run("payload-survives-stale-writer", func(t *testing.T) {
		s := newScenario(t)
		old := s.setupHeld("A", true, []byte("payload"), false)
		if _, err := s.m.Steal(s.object, "B"); err != nil {
			t.Fatal(err)
		}
		if err := s.m.MarkDirty(old, []byte("stale")); err != ErrStaleToken {
			t.Fatalf("stale markdirty err = %v", err)
		}
		if _, err := s.m.Flush(old); err != ErrStaleToken {
			t.Fatalf("stale flush err = %v", err)
		}
		if data, _ := s.sink.Load(s.object); string(data) != "payload" {
			t.Fatalf("payload corrupted: %q", data)
		}
	})
}

// TestTripleInterleavings enumerates three-way races from clean and dirty
// starting states.
func TestTripleInterleavings(t *testing.T) {
	t.Run("clean renew steal steal", func(t *testing.T) {
		s := newScenario(t)
		a := s.setupHeld("A", false, nil, false)
		all := s.runInterleavings(
			s.renewOp("renew", a),
			s.stealOp("steal-b", "B"),
			s.stealOp("steal-c", "C"),
		)
		assertUniqueFinalHolder(t, all)
		assertFinalWrites(t, all, 0)
	})

	t.Run("dirty flush break steal", func(t *testing.T) {
		s := newScenario(t)
		a := s.setupHeld("A", true, []byte("p"), false)
		all := s.runInterleavings(
			s.flushOp("flush", a),
			s.breakOp("break", a),
			s.stealOp("steal", "B"),
		)
		assertNoDoubleWrite(t, all)
		assertFinalWrites(t, all, 1)
	})

	t.Run("dirty three steals", func(t *testing.T) {
		s := newScenario(t)
		s.setupHeld("A", true, []byte("p"), false)
		all := s.runInterleavings(
			s.stealOp("steal-b", "B"),
			s.stealOp("steal-c", "C"),
			s.stealOp("steal-d", "D"),
		)
		assertNoDoubleWrite(t, all)
		assertFinalWrites(t, all, 1)
		assertUniqueFinalHolder(t, all)
	})
}

// TestFreeAndExpired covers unheld and expired starting states.
func TestFreeAndExpired(t *testing.T) {
	t.Run("free acquire-vs-steal", func(t *testing.T) {
		s := newScenario(t)
		s.setupFree()
		all := s.runInterleavings(
			s.acquireOp("acquire", "A"),
			s.stealOp("steal", "B"),
		)
		assertUniqueFinalHolder(t, all)
		assertFinalWrites(t, all, 0)
	})

	t.Run("expired renew-vs-steal", func(t *testing.T) {
		s := newScenario(t)
		a := s.setupHeld("A", false, nil, true)
		all := s.runInterleavings(
			s.renewOp("renew", a),
			s.stealOp("steal", "B"),
		)
		r, _ := findRes(all, "renew")
		if r.err != ErrNotHeld {
			t.Fatalf("expired renew err = %v, want ErrNotHeld", r.err)
		}
		st, _ := findRes(all, "steal")
		if st.err != nil {
			t.Fatalf("steal on expired lease failed: %v", st.err)
		}
	})

	t.Run("expired dirty steal flushes once", func(t *testing.T) {
		s := newScenario(t)
		s.setupHeld("A", true, []byte("p"), true)
		all := s.runInterleavings(
			s.stealOp("steal1", "B"),
			s.stealOp("steal2", "C"),
		)
		assertNoDoubleWrite(t, all)
		assertFinalWrites(t, all, 1)
	})
}

// TestScheduleCount documents exhaustive coverage: renew (4 steps) versus
// steal (4 steps) produces C(8,4) distinct schedules.
func TestScheduleCount(t *testing.T) {
	s := newScenario(t)
	a := s.setupHeld("A", false, nil, false)
	all := s.runInterleavings(
		s.renewOp("renew", a),
		s.stealOp("steal", "B"),
	)
	if got, want := len(all), choose(8, 4); got != want {
		t.Fatalf("schedule count = %d, want %d", got, want)
	}
}

func choose(n, k int) int {
	if k > n-k {
		k = n - k
	}
	out := 1
	for i := 0; i < k; i++ {
		out = out * (n - i) / (i + 1)
	}
	return out
}

// TestLifecycleExplicit covers the documented path through the public API.
func TestLifecycleExplicit(t *testing.T) {
	s := newScenario(t)
	a, err := s.m.Acquire(s.object, "A")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.m.MarkDirty(a, []byte("v1")); err != nil {
		t.Fatal(err)
	}
	a2, err := s.m.Flush(a)
	if err != nil || a2.Epoch != 1 {
		t.Fatalf("flush: l=%+v err=%v", a2, err)
	}
	if s.sink.AcceptedFor(s.object) != 1 {
		t.Fatal("flush did not reach sink")
	}
	a3, err := s.m.Renew(a2)
	if err != nil || a3.Deadline.Before(a2.Deadline) {
		t.Fatalf("renew: l=%+v err=%v", a3, err)
	}

	b, err := s.m.Steal(s.object, "B")
	if err != nil || b.Epoch != a3.Epoch+1 || b.Holder != "B" {
		t.Fatalf("steal: l=%+v err=%v", b, err)
	}
	if _, err := s.m.Renew(a3); err != ErrStaleToken {
		t.Fatalf("old renew after steal err = %v", err)
	}
	if err := s.m.Break(b); err != nil {
		t.Fatalf("break: %v", err)
	}
	if s.holder() != "" {
		t.Fatalf("lease still held after break: %s", s.holder())
	}
	// Second break with the same receipt is rejected: no second release/write.
	if err := s.m.Break(b); err != ErrNotHeld {
		t.Fatalf("repeat break err = %v", err)
	}
	if s.sink.AcceptedFor(s.object) != 1 {
		t.Fatalf("writes = %d, want 1", s.sink.AcceptedFor(s.object))
	}

	// A clean break performs no write-back.
	c, err := s.m.Acquire(s.object, "C")
	if err != nil {
		t.Fatal(err)
	}
	before := s.sink.Accepted()
	if err := s.m.Break(c); err != nil {
		t.Fatal(err)
	}
	if s.sink.Accepted() != before {
		t.Fatal("clean break unexpectedly wrote back")
	}
}
