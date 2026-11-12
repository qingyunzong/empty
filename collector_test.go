package dataeng

import (
	"errors"
	"math/big"
	"reflect"
	"testing"
)

func bi(value string) *big.Int {
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok {
		panic("bad test integer: " + value)
	}
	return parsed
}

func ev(id string, row, col int, value string) Event {
	return Event{ID: []byte(id), Row: row, Col: col, Value: bi(value)}
}

func del(id string, row, col int) Event {
	return Event{ID: []byte(id), Row: row, Col: col, Delete: true}
}

func assertErrIs(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("want error %v, got %v", target, err)
	}
}

func assertCSR(t *testing.T, got CSR, wantColumns, wantRowPtr []int, wantValues []string, wantSources []string) {
	t.Helper()
	if !reflect.DeepEqual(got.RowPtr, wantRowPtr) {
		t.Fatalf("RowPtr = %v, want %v", got.RowPtr, wantRowPtr)
	}
	if !reflect.DeepEqual(got.Columns, wantColumns) {
		t.Fatalf("Columns = %v, want %v", got.Columns, wantColumns)
	}
	if len(got.Values) != len(wantValues) {
		t.Fatalf("Values len = %d, want %d", len(got.Values), len(wantValues))
	}
	for i, want := range wantValues {
		if got.Values[i].Cmp(bi(want)) != 0 {
			t.Fatalf("Values[%d] = %s, want %s", i, got.Values[i], want)
		}
	}
	var gotSources []string
	for _, source := range got.Sources {
		gotSources = append(gotSources, string(source))
	}
	if !reflect.DeepEqual(gotSources, wantSources) {
		t.Fatalf("Sources = %v, want %v", gotSources, wantSources)
	}
}

func TestWithinBatchReductionTakesLastEventID(t *testing.T) {
	collector, err := NewCollector(2, 2, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	// Same cell, three events: winner is the greatest ID byte sequence, not the
	// last slice position and not a sum.
	batch := Batch{Version: 1, Events: []Event{
		ev("a", 0, 0, "2"),
		ev("c", 0, 0, "40"),
		ev("b", 0, 0, "7"),
	}}
	snapshots, err := collector.Submit(batch)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].Version != 1 {
		t.Fatalf("unexpected snapshots: %+v", snapshots)
	}
	assertCSR(t, snapshots[0].CSR,
		[]int{0}, []int{0, 1, 1},
		[]string{"40"}, []string{"c"})
}

