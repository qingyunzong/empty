package formal

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestAcquireRenewAndObserve(t *testing.T) {
	base := newManualClock(testEpoch)
	store := NewMemoryStore()
	a := mustMachine(t, testConfig("east", "a"), store, base)
	b := mustMachine(t, testConfig("east", "b"), store, base)
	key := LeaseKey{Cluster: "east", Name: "controller"}

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)
	if a.Term() != 1 || a.State() != Leader {
		t.Fatalf("unexpected first term/state: term=%d state=%s", a.Term(), a.State())
	}

	lease, ok, err := store.Get(context.Background(), key)
	if err != nil || !ok {
		t.Fatalf("get lease: ok=%v err=%v", ok, err)
	}
	if lease.Holder != "a" || lease.Term != 1 {
		t.Fatalf("unexpected lease: %+v", lease)
	}
	if !lease.ExpiresAt.Equal(testEpoch.Add(testDuration)) {
		t.Fatalf("expiration = %v, want %v", lease.ExpiresAt, testEpoch.Add(testDuration))
	}
	firstVersion := lease.ResourceVersion

	if err := mustTick(t, b); err != nil {
		t.Fatalf("b tick: %v", err)
	}
	mustNotLeader(t, b)
	if b.Term() != 1 {
		t.Fatalf("b should have observed term 1, got %d", b.Term())
	}

	base.Advance(testRenew)
	if err := mustTick(t, a); err != nil {
		t.Fatalf("a renew: %v", err)
	}
	mustLeader(t, a)

	renewed, _, err := store.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("get renewed lease: %v", err)
	}
	if renewed.Term != 1 || renewed.Holder != "a" {
		t.Fatalf("renewal changed identity: %+v", renewed)
	}
	if !renewed.ExpiresAt.Equal(testEpoch.Add(testRenew).Add(testDuration)) {
		t.Fatalf("renewed expiration = %v", renewed.ExpiresAt)
	}
	if renewed.ResourceVersion <= firstVersion {
		t.Fatalf("resource version did not advance: %d -> %d", firstVersion, renewed.ResourceVersion)
	}
}

func TestTakeoverRequiresExpiryPlusSkew(t *testing.T) {
	base := newManualClock(testEpoch)
	store := NewMemoryStore()
	a := mustMachine(t, testConfig("east", "a"), store, base)
	bClock := skewedClock{base: base, offset: 500 * time.Millisecond}
	b := mustMachine(t, testConfig("east", "b"), store, bClock)

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)

	// b's clock is 500ms ahead. At this instant b reads exactly
	// expiry+ClockSkewBound, which is not yet strictly after the gate.
	base.Advance(testDuration + 500*time.Millisecond)
	if err := mustTick(t, b); err != nil {
		t.Fatalf("b tick at boundary: %v", err)
	}
	mustNotLeader(t, b)

	// One nanosecond later the gate is crossed.
	base.Advance(time.Nanosecond)
	if err := mustTick(t, b); err != nil {
		t.Fatalf("b tick after boundary: %v", err)
	}
	mustLeader(t, b)
	if b.Term() != 2 {
		t.Fatalf("takeover term = %d, want 2", b.Term())
	}
	if bLease, _ := b.ObservedLease(); bLease.Holder != "b" {
		t.Fatalf("observed holder = %q, want b", bLease.Holder)
	}
	mustNotLeader(t, a)
	if a.IsLeader() {
		t.Fatal("old leader still reports leadership after its deadline")
	}
}

func TestIsLeaderRechecksDeadlineWithoutTick(t *testing.T) {
	base := newManualClock(testEpoch)
	m := mustMachine(t, testConfig("east", "a"), NewMemoryStore(), base)
	if err := mustTick(t, m); err != nil {
		t.Fatalf("tick: %v", err)
	}
	mustLeader(t, m)

	// At the exact local deadline the machine is no longer allowed to act even
	// though Tick has not run yet.
	base.Advance(testDuration)
	mustNotLeader(t, m)
	if m.State() != Follower {
		t.Fatalf("state = %s, want follower", m.State())
	}
	if until, ok := m.LeaderUntil(); !ok || !until.Equal(testEpoch.Add(testDuration)) {
		t.Fatalf("deadline = %v, ok=%v", until, ok)
	}

	if err := mustTick(t, m); err != nil {
		t.Fatalf("expiry tick: %v", err)
	}
	if _, ok := m.LeaderUntil(); ok {
		t.Fatal("Tick did not discard the expired local deadline")
	}
}

