package dataeng

import (
	"errors"
	"testing"
	"time"
)

var (
	t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 = t0.Add(time.Hour)
	t2 = t0.Add(2 * time.Hour)
	t3 = t0.Add(3 * time.Hour)
	t4 = t0.Add(4 * time.Hour)
	t5 = t0.Add(5 * time.Hour)
)

func TestJoinSelectsLatestVersionWithinBothClocks(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "v1", 0),
		Upsert("f", t3, t3, 1, "v3", 0),
		// Future relative to the fact event time: must be ignored.
		Upsert("f", t5, t5, 1, "v5", 0),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StatePresent || result.Value != "v3" {
		t.Fatalf("got state=%v value=%q, want present v3", result.State, result.Value)
	}
}

func TestJoinCreatedTimeAfterSnapshotIsInvisible(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "v1", 0),
		// Late backfill revision: older event time but ingested after snapshot.
		Upsert("f", t1, t5, 2, "backfilled", 0),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t3})
	if result.State != StatePresent || result.Value != "v1" {
		t.Fatalf("got state=%v value=%q, want present v1 (backfill invisible)", result.State, result.Value)
	}
}

func TestJoinBoundsAreInclusive(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(Upsert("f", t3, t3, 1, "v3", 0))
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t3, SnapshotTime: t3})
	if result.State != StatePresent || result.Value != "v3" {
		t.Fatalf("got state=%v value=%q, want present v3 on exact bounds", result.State, result.Value)
	}
}

func TestJoinVersionTTLExpiry(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "expired", time.Hour),
		Upsert("f", t3, t3, 1, "fresh", 0),
	)
	joiner := NewJoiner[string, string](store)

	// At t4: t1+1h = t2 has passed, so the old version is expired; t3 still wins.
	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StatePresent || result.Value != "fresh" {
		t.Fatalf("got state=%v value=%q, want fresh", result.State, result.Value)
	}
}

func TestJoinAllEligibleVersionsExpired(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(Upsert("f", t1, t1, 1, "expired", time.Hour))
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StateAbsent || result.Reason != ReasonTTLExpired {
		t.Fatalf("got state=%v reason=%v, want absent ttl-expired", result.State, result.Reason)
	}
}

func TestJoinTTLExpiryIsInclusiveAtBoundary(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(Upsert("f", t1, t1, 1, "v1", time.Hour))
	joiner := NewJoiner[string, string](store)

	// Exactly at event time + TTL: still valid (expiry is strictly after).
	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t2, SnapshotTime: t2})
	if result.State != StatePresent || result.Value != "v1" {
		t.Fatalf("got state=%v reason=%v, want present at exact TTL boundary", result.State, result.Reason)
	}
}

func TestJoinDefaultTTLAppliesWhenVersionTTLUnset(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(Upsert("f", t1, t1, 1, "v1", 0))
	joiner := NewJoiner[string, string](store, WithDefaultTTL[string, string](time.Hour))

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t3, SnapshotTime: t5})
	if result.State != StateAbsent || result.Reason != ReasonTTLExpired {
		t.Fatalf("got state=%v reason=%v, want absent ttl-expired via default TTL", result.State, result.Reason)
	}
}

func TestJoinTombstoneShadowsOlderValues(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "v1", 0),
		Tombstone[string, string]("f", t2, t2, 2),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StateTombstoned || result.Selected == nil || !result.Selected.IsTombstone() {
		t.Fatalf("got state=%v selected=%v, want tombstone", result.State, result.Selected)
	}
}

func TestJoinTombstoneCreatedAfterSnapshotIsInvisible(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "v1", 0),
		// Deletion ingested after the snapshot: still know the old value.
		Tombstone[string, string]("f", t2, t5, 2),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t3})
	if result.State != StatePresent || result.Value != "v1" {
		t.Fatalf("got state=%v value=%q, want present v1 (tombstone invisible)", result.State, result.Value)
	}
}

func TestJoinTombstoneDoesNotExpireUnderTTL(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "v1", time.Minute),
		Tombstone[string, string]("f", t2, t2, 2),
	)
	joiner := NewJoiner[string, string](store, WithDefaultTTL[string, string](time.Minute))

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t5, SnapshotTime: t5})
	if result.State != StateTombstoned {
		t.Fatalf("got state=%v reason=%v, want tombstone immune to TTL", result.State, result.Reason)
	}
}

