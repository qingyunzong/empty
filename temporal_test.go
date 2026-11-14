package dataeng

import (
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

func at(sec int64) time.Time {
	return time.Unix(sec, 0).UTC()
}

func mustApply(t *testing.T, table *Table, change DimensionChange) {
	t.Helper()
	if err := table.Apply(change); err != nil {
		t.Fatalf("Apply(%+v): %v", change, err)
	}
}

func TestLookupUsesHalfOpenNonOverlappingVersions(t *testing.T) {
	table := NewTable()
	mustApply(t, table, DimensionChange{Key: "k", ValidFrom: at(20), SourceSequence: 2, Value: "B"})
	mustApply(t, table, DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"})
	mustApply(t, table, DimensionChange{Key: "k", ValidFrom: at(30), SourceSequence: 3, Value: "C"})

	versions := table.Versions("k")
	if len(versions) != 3 {
		t.Fatalf("got %d versions, want 3", len(versions))
	}
	if !versions[0].ValidTo.Equal(at(20)) || !versions[1].ValidTo.Equal(at(30)) || !versions[2].OpenEnded {
		t.Fatalf("versions are not half-open: %+v", versions)
	}
	if versions[0].Contains(at(20)) || !versions[1].Contains(at(20)) {
		t.Fatalf("ValidTo must be exclusive")
	}

	tests := []struct {
		at    time.Time
		want  any
		found bool
	}{
		{at(9), nil, false},
		{at(10), "A", true},
		{at(19), "A", true},
		{at(20), "B", true},
		{at(29), "B", true},
		{at(30), "C", true},
	}
	for _, tt := range tests {
		got, ok := table.Lookup("k", tt.at)
		if ok != tt.found {
			t.Fatalf("Lookup(%v) found=%v, want %v", tt.at, ok, tt.found)
		}
		if ok && !reflect.DeepEqual(got.Value, tt.want) {
			t.Fatalf("Lookup(%v)=%v, want %v", tt.at, got.Value, tt.want)
		}
	}
}

func TestExactReplayIsIdempotent(t *testing.T) {
	table := NewTable()
	change := DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 7, Value: map[string]any{"v": 1}}
	if outcome, err := table.Upsert(change); err != nil || outcome != OutcomeApplied {
		t.Fatalf("first upsert = %v, %v", outcome, err)
	}
	if outcome, err := table.Upsert(change); err != nil || outcome != OutcomeDuplicate {
		t.Fatalf("replay upsert = %v, %v", outcome, err)
	}
	replay := change
	replay.SourceSequence = 8
	if outcome, err := table.Upsert(replay); err != nil || outcome != OutcomeDuplicate {
		t.Fatalf("no-op replay upsert = %v, %v", outcome, err)
	}
	if got := len(table.Versions("k")); got != 1 {
		t.Fatalf("replay created %d versions", got)
	}
	if v, _ := table.Lookup("k", at(10)); v.SourceSequence != 8 {
		t.Fatalf("no-op replay did not retain highest sequence: %d", v.SourceSequence)
	}
}

func TestSameStartConflictIsQuarantined(t *testing.T) {
	table := NewTable()
	mustApply(t, table, DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"})

	err := table.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 2, Value: "B"})
	if !errors.Is(err, ErrSameStartConflict) {
		t.Fatalf("err = %v, want ErrSameStartConflict", err)
	}
	if got, _ := table.LookupValue("k", at(15)); got != "A" {
		t.Fatalf("conflict changed committed value to %v", got)
	}
	conflicts := table.Conflicts()
	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(conflicts))
	}
	if conflicts[0].SourceSequence != 2 || conflicts[0].Incumbent.SourceSequence != 1 {
		t.Fatalf("unexpected conflict: %+v", conflicts[0])
	}
	if got := table.TakeConflicts(); len(got) != 1 {
		t.Fatalf("TakeConflicts returned %d", len(got))
	}
	if got := table.Conflicts(); len(got) != 0 {
		t.Fatalf("conflicts not drained: %d", len(got))
	}
}

func TestSameStartConflictDoesNotReviseOpenJoin(t *testing.T) {
	state := NewState()
	if err := state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"}); err != nil {
		t.Fatal(err)
	}
	before, _ := state.ApplyFact(Fact{ID: "f", Key: "k", EventTime: at(15)})

	err := state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 2, Value: "B"})
	if !errors.Is(err, ErrSameStartConflict) {
		t.Fatalf("err = %v", err)
	}
	after, _ := state.Result("f")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("conflict revised open result:\nbefore=%+v\nafter=%+v", before, after)
	}
	if got := len(state.Conflicts()); got != 1 {
		t.Fatalf("state conflicts = %d, want 1", got)
	}
}

