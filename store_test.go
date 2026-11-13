package dataeng

import (
	"errors"
	"testing"
	"time"
)

var testNow = time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)

func rec(key, region string, vector VersionVector, value string, tombstone bool, eventID string) Record {
	return Record{
		Key:       key,
		Region:    region,
		Vector:    vector,
		Value:     []byte(value),
		Tombstone: tombstone,
		UpdatedAt: testNow,
		EventID:   eventID,
	}
}

func applyN(t *testing.T, s *Store, records ...Record) []ApplyResult {
	t.Helper()
	results, err := s.ApplyBatch(records)
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	return results
}

func TestDominatingVersionReplacesOld(t *testing.T) {
	s := New()
	applyN(t, s,
		rec("doc", "us", VersionVector{"us": 1}, "v1", false, "e1"),
		rec("doc", "us", VersionVector{"us": 2, "eu": 1}, "v2", false, "e2"),
	)

	versions, ok := s.Versions("doc")
	if !ok || len(versions) != 1 {
		t.Fatalf("expected single converged version, got %v (ok=%v)", versions, ok)
	}
	if string(versions[0].Value) != "v2" {
		t.Fatalf("expected dominating v2, got %q", versions[0].Value)
	}
}

func TestStaleRecordIsRejected(t *testing.T) {
	s := New()
	applyN(t, s, rec("doc", "us", VersionVector{"us": 2}, "new", false, "e2"))

	result, err := s.Apply(rec("doc", "us", VersionVector{"us": 1}, "old", false, "e1"))
	if err != nil {
		t.Fatal(err)
	}
	if !result.Stale || result.Accepted {
		t.Fatalf("expected stale rejection, got %+v", result)
	}
	if value, _, ok := s.Lookup("doc"); !ok || string(value) != "new" {
		t.Fatalf("stale record must not change state, got %q", value)
	}
}

func TestConcurrentVersionsFormConflictSet(t *testing.T) {
	s := New()
	results := applyN(t, s,
		rec("doc", "us", VersionVector{"us": 1}, "us-write", false, "e1"),
		rec("doc", "eu", VersionVector{"eu": 1}, "eu-write", false, "e2"),
	)

	if !results[0].Accepted || !results[1].Accepted || results[1].Conflicts != 2 {
		t.Fatalf("expected both concurrent writes retained, got %+v", results)
	}
	if !s.HasConflict("doc") {
		t.Fatal("expected conflict to be observable")
	}
	if _, ok := s.Effective("doc"); ok {
		t.Fatal("Effective must refuse to pick among concurrent versions")
	}
}

func TestRegionPriorityPolicyResolvesConflict(t *testing.T) {
	s := New()
	applyN(t, s,
		rec("doc", "us", VersionVector{"us": 1}, "us-write", false, "e1"),
		rec("doc", "eu", VersionVector{"eu": 1}, "eu-write", false, "e2"),
	)

	winner, decided, err := s.Resolve("doc", RegionPriorityPolicy{Priority: []string{"eu", "us"}})
	if err != nil || !decided {
		t.Fatalf("Resolve: decided=%v err=%v", decided, err)
	}
	if winner.Region != "eu" {
		t.Fatalf("expected eu priority winner, got region %q", winner.Region)
	}

	versions, _ := s.Versions("doc")
	if len(versions) != 1 {
		t.Fatalf("conflict set should be pruned to winner, got %d", len(versions))
	}
}

func TestRetainPolicyKeepsConflictSet(t *testing.T) {
	s := New()
	applyN(t, s,
		rec("doc", "us", VersionVector{"us": 1}, "a", false, "e1"),
		rec("doc", "eu", VersionVector{"eu": 1}, "b", false, "e2"),
	)

	if _, decided, err := s.Resolve("doc", RetainPolicy{}); err != nil || decided {
		t.Fatalf("RetainPolicy must not decide: decided=%v err=%v", decided, err)
	}
	if !s.HasConflict("doc") {
		t.Fatal("RetainPolicy must leave the conflict set intact")
	}
}

func TestTombstoneIsExplicitVersionedDelete(t *testing.T) {
	s := New()
	applyN(t, s, rec("doc", "us", VersionVector{"us": 1}, "v1", false, "e1"))

	result, err := s.Apply(rec("doc", "us", VersionVector{"us": 2}, "", true, "e2"))
	if err != nil || !result.Accepted || result.Alive {
		t.Fatalf("tombstone apply: %+v err=%v", result, err)
	}

	value, tombstone, ok := s.Lookup("doc")
	if !ok || !tombstone || value != nil {
		t.Fatalf("expected tombstone lookup, got value=%q tombstone=%v ok=%v", value, tombstone, ok)
	}

	// A later concurrent live write coexists with the tombstone rather than
	// silently resurrecting the key.
	applyN(t, s, rec("doc", "eu", VersionVector{"us": 1, "eu": 1}, "revived", false, "e3"))
	if !s.HasConflict("doc") {
		t.Fatal("concurrent write against tombstone must remain a conflict")
	}
}

func TestTombstonePropagatesAndDominates(t *testing.T) {
	s := New()
	applyN(t, s,
		rec("doc", "us", VersionVector{"us": 1}, "v1", false, "e1"),
		rec("doc", "us", VersionVector{"us": 2}, "", true, "e2"),
	)

	if value, tombstone, ok := s.Lookup("doc"); !ok || !tombstone || value != nil {
		t.Fatalf("expected dominant tombstone, got %q tombstone=%v", value, tombstone)
	}
}

