package dataeng

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)

func ev(id, resource string, version uint64, typ EventType) Event {
	return Event{
		ID:         id,
		ResourceID: resource,
		Version:    version,
		IssuedAt:   t0.Add(time.Duration(version) * time.Second),
		Type:       typ,
	}
}

func mustEvent(t *testing.T, r *Reconciler, e Event) {
	t.Helper()
	if err := r.HandleEvent(e); err != nil {
		t.Fatalf("HandleEvent(%s): %v", e.ID, err)
	}
}

func outboundVersions(r *Reconciler) []uint64 {
	var vs []uint64
	for _, rec := range r.Outbound() {
		vs = append(vs, rec.Version)
	}
	return vs
}

func drainBackfills(r *Reconciler) []BackfillRequest {
	var reqs []BackfillRequest
	for {
		select {
		case req := <-r.Backfills():
			reqs = append(reqs, req)
		default:
			return reqs
		}
	}
}

func TestDeduplicatesByEventID(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	e := ev("e1", "res", 1, EventUpsert)
	mustEvent(t, r, e)
	mustEvent(t, r, e) // redelivery with same id
	if got := r.Outbound(); len(got) != 1 {
		t.Fatalf("expected 1 outbound record, got %d", len(got))
	}
}

func TestOutOfOrderBufferedThenDrained(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e2", "res", 2, EventUpsert))
	mustEvent(t, r, ev("e3", "res", 3, EventUpsert))
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	if got, want := outboundVersions(r), []uint64{1, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("outbound versions = %v, want %v", got, want)
	}
	for i, rec := range r.Outbound() {
		if rec.Seq != uint64(i+1) {
			t.Fatalf("record %d has seq %d", i, rec.Seq)
		}
	}
	if st := r.Status("res"); st.BackfillPending {
		t.Fatal("gap resolved by events, backfill should not be pending")
	}
}

func TestGapTriggersSingleBackfill(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	mustEvent(t, r, ev("e3", "res", 3, EventUpsert))
	mustEvent(t, r, ev("e4", "res", 4, EventUpsert))
	mustEvent(t, r, ev("e5", "res", 5, EventUpsert))

	reqs := drainBackfills(r)
	if len(reqs) != 1 {
		t.Fatalf("expected exactly 1 backfill request, got %d", len(reqs))
	}
	if reqs[0].FromVersion != 1 || reqs[0].ToVersion != 3 {
		t.Fatalf("backfill request = %+v, want {1..3}", reqs[0])
	}
	st := r.Status("res")
	if !st.BackfillPending || st.BackfillTo != 5 {
		t.Fatalf("status = %+v, want pending backfill up to 5", st)
	}
	if got := outboundVersions(r); !reflect.DeepEqual(got, []uint64{1}) {
		t.Fatalf("outbound versions = %v, want [1]", got)
	}
}

func TestSnapshotMergesWithBufferedEvents(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	mustEvent(t, r, ev("e3", "res", 3, EventUpsert))
	mustEvent(t, r, ev("e4", "res", 4, EventDelete))
	drainBackfills(r)

	// Backfill snapshot covers the missing v2; buffered v3/v4 apply on top.
	if err := r.HandleSnapshot(Snapshot{ResourceID: "res", Version: 2, Type: EventUpsert}); err != nil {
		t.Fatal(err)
	}
	if got, want := outboundVersions(r), []uint64{1, 2, 3, 4}; !reflect.DeepEqual(got, want) {
		t.Fatalf("outbound versions = %v, want %v", got, want)
	}
	out := r.Outbound()
	if !out[1].Snapshot {
		t.Fatal("second record should be marked as snapshot")
	}
	if st := r.Status("res"); !st.Tombstoned || st.TombVersion != 4 || st.BackfillPending {
		t.Fatalf("status = %+v, want tombstone at 4, no pending backfill", st)
	}
}