func TestLatestSequencePolicyIsDeterministic(t *testing.T) {
	table := NewTableWithPolicy(LatestSequenceWins)
	mustApply(t, table, DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"})
	mustApply(t, table, DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 2, Value: "B"})
	if got, _ := table.LookupValue("k", at(15)); got != "B" {
		t.Fatalf("higher sequence did not win: %v", got)
	}
	if got := len(table.Conflicts()); got != 1 {
		t.Fatalf("superseded record was not quarantined: %d", got)
	}
	if err := table.Apply(DimensionChange{
		Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "stale",
	}); !errors.Is(err, ErrSameStartConflict) {
		t.Fatalf("stale lower sequence err = %v", err)
	}
	if got, _ := table.LookupValue("k", at(15)); got != "B" {
		t.Fatalf("stale change altered value: %v", got)
	}
}

func TestFactsJoinAtTheirOwnEventTime(t *testing.T) {
	state := NewState()
	if err := state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"}); err != nil {
		t.Fatal(err)
	}
	if err := state.Apply(DimensionChange{Key: "k", ValidFrom: at(20), SourceSequence: 2, Value: "B"}); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		id      string
		event   time.Time
		matched bool
		value   any
	}{
		{"before", at(9), false, nil},
		{"first", at(10), true, "A"},
		{"first-last", at(19), true, "A"},
		{"second", at(20), true, "B"},
	}
	for _, tt := range tests {
		result, err := state.ApplyFact(Fact{ID: tt.id, Key: "k", EventTime: tt.event, Value: "fact"})
		if err != nil {
			t.Fatalf("ApplyFact(%s): %v", tt.id, err)
		}
		if result.Matched != tt.matched || !reflect.DeepEqual(result.Value, tt.value) {
			t.Fatalf("%s: result=%+v", tt.id, result)
		}
	}
}

func TestLateDimensionRevisesOnlyOpenResults(t *testing.T) {
	state := NewState()
	state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"})

	closed, _ := state.ApplyFact(Fact{ID: "closed", Key: "k", EventTime: at(15)})
	open, _ := state.ApplyFact(Fact{ID: "open", Key: "k", EventTime: at(25)})
	if closed.Value != "A" || open.Value != "A" {
		t.Fatalf("initial values: closed=%v open=%v", closed.Value, open.Value)
	}

	// The watermark closes event times <= 20, so the 15s fact is frozen.
	state.AdvanceWatermark(at(20))

	// This version is late by processing time but is valid from 12s.
	if err := state.Apply(DimensionChange{Key: "k", ValidFrom: at(12), SourceSequence: 2, Value: "B"}); err != nil {
		t.Fatal(err)
	}
	closedNow, ok := state.Result("closed")
	if !ok || closedNow.Value != "A" || !closedNow.Finalized {
		t.Fatalf("closed fact was revised: %+v", closedNow)
	}
	openNow, ok := state.Result("open")
	if !ok || openNow.Value != "B" {
		t.Fatalf("open fact not revised: %+v", openNow)
	}
	if openNow.Revision != open.Revision+1 {
		t.Fatalf("open revision = %d, want %d", openNow.Revision, open.Revision+1)
	}

	var updates int
	for _, revision := range state.Revisions() {
		if revision.Kind == RevisionUpdate {
			updates++
			if revision.Result.FactID == "closed" {
				t.Fatalf("closed fact emitted a revision: %+v", revision)
			}
		}
	}
	if updates != 1 {
		t.Fatalf("got %d updates, want 1", updates)
	}

	if _, err := state.ApplyFact(Fact{ID: "closed", Key: "k", EventTime: at(15), Value: "changed"}); !errors.Is(err, ErrFactClosed) {
		t.Fatalf("closed fact update err = %v", err)
	}
}

func TestLateVersionBeforeFirstMatchEmitsCorrection(t *testing.T) {
	state := NewState()
	result, err := state.ApplyFact(Fact{ID: "f", Key: "k", EventTime: at(8)})
	if err != nil {
		t.Fatal(err)
	}
	if result.Matched {
		t.Fatalf("unexpected early match: %+v", result)
	}
	state.Apply(DimensionChange{Key: "k", ValidFrom: at(7), SourceSequence: 1, Value: "A"})
	result, ok := state.Result("f")
	if !ok || !result.Matched || result.Value != "A" || result.Revision != 2 {
		t.Fatalf("correction missing: %+v", result)
	}
}