func TestSkewExtremesNeverSplitBrain(t *testing.T) {
	base := newManualClock(testEpoch)
	store := NewMemoryStore()
	a := mustMachine(t, testConfig("east", "a"), store, skewedClock{base: base, offset: -testSkew / 2})
	b := mustMachine(t, testConfig("east", "b"), store, skewedClock{base: base, offset: testSkew / 2})

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)

	// a is partitioned and never ticks. b observes the lease with the most
	// adverse pairwise clock relationship allowed by the configuration.
	for elapsed := time.Duration(0); elapsed <= 15*time.Second; elapsed += 100 * time.Millisecond {
		base.Advance(100 * time.Millisecond)
		if err := mustTick(t, b); err != nil {
			t.Fatalf("b tick at %v: %v", elapsed, err)
		}
		requireAtMostOneLeader(t, a, b)
	}
	mustLeader(t, b)
	mustNotLeader(t, a)
}

func TestAllAllowedSkewPairsNeverSplitBrain(t *testing.T) {
	const step = 10 * time.Millisecond
	offsets := []time.Duration{
		-testSkew / 2,
		-testSkew / 4,
		0,
		testSkew / 4,
		testSkew / 2,
	}

	for _, leaderOffset := range offsets {
		for _, candidateOffset := range offsets {
			leaderOffset, candidateOffset := leaderOffset, candidateOffset
			name := fmt.Sprintf("leader%+d/candidate%+d", leaderOffset, candidateOffset)
			t.Run(name, func(t *testing.T) {
				base := newManualClock(testEpoch)
				store := NewMemoryStore()
				leader := mustMachine(t, testConfig("east", "leader"), store,
					skewedClock{base: base, offset: leaderOffset})
				candidate := mustMachine(t, testConfig("east", "candidate"), store,
					skewedClock{base: base, offset: candidateOffset})

				if err := mustTick(t, leader); err != nil {
					t.Fatalf("leader tick: %v", err)
				}
				mustLeader(t, leader)

				// The leader is partitioned. Sweep through the complete
				// expiry window and beyond, checking after every step.
				for elapsed := time.Duration(0); elapsed <= testDuration+testSkew+time.Second; elapsed += step {
					base.Advance(step)
					if err := mustTick(t, candidate); err != nil {
						t.Fatalf("candidate tick at %v: %v", elapsed, err)
					}
					requireAtMostOneLeader(t, leader, candidate)
				}
				mustLeader(t, candidate)
			})
		}
	}
}

func TestOldLeaderSelfDemotesAndObservesNewLeader(t *testing.T) {
	base := newManualClock(testEpoch)
	inner := NewMemoryStore()
	aStore := newFaultStore(inner)
	a := mustMachine(t, testConfig("east", "a"), aStore, base)
	b := mustMachine(t, testConfig("east", "b"), inner, base)

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)
	aStore.setOffline(true)

	// a remains leader while its local lease is valid, even though renewal
	// fails.
	base.Advance(8 * time.Second)
	if err := mustTick(t, a); err == nil {
		t.Fatal("expected the isolated renewal to fail")
	}
	mustLeader(t, a)
	requireAtMostOneLeader(t, a, b)

	// Past the deadline a demotes locally without needing to reach the store.
	base.Advance(3 * time.Second)
	if err := mustTick(t, a); err != nil {
		t.Fatalf("a recovery tick: %v", err)
	}
	mustNotLeader(t, a)
	if a.State() != Follower {
		t.Fatalf("a state = %s, want follower", a.State())
	}

	// b can take over only after expiry plus the skew bound.
	base.Advance(100 * time.Millisecond)
	if err := mustTick(t, b); err != nil {
		t.Fatalf("b takeover: %v", err)
	}
	mustLeader(t, b)
	requireAtMostOneLeader(t, a, b)

	// The partition heals. The old leader observes the newer term and remains
	// a follower; it must not renew its stale lease.
	aStore.setOffline(false)
	for i := 0; i < 3; i++ {
		if err := mustTick(t, a); err != nil {
			t.Fatalf("a post-heal tick %d: %v", i, err)
		}
		mustNotLeader(t, a)
		requireAtMostOneLeader(t, a, b)
		base.Advance(testRenew)
	}
	mustLeader(t, b)
	if a.Term() < b.Term() {
		t.Fatalf("old leader term %d did not observe new term %d", a.Term(), b.Term())
	}
}