func TestReplayIsIdempotentByEventID(t *testing.T) {
	s := New()
	record := rec("doc", "us", VersionVector{"us": 1}, "v1", false, "evt-1")

	first, err := s.Apply(record)
	if err != nil || !first.Accepted {
		t.Fatalf("first apply: %+v err=%v", first, err)
	}
	replay, err := s.Apply(record)
	if err != nil || !replay.Duplicate {
		t.Fatalf("replay must be duplicate, got %+v err=%v", replay, err)
	}

	versions, _ := s.Versions("doc")
	if len(versions) != 1 {
		t.Fatalf("replay duplicated a version, got %d", len(versions))
	}
}

func TestReplayIsIdempotentByEqualVector(t *testing.T) {
	s := New()
	first := rec("doc", "us", VersionVector{"us": 1}, "v1", false, "")
	again := rec("doc", "us", VersionVector{"us": 1}, "v1", false, "")

	applyN(t, s, first)
	result, err := s.Apply(again)
	if err != nil || !result.Duplicate {
		t.Fatalf("equal-vector replay must be duplicate, got %+v err=%v", result, err)
	}
}

func TestOfflineRegionNeverDeletes(t *testing.T) {
	s := New()
	applyN(t, s, rec("doc", "us", VersionVector{"us": 1}, "kept", false, "e1"))

	offline := errors.New("region unreachable")
	source := SourceFunc{
		ID:     "eu",
		PullFn: func() ([]Record, error) { return nil, offline },
	}

	summary, err := s.Ingest(source)
	if !errors.Is(err, offline) || !summary.Offline {
		t.Fatalf("expected offline error passthrough, got %+v err=%v", summary, err)
	}

	value, tombstone, ok := s.Lookup("doc")
	if !ok || tombstone || string(value) != "kept" {
		t.Fatalf("outage must not delete data, got value=%q tombstone=%v ok=%v", value, tombstone, ok)
	}
}

func TestRecoveryReplayConverges(t *testing.T) {
	s := New()

	// First successful sync applies e1 and e2.
	log := []Record{
		rec("doc", "us", VersionVector{"us": 1}, "v1", false, "e1"),
		rec("doc", "us", VersionVector{"us": 2}, "v2", false, "e2"),
	}
	source := SourceFunc{
		ID:     "us",
		PullFn: func() ([]Record, error) { return log, nil },
	}

	first, err := s.Ingest(source)
	if err != nil || first.Accepted != 2 {
		t.Fatalf("initial ingest: %+v err=%v", first, err)
	}

	// Recovery replays the whole log; every known event becomes a duplicate.
	replay, err := s.Replay(source)
	if err != nil || replay.Duplicate != 2 || replay.Accepted != 0 {
		t.Fatalf("replay must be fully idempotent, got %+v err=%v", replay, err)
	}

	// Then the region delivers one new event.
	log = append(log, rec("doc", "us", VersionVector{"us": 3}, "v3", false, "e3"))
	caughtUp, err := s.Replay(source)
	if err != nil || caughtUp.Accepted != 1 || caughtUp.Duplicate != 2 {
		t.Fatalf("partial replay expected 1 accept/2 dup, got %+v err=%v", caughtUp, err)
	}
	if value, _, ok := s.Lookup("doc"); !ok || string(value) != "v3" {
		t.Fatalf("expected convergence to v3, got %q", value)
	}
}

func TestPutAndDeleteAdvanceLocalVector(t *testing.T) {
	s := New()

	if _, err := s.Put("doc", "us", []byte("a"), testNow, "e1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put("doc", "us", []byte("b"), testNow, "e2"); err != nil {
		t.Fatal(err)
	}
	versions, _ := s.Versions("doc")
	if len(versions) != 1 || versions[0].Vector["us"] != 2 {
		t.Fatalf("expected local counter at 2, got %+v", versions)
	}

	if _, err := s.Delete("doc", "us", testNow, "e3"); err != nil {
		t.Fatal(err)
	}
	_, tombstone, ok := s.Lookup("doc")
	if !ok || !tombstone {
		t.Fatal("expected explicit delete to tombstone the key")
	}
}

func TestValidationErrors(t *testing.T) {
	s := New()
	cases := []Record{
		{Region: "us", Vector: VersionVector{"us": 1}, Value: []byte("x")},
		{Key: "doc", Vector: VersionVector{"us": 1}, Value: []byte("x")},
		{Key: "doc", Region: "us", Value: []byte("x")},
		{Key: "doc", Region: "us", Vector: VersionVector{"eu": 1}, Value: []byte("x")},
		{Key: "doc", Region: "us", Vector: VersionVector{"us": 1}},
	}

	for i, record := range cases {
		if _, err := s.Apply(record); err == nil {
			t.Fatalf("case %d: expected validation error", i)
		}
	}
}

func TestWallClockIsDisplayOnly(t *testing.T) {
	s := New()

	// The newer wall-clock write carries the causally older vector, so it
	// must lose adjudication despite its later timestamp.
	applyN(t, s, rec("doc", "eu", VersionVector{"eu": 2}, "causal-winner", false, "e2"))
	later := rec("doc", "us", VersionVector{"us": 1}, "wallclock-winner", false, "e1")
	later.UpdatedAt = testNow.Add(time.Hour)
	result, err := s.Apply(later)
	if err != nil || !result.Accepted || result.Conflicts != 2 {
		t.Fatalf("wall clock must not adjudicate, got %+v err=%v", result, err)
	}

	stamp, ok := s.DisplayUpdatedAt("missing")
	if ok || !stamp.IsZero() {
		t.Fatal("unknown key must report no display timestamp")
	}
}