func TestProvenanceOnlyUpdateDoesNotEmitRevision(t *testing.T) {
	state := NewState()
	state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"})
	state.ApplyFact(Fact{ID: "f", Key: "k", EventTime: at(12)})
	if got := len(state.Revisions()); got != 1 {
		t.Fatalf("initial revisions = %d", got)
	}

	state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 3, Value: "A"})
	if got := len(state.Revisions()); got != 1 {
		t.Fatalf("provenance-only update emitted a revision: %d", got)
	}
	result, _ := state.Result("f")
	if result.Version.SourceSequence != 3 || result.Value != "A" {
		t.Fatalf("result provenance not refreshed: %+v", result)
	}
	history := state.History("f")
	if len(history) != 2 || !reflect.DeepEqual(history[len(history)-1], result) {
		t.Fatalf("history does not end at current result: %+v", history)
	}
}

func TestMergeFieldsDimensionWins(t *testing.T) {
	state := NewState()
	state.Apply(DimensionChange{
		Key: "k", ValidFrom: at(10), SourceSequence: 1,
		Value: map[string]any{"name": "dim", "dim_only": 1},
	})
	result, _ := state.ApplyFact(Fact{
		ID: "f", Key: "k", EventTime: at(12),
		Value: map[string]any{"name": "fact", "fact_only": 2},
	})
	want := map[string]any{"name": "dim", "dim_only": 1, "fact_only": 2}
	if !reflect.DeepEqual(result.Fields, want) {
		t.Fatalf("Fields = %#v, want %#v", result.Fields, want)
	}
}

func TestCompactionPreservesEveryLookup(t *testing.T) {
	table := NewTable()
	for _, change := range []DimensionChange{
		{Key: "k", ValidFrom: at(0), SourceSequence: 1, Value: "A"},
		{Key: "k", ValidFrom: at(10), SourceSequence: 2, Value: "A"},
		{Key: "k", ValidFrom: at(20), SourceSequence: 3, Value: "B"},
		{Key: "k", ValidFrom: at(30), SourceSequence: 4, Value: "A"},
		{Key: "k", ValidFrom: at(40), SourceSequence: 5, Value: "A"},
	} {
		mustApply(t, table, change)
	}
	before := table.Clone()
	if removed := table.Compact(); removed != 2 {
		t.Fatalf("Compact removed %d, want 2", removed)
	}
	if removed := table.Compact(); removed != 0 {
		t.Fatalf("second Compact removed %d", removed)
	}

	// Exact boundaries and points around every boundary must agree.
	for _, probe := range []time.Time{
		at(-1), at(0), at(9), at(10), at(11), at(19), at(20), at(21),
		at(29), at(30), at(31), at(39), at(40), at(41),
	} {
		gotOld, okOld := before.Lookup("k", probe)
		gotNew, okNew := table.Lookup("k", probe)
		if okOld != okNew || !reflect.DeepEqual(gotOld.Value, gotNew.Value) {
			t.Fatalf("lookup at %v changed: before=%+v,%v after=%+v,%v",
				probe, gotOld.Value, okOld, gotNew.Value, okNew)
		}
	}
	if got := len(table.Versions("k")); got != 3 {
		t.Fatalf("compacted version count = %d, want 3", got)
	}
}