func TestLostRenewalsDoNotExtendLeadership(t *testing.T) {
	base := newManualClock(testEpoch)
	inner := NewMemoryStore()
	aStore := newFaultStore(inner)
	a := mustMachine(t, testConfig("east", "a"), aStore, base)
	b := mustMachine(t, testConfig("east", "b"), inner, base)

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)
	expiry := testEpoch.Add(testDuration)
	aStore.setDropUpdates(100)

	for i := 0; i < 4; i++ {
		base.Advance(testRenew)
		// Failed renewal attempts alternate with reads that confirm the
		// dropped write did not land. Neither may move the deadline.
		_ = mustTick(t, a)
		mustLeader(t, a)
		requireAtMostOneLeader(t, a, b)
	}
	until, ok := a.LeaderUntil()
	if !ok || !until.Equal(expiry) {
		t.Fatalf("unconfirmed renewals changed the deadline: %v, %v", until, ok)
	}

	// At the deadline the leader stops even though every renewal was lost.
	base.Advance(testRenew)
	if err := mustTick(t, a); err != nil {
		t.Fatalf("a expiry tick: %v", err)
	}
	mustNotLeader(t, a)

	// The follower waits for the full expiry+skew window.
	if err := mustTick(t, b); err != nil {
		t.Fatalf("b early tick: %v", err)
	}
	mustNotLeader(t, b)
	base.Advance(testSkew)
	if err := mustTick(t, b); err != nil {
		t.Fatalf("b boundary tick: %v", err)
	}
	mustNotLeader(t, b)
	base.Advance(time.Nanosecond)
	if err := mustTick(t, b); err != nil {
		t.Fatalf("b takeover tick: %v", err)
	}
	mustLeader(t, b)
	requireAtMostOneLeader(t, a, b)
}

func TestLostRenewalReplyIsReconciled(t *testing.T) {
	base := newManualClock(testEpoch)
	inner := NewMemoryStore()
	aStore := newFaultStore(inner)
	a := mustMachine(t, testConfig("east", "a"), aStore, base)

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)

	aStore.setLoseUpdateReplies(1)
	base.Advance(testRenew)
	if err := mustTick(t, a); err == nil {
		t.Fatal("expected the lost renewal response to surface as an error")
	}
	mustLeader(t, a)
	if until, _ := a.LeaderUntil(); !until.Equal(testEpoch.Add(testDuration)) {
		t.Fatalf("local deadline moved without a confirmed response: %v", until)
	}

	// The next tick reconciles immediately. The store accepted the renewal and
	// the machine adopts its own later lease without waiting for the renewal
	// interval to expire.
	if err := mustTick(t, a); err != nil {
		t.Fatalf("immediate reconcile tick: %v", err)
	}
	mustLeader(t, a)
	if a.LastError() != nil {
		t.Fatalf("unexpected last error: %v", a.LastError())
	}
	want := testEpoch.Add(testRenew).Add(testDuration)
	if until, _ := a.LeaderUntil(); !until.Equal(want) {
		t.Fatalf("reconciled deadline = %v, want %v", until, want)
	}

	// A later renewal uses the adopted resource version and succeeds normally.
	base.Advance(testRenew)
	if err := mustTick(t, a); err != nil {
		t.Fatalf("renew after reconcile: %v", err)
	}
	mustLeader(t, a)
	if a.LastError() != nil {
		t.Fatalf("unexpected last error: %v", a.LastError())
	}
	want = testEpoch.Add(2 * testRenew).Add(testDuration)
	if until, _ := a.LeaderUntil(); !until.Equal(want) {
		t.Fatalf("reconciled deadline = %v, want %v", until, want)
	}
	lease, _, _ := inner.Get(context.Background(), LeaseKey{Cluster: "east", Name: "controller"})
	if lease.Term != 1 || lease.Holder != "a" {
		t.Fatalf("reconciliation changed identity: %+v", lease)
	}
}