func TestJoinUpsertAfterTombstoneWins(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t1, t1, 1, "v1", 0),
		Tombstone[string, string]("f", t2, t2, 2),
		Upsert("f", t3, t3, 3, "revived", 0),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StatePresent || result.Value != "revived" {
		t.Fatalf("got state=%v value=%q, want revived value after tombstone", result.State, result.Value)
	}
}

func TestJoinSameEventTimeTieBrokenBySourceSequence(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t2, t3, 1, "low-seq", 0),
		Upsert("f", t2, t3, 7, "high-seq", 0),
		Upsert("f", t2, t3, 3, "mid-seq", 0),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StatePresent || result.Value != "high-seq" {
		t.Fatalf("got state=%v value=%q, want high-seq winner", result.State, result.Value)
	}
}

func TestJoinSameEventTimeAndSequenceTieBrokenByCreatedTime(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("f", t2, t2, 1, "older-created", 0),
		Upsert("f", t2, t3, 1, "newer-created", 0),
	)
	joiner := NewJoiner[string, string](store)

	result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t5})
	if result.State != StatePresent || result.Value != "newer-created" {
		t.Fatalf("got state=%v value=%q, want newer-created winner", result.State, result.Value)
	}
}

func TestJoinUnknownAndAllFutureKeys(t *testing.T) {
	t.Run("unknown key", func(t *testing.T) {
		joiner := NewJoiner[string, string](NewMemoryStore[string, string]())
		result := mustJoin(t, joiner, Fact[string]{Key: "missing", EventTime: t4, SnapshotTime: t5})
		if result.State != StateAbsent || result.Reason != ReasonNoVersion {
			t.Fatalf("got state=%v reason=%v, want absent no-version", result.State, result.Reason)
		}
	})

	t.Run("all versions outside both clocks", func(t *testing.T) {
		store := NewMemoryStore[string, string]()
		store.Put(
			Upsert("f", t5, t5, 1, "future-event", 0),
			Upsert("f", t1, t5, 1, "late-backfill", 0),
		)
		joiner := NewJoiner[string, string](store)
		result := mustJoin(t, joiner, Fact[string]{Key: "f", EventTime: t4, SnapshotTime: t3})
		if result.State != StateAbsent || result.Reason != ReasonNoEligibleVersion {
			t.Fatalf("got state=%v reason=%v, want absent no-eligible", result.State, result.Reason)
		}
	})
}

func TestJoinPreservesFactOrder(t *testing.T) {
	store := NewMemoryStore[string, string]()
	store.Put(
		Upsert("a", t1, t1, 1, "a1", 0),
		Upsert("b", t1, t1, 1, "b1", 0),
	)
	joiner := NewJoiner[string, string](store)
	facts := []Fact[string]{
		{Key: "b", EventTime: t2, SnapshotTime: t2},
		{Key: "a", EventTime: t2, SnapshotTime: t2},
		{Key: "missing", EventTime: t2, SnapshotTime: t2},
	}

	results, err := joiner.Join(facts)
	if err != nil {
		t.Fatalf("join returned error: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("got %d results, want 3", len(results))
	}
	if results[0].Value != "b1" || results[1].Value != "a1" || results[2].Reason != ReasonNoVersion {
		t.Fatalf("order/content mismatch: %+v", results)
	}
}

type errorStore[K comparable, V any] struct{ err error }

func (s errorStore[K, V]) Versions(K) ([]FeatureVersion[K, V], error) {
	return nil, s.err
}

func TestJoinPropagatesStoreError(t *testing.T) {
	wantErr := errors.New("store unavailable")
	joiner := NewJoiner[string, string](errorStore[string, string]{err: wantErr})

	results, err := joiner.Join([]Fact[string]{{Key: "f", EventTime: t4, SnapshotTime: t5}})
	if !errors.Is(err, wantErr) {
		t.Fatalf("got err=%v, want %v", err, wantErr)
	}
	if results != nil {
		t.Fatalf("got results=%v, want nil on error", results)
	}
}

func mustJoin[K comparable, V any](t *testing.T, joiner *Joiner[K, V], fact Fact[K]) Result[K, V] {
	t.Helper()
	results, err := joiner.Join([]Fact[K]{fact})
	if err != nil {
		t.Fatalf("join returned error: %v", err)
	}
	return results[0]
}