func TestSnapshotSupersedesLowerBufferedAndRequestsRemainingGap(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	mustEvent(t, r, ev("e3", "res", 3, EventUpsert))
	mustEvent(t, r, ev("e5", "res", 5, EventUpsert))
	drainBackfills(r)

	// Snapshot at v3 supersedes buffered v3, but v5 is still not contiguous.
	if err := r.HandleSnapshot(Snapshot{ResourceID: "res", Version: 3, Type: EventUpsert}); err != nil {
		t.Fatal(err)
	}
	if got, want := outboundVersions(r), []uint64{1, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("outbound versions = %v, want %v", got, want)
	}
	reqs := drainBackfills(r)
	if len(reqs) != 1 || reqs[0].FromVersion != 3 || reqs[0].ToVersion != 5 {
		t.Fatalf("expected one follow-up backfill {3..5}, got %+v", reqs)
	}
}

func TestStaleSnapshotDropped(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	mustEvent(t, r, ev("e2", "res", 2, EventUpsert))
	if err := r.HandleSnapshot(Snapshot{ResourceID: "res", Version: 2, Type: EventUpsert}); err != nil {
		t.Fatal(err)
	}
	if got := outboundVersions(r); !reflect.DeepEqual(got, []uint64{1, 2}) {
		t.Fatalf("outbound versions = %v, want [1 2]", got)
	}
}

func TestTombstoneNotResurrectedByLateUpdate(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	mustEvent(t, r, ev("e2", "res", 2, EventDelete))
	// Late upserts at or below the tombstone version must be dropped.
	mustEvent(t, r, ev("e3", "res", 1, EventUpsert))
	mustEvent(t, r, ev("e4", "res", 2, EventUpsert))
	if got, want := outboundVersions(r), []uint64{1, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("outbound versions = %v, want %v", got, want)
	}
	if st := r.Status("res"); !st.Tombstoned {
		t.Fatal("tombstone lost after late updates")
	}
	// A genuinely newer upsert is a legitimate recreate.
	mustEvent(t, r, ev("e5", "res", 3, EventUpsert))
	if st := r.Status("res"); st.Tombstoned || st.LastVersion != 3 {
		t.Fatalf("status = %+v, want recreate at v3", st)
	}
}

func TestSameVersionConflictResolvedByIssuedAt(t *testing.T) {
	r, err := NewReconciler(nil)
	if err != nil {
		t.Fatal(err)
	}
	old := ev("e2a", "res", 2, EventUpsert)
	old.Payload = []byte("old")
	newer := ev("e2b", "res", 2, EventUpsert)
	newer.IssuedAt = old.IssuedAt.Add(time.Minute)
	newer.Payload = []byte("new")
	mustEvent(t, r, old)
	mustEvent(t, r, newer)
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))

	out := r.Outbound()
	if len(out) != 2 || string(out[1].Payload) != "new" || out[1].EventID != "e2b" {
		t.Fatalf("expected later-issued copy to win, got %+v", out)
	}
}

func runScenario(t *testing.T, r *Reconciler) {
	t.Helper()
	mustEvent(t, r, ev("a1", "a", 1, EventUpsert))
	mustEvent(t, r, ev("a3", "a", 3, EventUpsert)) // gap at 2 -> backfill
	mustEvent(t, r, ev("a2", "a", 2, EventUpsert)) // fills gap, drains 3
	mustEvent(t, r, ev("b1", "b", 1, EventUpsert))
	mustEvent(t, r, ev("b2", "b", 2, EventDelete))
	mustEvent(t, r, ev("b-late", "b", 1, EventUpsert)) // dropped by tombstone
	mustEvent(t, r, ev("a1", "a", 1, EventUpsert))     // duplicate id, dropped
	mustEvent(t, r, ev("a5", "a", 5, EventUpsert))     // gap at 4 -> backfill
	if err := r.HandleSnapshot(Snapshot{ResourceID: "a", Version: 4, Type: EventUpsert}); err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("c2", "c", 2, EventUpsert)) // still buffered at crash
}