func TestJoinCompactionPreservesResults(t *testing.T) {
	state := NewLookupJoin()
	for _, change := range []DimensionChange{
		{Key: "k", ValidFrom: at(0), SourceSequence: 1, Value: "A"},
		{Key: "k", ValidFrom: at(10), SourceSequence: 2, Value: "A"},
		{Key: "k", ValidFrom: at(20), SourceSequence: 3, Value: "B"},
	} {
		if err := state.Apply(change); err != nil {
			t.Fatal(err)
		}
	}
	state.ApplyFact(Fact{ID: "early", Key: "k", EventTime: at(5)})
	state.ApplyFact(Fact{ID: "late", Key: "k", EventTime: at(15)})

	beforeResults := state.Results()
	beforeEarly, _ := state.Result("early")
	beforeLate, _ := state.Result("late")

	if removed := state.Compact(); removed != 1 {
		t.Fatalf("Compact removed %d, want 1", removed)
	}
	afterResults := state.Results()
	if !reflect.DeepEqual(beforeResults, afterResults) {
		t.Fatalf("stored results changed:\nbefore=%#v\nafter=%#v", beforeResults, afterResults)
	}
	afterEarly, _ := state.Result("early")
	afterLate, _ := state.Result("late")
	if !reflect.DeepEqual(beforeEarly.Value, afterEarly.Value) || !reflect.DeepEqual(beforeLate.Value, afterLate.Value) {
		t.Fatalf("compaction changed result payloads")
	}

	// A fresh as-of join must still select the same payloads.
	for _, tt := range []struct {
		event time.Time
		value any
	}{{at(5), "A"}, {at(15), "A"}, {at(25), "B"}} {
		result, matched := state.Join(Fact{Key: "k", EventTime: tt.event})
		if !matched || !reflect.DeepEqual(result.Value, tt.value) {
			t.Fatalf("join at %v after compaction = %+v", tt.event, result)
		}
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	table := NewTable()
	mustApply(t, table, DimensionChange{Key: "b", ValidFrom: at(5), SourceSequence: 2, Value: []any{"x", 1.0}})
	mustApply(t, table, DimensionChange{Key: "a", ValidFrom: at(2), SourceSequence: 1, Value: "A"})
	table.Apply(DimensionChange{Key: "a", ValidFrom: at(2), SourceSequence: 9, Value: "bad"})

	snap := table.Snapshot()
	restored := NewTable()
	if err := restored.Load(snap); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restored.Snapshot().Versions, snap.Versions) {
		t.Fatalf("snapshot mismatch:\n got %#v\nwant %#v", restored.Snapshot().Versions, snap.Versions)
	}
	if got := len(restored.Conflicts()); got != 1 {
		t.Fatalf("conflicts = %d, want 1", got)
	}

	bad := TableSnapshot{Versions: map[string][]Version{
		"k": {
			{Key: "k", ValidFrom: at(1), SourceSequence: 1},
			{Key: "k", ValidFrom: at(1), SourceSequence: 2},
		},
	}}
	if err := restored.Load(bad); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("invalid snapshot err = %v", err)
	}
}

func TestWatermarkStrictRegression(t *testing.T) {
	state := NewState()
	if _, err := state.AdvanceWatermarkStrict(at(10)); err != nil {
		t.Fatal(err)
	}
	if _, err := state.AdvanceWatermarkStrict(at(5)); !errors.Is(err, ErrWatermarkRegression) {
		t.Fatalf("regression err = %v", err)
	}
	if got := state.AdvanceWatermark(at(5)); got != nil {
		t.Fatalf("non-strict regression returned %v", got)
	}
	if got := state.Watermark(); !got.Equal(at(10)) {
		t.Fatalf("watermark = %v", got)
	}
}

func TestCloneIsIndependent(t *testing.T) {
	state := NewState()
	state.Apply(DimensionChange{Key: "k", ValidFrom: at(10), SourceSequence: 1, Value: "A"})
	state.ApplyFact(Fact{ID: "f", Key: "k", EventTime: at(12)})
	clone := state.Clone()

	if err := clone.Apply(DimensionChange{Key: "k", ValidFrom: at(14), SourceSequence: 2, Value: "B"}); err != nil {
		t.Fatal(err)
	}
	original, _ := state.Result("f")
	copied, _ := clone.Result("f")
	if original.Value != "A" {
		t.Fatalf("original mutated through clone: %+v", original)
	}
	if copied.Value != "A" {
		t.Fatalf("clone fact at 12s should still use A: %+v", copied)
	}
}

func TestConcurrentDimensionAndFactAccess(t *testing.T) {
	state := NewState()
	var wg sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				sec := int64(worker*100 + i)
				if err := state.Apply(DimensionChange{
					Key:            "k",
					ValidFrom:      at(sec),
					SourceSequence: uint64(sec + 1),
					Value:          sec,
				}); err != nil {
					t.Errorf("Apply: %v", err)
					return
				}
				if _, err := state.ApplyFact(Fact{
					ID:        "f-" + string(rune('a'+worker)) + "-" + time.Unix(sec, 0).Format("150405"),
					Key:       "k",
					EventTime: at(sec),
				}); err != nil {
					t.Errorf("ApplyFact: %v", err)
					return
				}
				state.Lookup("k", at(sec))
				state.Results()
			}
		}(worker)
	}
	wg.Wait()
	if got := len(state.Results()); got != 400 {
		t.Fatalf("results = %d, want 400", got)
	}
}