func TestAcquireConflictBacksOff(t *testing.T) {
	base := newManualClock(testEpoch)
	inner := NewMemoryStore()
	key := LeaseKey{Cluster: "east", Name: "controller"}
	old, err := inner.Create(context.Background(), Lease{
		Cluster: "east", Name: "controller", Holder: "a", Term: 1,
		RenewedAt: testEpoch, ExpiresAt: testEpoch.Add(testDuration),
	})
	if err != nil {
		t.Fatalf("seed lease: %v", err)
	}

	contenderStore := newConflictStore(inner)
	b := mustMachine(t, testConfig("east", "b"), contenderStore, base)
	base.Advance(testDuration + testSkew + time.Nanosecond)

	now := base.Now()
	contenderStore.armCompetitor(Lease{
		Cluster: "east", Name: "controller", Holder: "intruder", Term: 2,
		RenewedAt: now, ExpiresAt: now.Add(testDuration),
	})

	if err := mustTick(t, b); err != nil {
		t.Fatalf("conflicted acquire tick: %v", err)
	}
	mustNotLeader(t, b)
	if b.State() != Candidate {
		t.Fatalf("state after conflict = %s, want candidate", b.State())
	}

	// The next observation sees the winner's still-valid lease and backs off.
	if err := mustTick(t, b); err != nil {
		t.Fatalf("post-conflict tick: %v", err)
	}
	mustNotLeader(t, b)
	if b.State() != Follower {
		t.Fatalf("state after observing winner = %s, want follower", b.State())
	}

	current, _, _ := inner.Get(context.Background(), key)
	if current.Holder != "intruder" || current.Term != 2 {
		t.Fatalf("conflict injected the wrong lease: %+v", current)
	}
	if old.ResourceVersion == current.ResourceVersion {
		t.Fatal("resource version did not change")
	}
}

func TestCreateRaceHasOneWinner(t *testing.T) {
	base := newManualClock(testEpoch)
	inner := NewMemoryStore()
	races := newConflictStore(inner)
	b := mustMachine(t, testConfig("east", "b"), races, base)

	races.armCreateCompetitor(Lease{
		Cluster: "east", Name: "controller", Holder: "winner", Term: 1,
		RenewedAt: testEpoch, ExpiresAt: testEpoch.Add(testDuration),
	})

	if err := mustTick(t, b); err != nil {
		t.Fatalf("create race tick: %v", err)
	}
	mustNotLeader(t, b)
	if b.State() != Candidate {
		t.Fatalf("state after create conflict = %s, want candidate", b.State())
	}

	if err := mustTick(t, b); err != nil {
		t.Fatalf("post-create-race tick: %v", err)
	}
	mustNotLeader(t, b)
	winner, ok, _ := inner.Get(context.Background(), LeaseKey{Cluster: "east", Name: "controller"})
	if !ok || winner.Holder != "winner" || winner.Term != 1 {
		t.Fatalf("wrong create winner: %+v ok=%v", winner, ok)
	}
}

func TestLeaderDemotesOnHigherTermConflict(t *testing.T) {
	base := newManualClock(testEpoch)
	inner := NewMemoryStore()
	conflicts := newConflictStore(inner)
	a := mustMachine(t, testConfig("east", "a"), conflicts, base)

	if err := mustTick(t, a); err != nil {
		t.Fatalf("a tick: %v", err)
	}
	mustLeader(t, a)

	base.Advance(testRenew)
	now := base.Now()
	conflicts.armCompetitor(Lease{
		Cluster: "east", Name: "controller", Holder: "intruder", Term: 2,
		RenewedAt: now, ExpiresAt: now.Add(testDuration),
	})

	if err := mustTick(t, a); err != nil {
		t.Fatalf("renew tick: %v", err)
	}
	mustNotLeader(t, a)
	if a.State() != Follower {
		t.Fatalf("state = %s, want follower", a.State())
	}
	if a.Term() != 2 {
		t.Fatalf("observed term = %d, want 2", a.Term())
	}

	current, _, _ := inner.Get(context.Background(), LeaseKey{Cluster: "east", Name: "controller"})
	if current.Holder != "intruder" || current.Term != 2 {
		t.Fatalf("old leader overwrote the newer lease: %+v", current)
	}
}

