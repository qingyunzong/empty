package formal

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryStoreCompareAndSwap(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	key := LeaseKey{Cluster: "east", Name: "controller"}
	lease := Lease{
		Cluster: "east", Name: "controller", Holder: "a", Term: 1,
		RenewedAt: testEpoch, ExpiresAt: testEpoch.Add(testDuration),
	}

	created, err := store.Create(ctx, lease)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ResourceVersion == 0 {
		t.Fatal("Create did not assign a resource version")
	}

	if _, err := store.Create(ctx, lease); !errors.Is(err, ErrResourceVersionConflict) {
		t.Fatalf("duplicate Create error = %v, want conflict", err)
	}

	next := created
	next.Term = 2
	next.Holder = "b"
	if _, err := store.Update(ctx, next, created.ResourceVersion+1); !errors.Is(err, ErrResourceVersionConflict) {
		t.Fatalf("stale Update error = %v, want conflict", err)
	}

	updated, err := store.Update(ctx, next, created.ResourceVersion)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.ResourceVersion <= created.ResourceVersion {
		t.Fatalf("resource version did not advance: %d -> %d", created.ResourceVersion, updated.ResourceVersion)
	}

	got, ok, err := store.Get(ctx, key)
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	if got.Holder != "b" || got.Term != 2 {
		t.Fatalf("Get returned %+v", got)
	}

	// The same name in another cluster is a different key.
	west := lease
	west.Cluster = "west"
	west.Holder = "west-controller"
	if _, err := store.Create(ctx, west); err != nil {
		t.Fatalf("independent cluster create: %v", err)
	}
	if _, ok, _ := store.Get(ctx, LeaseKey{Cluster: "west", Name: "controller"}); !ok {
		t.Fatal("west lease missing")
	}
}

func TestMemoryStoreRejectsInvalidLease(t *testing.T) {
	store := NewMemoryStore()
	_, err := store.Create(context.Background(), Lease{
		Cluster: "east", Name: "controller", Holder: "a", Term: 1,
		RenewedAt: testEpoch, ExpiresAt: testEpoch,
	})
	if !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("Create error = %v, want ErrInvalidLease", err)
	}
}

func TestTickHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m := mustMachine(t, testConfig("east", "a"), NewMemoryStore(), newManualClock(testEpoch))
	if err := m.Tick(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Tick error = %v, want context.Canceled", err)
	}
	mustNotLeader(t, m)
}

func TestSkewedClocksUseExpectedDeadline(t *testing.T) {
	base := newManualClock(testEpoch)
	store := NewMemoryStore()
	m := mustMachine(t, testConfig("east", "a"), store, skewedClock{base: base, offset: -750 * time.Millisecond})
	if err := mustTick(t, m); err != nil {
		t.Fatalf("tick: %v", err)
	}
	until, ok := m.LeaderUntil()
	if !ok {
		t.Fatal("no confirmed deadline")
	}
	// The deadline is in the participant's local clock domain, so its offset
	// is visible here; the safety gate accounts for that difference.
	if want := testEpoch.Add(-750*time.Millisecond + testDuration); !until.Equal(want) {
		t.Fatalf("deadline = %v, want %v", until, want)
	}
}