func TestCrashRecoveryKeepsStateAndOutboundSequence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal.log")

	store, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	r1, err := NewReconciler(store)
	if err != nil {
		t.Fatal(err)
	}
	runScenario(t, r1)
	before := r1.Outbound()
	statusA := r1.Status("a")
	statusB := r1.Status("b")
	statusC := r1.Status("c")
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	// "Restart": new reconciler over the same WAL.
	store2, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	var sunk []OutboundRecord
	r2, err := NewReconciler(store2, WithSink(func(rec OutboundRecord) { sunk = append(sunk, rec) }))
	if err != nil {
		t.Fatal(err)
	}
	if got := r2.Outbound(); !reflect.DeepEqual(got, before) {
		t.Fatalf("outbound after recovery = %+v, want %+v", got, before)
	}
	if got := r2.Status("a"); !reflect.DeepEqual(got, statusA) {
		t.Fatalf("status a after recovery = %+v, want %+v", got, statusA)
	}
	if got := r2.Status("b"); !reflect.DeepEqual(got, statusB) {
		t.Fatalf("status b after recovery = %+v, want %+v", got, statusB)
	}
	if got := r2.Status("c"); !reflect.DeepEqual(got, statusC) {
		t.Fatalf("status c after recovery = %+v, want %+v", got, statusC)
	}
	if len(sunk) != 0 {
		t.Fatalf("sink must not fire during replay, got %+v", sunk)
	}
	// Duplicates stay deduplicated across the restart.
	mustEvent(t, r2, ev("a1", "a", 1, EventUpsert))
	// Open gap on c is re-emitted after recovery.
	reqs := drainBackfills(r2)
	if len(reqs) != 1 || reqs[0].ResourceID != "c" || reqs[0].FromVersion != 0 || reqs[0].ToVersion != 2 {
		t.Fatalf("expected re-emitted backfill for c {0..2}, got %+v", reqs)
	}
	// Sequence continues without reuse after recovery.
	mustEvent(t, r2, ev("c1", "c", 1, EventUpsert))
	out := r2.Outbound()
	wantSeq := before[len(before)-1].Seq + 1
	if len(out) != len(before)+2 { // c@1 applied, then buffered c@2 drained
		t.Fatalf("outbound len = %d, want %d", len(out), len(before)+2)
	}
	if rec := out[len(out)-2]; rec.Seq != wantSeq || rec.ResourceID != "c" || rec.Version != 1 {
		t.Fatalf("record = %+v, want seq %d for c@1", rec, wantSeq)
	}
	if rec := out[len(out)-1]; rec.Seq != wantSeq+1 || rec.ResourceID != "c" || rec.Version != 2 {
		t.Fatalf("record = %+v, want seq %d for c@2", rec, wantSeq+1)
	}
}

func TestFileStoreTruncatesTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal.log")
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	r, err := NewReconciler(store)
	if err != nil {
		t.Fatal(err)
	}
	mustEvent(t, r, ev("e1", "res", 1, EventUpsert))
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	// Simulate a crash mid-write.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"kind":"event","event":{"id":"tor`); err != nil {
		t.Fatal(err)
	}
	f.Close()

	store2, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := NewReconciler(store2)
	if err != nil {
		t.Fatal(err)
	}
	if got := outboundVersions(r2); !reflect.DeepEqual(got, []uint64{1}) {
		t.Fatalf("outbound versions = %v, want [1]", got)
	}
	// Appends after the torn tail still work and replay cleanly.
	mustEvent(t, r2, ev("e2", "res", 2, EventUpsert))
	store2.Close()
	store3, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	r3, err := NewReconciler(store3)
	if err != nil {
		t.Fatal(err)
	}
	if got := outboundVersions(r3); !reflect.DeepEqual(got, []uint64{1, 2}) {
		t.Fatalf("outbound versions = %v, want [1 2]", got)
	}
}