func TestClusterIsolation(t *testing.T) {
	base := newManualClock(testEpoch)
	store := NewMemoryStore()
	east := mustMachine(t, testConfig("east", "controller"), store, base)
	west := mustMachine(t, testConfig("west", "controller"), store, base)

	for _, m := range []*Machine{east, west} {
		if err := mustTick(t, m); err != nil {
			t.Fatalf("%s tick: %v", m.Key(), err)
		}
		mustLeader(t, m)
	}
	if east.Term() != 1 || west.Term() != 1 {
		t.Fatalf("clusters shared a term sequence: east=%d west=%d", east.Term(), west.Term())
	}

	for _, tc := range []struct {
		key    LeaseKey
		holder string
	}{
		{LeaseKey{Cluster: "east", Name: "controller"}, "controller"},
		{LeaseKey{Cluster: "west", Name: "controller"}, "controller"},
	} {
		lease, ok, err := store.Get(context.Background(), tc.key)
		if err != nil || !ok || lease.Holder != tc.holder {
			t.Fatalf("lease %s: %+v ok=%v err=%v", tc.key, lease, ok, err)
		}
	}

	// A namespace leak must never be adopted, even if the foreign lease says
	// its term is higher.
	poisoned := mustMachine(t, testConfig("east", "poisoned"), poisonStore{lease: Lease{
		Cluster: "west", Name: "controller", Holder: "foreign", Term: 99,
		RenewedAt: testEpoch, ExpiresAt: testEpoch.Add(testDuration), ResourceVersion: 7,
	}}, base)
	err := mustTick(t, poisoned)
	if !errors.Is(err, ErrClusterMismatch) {
		t.Fatalf("poisoned tick error = %v, want ErrClusterMismatch", err)
	}
	mustNotLeader(t, poisoned)
}

func TestConfigValidation(t *testing.T) {
	valid := testConfig("east", "a")
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}

	tests := map[string]func(*Config){
		"empty cluster":     func(c *Config) { c.Cluster = "" },
		"empty name":        func(c *Config) { c.LeaseName = " " },
		"empty holder":      func(c *Config) { c.Holder = "" },
		"zero duration":     func(c *Config) { c.LeaseDuration = 0 },
		"zero renew":        func(c *Config) { c.RenewInterval = 0 },
		"renew not shorter": func(c *Config) { c.RenewInterval = c.LeaseDuration },
		"negative skew":     func(c *Config) { c.ClockSkewBound = -time.Second },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			cfg := valid
			mutate(&cfg)
			if err := cfg.Validate(); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("Validate() = %v, want ErrInvalidConfig", err)
			}
		})
	}
}

func TestNewRejectsMissingDependencies(t *testing.T) {
	cfg := testConfig("east", "a")
	clock := newManualClock(testEpoch)
	if _, err := New(cfg, nil, clock); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil store error = %v", err)
	}
	if _, err := New(cfg, NewMemoryStore(), nil); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil clock error = %v", err)
	}
}

func TestTermOverflowDoesNotAcquire(t *testing.T) {
	base := newManualClock(testEpoch)
	store := NewMemoryStore()
	if _, err := store.Create(context.Background(), Lease{
		Cluster: "east", Name: "controller", Holder: "old", Term: ^uint64(0),
		RenewedAt: testEpoch, ExpiresAt: testEpoch.Add(testDuration),
	}); err != nil {
		t.Fatalf("seed lease: %v", err)
	}
	m := mustMachine(t, testConfig("east", "a"), store, base)
	base.Advance(testDuration + testSkew + time.Nanosecond)

	if err := mustTick(t, m); !errors.Is(err, ErrTermOverflow) {
		t.Fatalf("tick error = %v, want ErrTermOverflow", err)
	}
	mustNotLeader(t, m)
}