func TestExplicitZeroIsKeptAndDeleteRemovesCell(t *testing.T) {
	collector, err := NewCollector(2, 2, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := collector.Submit(Batch{Version: 1, Events: []Event{
		ev("z", 0, 1, "0"),
		ev("n", 1, 0, "-5"),
	}}); err != nil {
		t.Fatal(err)
	}
	first := collector.Snapshot(1)
	// The zero is retained as a real entry, distinct from absence.
	assertCSR(t, first.CSR,
		[]int{1, 0}, []int{0, 1, 2},
		[]string{"0", "-5"}, []string{"z", "n"})

	if _, err := collector.Submit(Batch{Version: 2, Events: []Event{
		del("d", 0, 1),
	}}); err != nil {
		t.Fatal(err)
	}
	second := collector.Snapshot(2)
	assertCSR(t, second.CSR,
		[]int{0}, []int{0, 0, 1},
		[]string{"-5"}, []string{"n"})

	// Delete followed by re-add: the cell comes back with new provenance.
	if _, err := collector.Submit(Batch{Version: 3, Events: []Event{
		ev("r", 0, 1, "99"),
	}}); err != nil {
		t.Fatal(err)
	}
	third := collector.Snapshot(3)
	assertCSR(t, third.CSR,
		[]int{1, 0}, []int{0, 1, 2},
		[]string{"99", "-5"}, []string{"r", "n"})
}

func TestOutOfBoundsFailsWholeBatch(t *testing.T) {
	collector, err := NewCollector(2, 2, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	_, err = collector.Submit(Batch{Version: 1, Events: []Event{
		ev("ok", 0, 0, "1"),
		ev("bad", 2, 0, "2"),
	}})
	assertErrIs(t, err, ErrOutOfBounds)

	_, err = collector.Submit(Batch{Version: 1, Events: []Event{
		ev("neg", 0, -1, "2"),
	}})
	assertErrIs(t, err, ErrOutOfBounds)

	if collector.NextVersion() != 1 {
		t.Fatalf("failed batch must not advance state, next=%d", collector.NextVersion())
	}
	if collector.Snapshot(1) != nil {
		t.Fatal("failed batch must not produce a snapshot")
	}
}

func TestDuplicateEventIDs(t *testing.T) {
	collector, err := NewCollector(2, 2, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	// Identical repeats are accepted and collapse to one operation.
	event := ev("same", 0, 0, "3")
	snapshots, err := collector.Submit(Batch{Version: 1, Events: []Event{event, event}})
	if err != nil {
		t.Fatalf("identical duplicate rejected: %v", err)
	}
	assertCSR(t, snapshots[0].CSR,
		[]int{0}, []int{0, 1, 1}, []string{"3"}, []string{"same"})

	// Same ID, different payload fails the batch.
	_, err = collector.Submit(Batch{Version: 2, Events: []Event{
		ev("dup", 0, 0, "1"),
		ev("dup", 1, 1, "2"),
	}})
	assertErrIs(t, err, ErrDuplicateEvent)
	if collector.NextVersion() != 2 {
		t.Fatalf("rejected batch must not advance state, next=%d", collector.NextVersion())
	}
}

func TestOutOfOrderBatchesAndVersionHole(t *testing.T) {
	collector, err := NewCollector(3, 3, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	// Versions 2 and 3 arrive before 1: they buffer without committing and must
	// not overwrite each other or the still-missing version.
	if snapshots, err := collector.Submit(Batch{Version: 2, Events: []Event{ev("b", 0, 0, "2")}}); err != nil {
		t.Fatal(err)
	} else if len(snapshots) != 0 {
		t.Fatalf("buffered batch returned snapshots: %+v", snapshots)
	}
	if snapshots, err := collector.Submit(Batch{Version: 3, Events: []Event{del("d", 0, 0)}}); err != nil {
		t.Fatal(err)
	} else if len(snapshots) != 0 {
		t.Fatalf("buffered batch returned snapshots: %+v", snapshots)
	}
	if collector.NextVersion() != 1 || collector.PendingBytes() == 0 {
		t.Fatalf("expected buffered gap state, next=%d pending=%d", collector.NextVersion(), collector.PendingBytes())
	}

	// Closing the hole commits 1, 2, 3 in order within one Submit call.
	snapshots, err := collector.Submit(Batch{Version: 1, Events: []Event{ev("a", 0, 0, "1")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 3 {
		t.Fatalf("want 3 drained snapshots, got %d", len(snapshots))
	}
	for i, snapshot := range snapshots {
		if snapshot.Version != i+1 {
			t.Fatalf("snapshot order wrong at %d: version %d", i, snapshot.Version)
		}
	}

	// Cumulative effect: v1 stores, v2 overwrites, v3 deletes.
	last := snapshots[2]
	if len(last.CSR.Values) != 0 {
		t.Fatalf("cell should be deleted, got values %v", last.CSR.Values)
	}
	if collector.PendingBytes() != 0 {
		t.Fatalf("drained pending bytes = %d, want 0", collector.PendingBytes())
	}
}

func TestRedeliveryMustMatchContent(t *testing.T) {
	collector, err := NewCollector(2, 2, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	original := Batch{Version: 1, Events: []Event{ev("a", 0, 0, "1"), ev("b", 1, 1, "2")}}
	first, err := collector.Submit(original)
	if err != nil {
		t.Fatal(err)
	}

	// Same content, different slice order is still the same batch.
	reordered := Batch{Version: 1, Events: []Event{original.Events[1], original.Events[0]}}
	again, err := collector.Submit(reordered)
	if err != nil {
		t.Fatalf("identical redelivery rejected: %v", err)
	}
	if len(again) != 1 || again[0] != first[0] {
		t.Fatal("idempotent redelivery should return the stored snapshot")
	}

	// Different content for the same version must fail.
	_, err = collector.Submit(Batch{Version: 1, Events: []Event{ev("a", 0, 0, "999")}})
	assertErrIs(t, err, ErrConflict)

	// Conflicting redelivery while the version is still buffered must fail too.
	if _, err := collector.Submit(Batch{Version: 3, Events: []Event{ev("x", 0, 0, "3")}}); err != nil {
		t.Fatal(err)
	}
	_, err = collector.Submit(Batch{Version: 3, Events: []Event{ev("x", 0, 0, "4")}})
	assertErrIs(t, err, ErrConflict)
}

func TestPendingByteBudget(t *testing.T) {
	// Each single-event batch retains about 50 bytes; the budget fits one
	// buffered batch but not two.
	collector, err := NewCollector(2, 2, 100)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := collector.Submit(Batch{Version: 2, Events: []Event{ev("a", 0, 0, "1")}}); err != nil {
		t.Fatalf("first buffered batch should fit: %v", err)
	}
	_, err = collector.Submit(Batch{Version: 3, Events: []Event{ev("bb", 0, 1, "2")}})
	assertErrIs(t, err, ErrBudgetExceeded)

	// The rejected batch must not be retained.
	if collector.PendingBytes() == 0 {
		t.Fatal("first batch should still be buffered")
	}

	// The in-order next version is never rejected for budget reasons; draining
	// frees the retained bytes.
	if _, err := collector.Submit(Batch{Version: 1, Events: []Event{ev("z", 1, 0, "0")}}); err != nil {
		t.Fatalf("in-order batch rejected: %v", err)
	}
	if collector.NextVersion() != 3 || collector.PendingBytes() != 0 {
		t.Fatalf("after drain next=%d pending=%d", collector.NextVersion(), collector.PendingBytes())
	}
}

func TestCanonicalCSRShape(t *testing.T) {
	collector, err := NewCollector(3, 4, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	_, err = collector.Submit(Batch{Version: 1, Events: []Event{
		ev("q", 2, 3, "7"),
		ev("p", 0, 2, "6"),
		ev("o", 2, 0, "5"),
		ev("n", 0, 0, "4"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	csr := collector.Snapshot(1).CSR

	if csr.Rows != 3 || csr.Cols != 4 {
		t.Fatalf("dimensions = %dx%d", csr.Rows, csr.Cols)
	}
	assertCSR(t, csr,
		[]int{0, 2, 0, 3},
		[]int{0, 2, 2, 4},
		[]string{"4", "6", "5", "7"},
		[]string{"n", "p", "o", "q"})
}

func TestFullVersionReplayReferenceScenario(t *testing.T) {
	// Reference replay through a fresh collector: delete-then-readd, repeated
	// events and a version hole, with explicit zeros surviving alongside.
	collector, err := NewCollector(3, 3, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	// Hole: version 4 arrives first and waits for 1..3.
	if _, err := collector.Submit(Batch{Version: 4, Events: []Event{
		ev("e4", 1, 1, "400"),
	}}); err != nil {
		t.Fatal(err)
	}

	// Version 2: repeated cell reduces by greatest event ID, never sums.
	if _, err := collector.Submit(Batch{Version: 2, Events: []Event{
		ev("id-1", 0, 0, "10"),
		ev("id-2", 0, 0, "20"),
		ev("id-1", 0, 0, "10"),
	}}); err != nil {
		t.Fatal(err)
	}

	// Version 1: value event then a delete on the same cell with a greater ID.
	if _, err := collector.Submit(Batch{Version: 1, Events: []Event{
		ev("e1a", 0, 0, "1"),
		del("e1b", 0, 0),
	}}); err != nil {
		t.Fatal(err)
	}

	// Version 3: explicit zero kept, plus a delete that version 4 will re-add.
	// Version 3 closes the remaining hole after v1/v2; it also drains the
	// already-buffered v4, so two snapshots come back in one call.
	v3, err := collector.Submit(Batch{Version: 3, Events: []Event{
		ev("zero", 2, 2, "0"),
		del("gone", 1, 1),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(v3) != 2 || v3[0].Version != 3 || v3[1].Version != 4 {
		t.Fatalf("v3 submission should commit versions 3 and 4, got %+v", v3)
	}

	// v1 deletes (0,0); v2 re-adds it with winner id-2=20; v3 keeps the zero
	// and leaves (1,1) deleted; v4 then re-adds (1,1).
	v4, err := collector.Submit(Batch{Version: 4, Events: []Event{
		ev("e4", 1, 1, "400"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(v4) != 1 || v4[0] != v3[1] {
		t.Fatalf("unexpected v4 result: %+v", v4)
	}
	assertCSR(t, v4[0].CSR,
		[]int{0, 1, 2},
		[]int{0, 1, 2, 3},
		[]string{"20", "400", "0"},
		[]string{"id-2", "e4", "zero"})

	// Replay every committed version from the stored snapshots: snapshots are
	// cumulative and must match each version's canonical state independently.
	for version, wantValues := range map[int][]string{
		1: {},
		2: {"20"},
		3: {"20", "0"},
		4: {"20", "400", "0"},
	} {
		snapshot := collector.Snapshot(version)
		if snapshot == nil {
			t.Fatalf("missing snapshot for version %d", version)
		}
		if len(snapshot.CSR.Values) != len(wantValues) {
			t.Fatalf("version %d values = %v, want %v", version, snapshot.CSR.Values, wantValues)
		}
		for i, want := range wantValues {
			if snapshot.CSR.Values[i].Cmp(bi(want)) != 0 {
				t.Fatalf("version %d value[%d] = %s, want %s",
					version, i, snapshot.CSR.Values[i], want)
			}
		}
	}

	if collector.NextVersion() != 5 {
		t.Fatalf("next version = %d, want 5", collector.NextVersion())
	}
}

func TestArbitraryPrecisionRoundTrip(t *testing.T) {
	collector, err := NewCollector(1, 1, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	huge := new(big.Int).Lsh(big.NewInt(1), 256)
	huge.Sub(huge, big.NewInt(7))
	if _, err := collector.Submit(Batch{Version: 1, Events: []Event{{
		ID:    []byte("big"),
		Value: huge,
	}}}); err != nil {
		t.Fatal(err)
	}

	snapshot := collector.Snapshot(1)
	if got := snapshot.CSR.Values[0]; got.Cmp(huge) != 0 {
		t.Fatalf("big.Int round trip = %s, want %s", got, huge)
	}

	// Mutating caller-owned inputs must not corrupt collector state.
	huge.SetInt64(0)
	if collector.Snapshot(1).CSR.Values[0].Sign() == 0 {
		t.Fatal("collector retained a mutable reference to caller input")
	}
}

func TestInvalidEventsAndConfig(t *testing.T) {
	collector, err := NewCollector(1, 1, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	_, err = collector.Submit(Batch{Version: 1, Events: []Event{{
		Row: 0, Col: 0, Value: bi("1"),
	}}})
	assertErrIs(t, err, ErrInvalidEvent)

	_, err = collector.Submit(Batch{Version: 1, Events: []Event{{
		ID: []byte("no-value"), Row: 0, Col: 0,
	}}})
	assertErrIs(t, err, ErrInvalidEvent)

	_, err = collector.Submit(Batch{Version: 0, Events: []Event{ev("a", 0, 0, "1")}})
	assertErrIs(t, err, ErrInvalidVersion)

	if _, err := NewCollector(0, 1, 8); err == nil {
		t.Fatal("zero rows should be rejected")
	}
	if _, err := NewCollector(1, 1, 0); err == nil {
		t.Fatal("zero budget should be rejected")
	}
}
