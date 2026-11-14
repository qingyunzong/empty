package dataeng

import (
	"context"
	"errors"
	"testing"
)

func testSnapshot(relations ...Relation) Snapshot {
	return Snapshot{
		Database:         "app",
		Slot:             "app_slot",
		ExportedSnapshot: "snapshot-0001",
		ConsistentPoint:  MustParseLSN("0/1000"),
		Relations:        relations,
	}
}

func TestCoordinatorSnapshotThenWAL(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	v2 := usersV2()

	snapshotRows := []SnapshotRow{
		{RelationID: 42, RelationVersion: 1, Row: userRow("1", "alice")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("2", "bob")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("2", "bob")},
	}
	changes := []Change{
		// Covered by the exported snapshot and therefore ignored.
		{LSN: MustParseLSN("0/0900"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("9", "old")},
		{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("3", "carol")},
		{LSN: MustParseLSN("0/1200"), Kind: ChangeUpdate, RelationID: 42, RelationVersion: 1,
			Before: userRow("1", "alice"), After: userRow("1", "alice2")},
		{LSN: MustParseLSN("0/1300"), Kind: ChangeSchema, DDL: &v2},
		{LSN: MustParseLSN("0/1400"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 2, After: userRowV2("4", "dave", "d@example.com")},
		{LSN: MustParseLSN("0/1400"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 2, After: userRowV2("4", "dave", "d@example.com")},
		// A late-decoded tuple from the old relation version must use v1, not v2.
		{LSN: MustParseLSN("0/1500"), Kind: ChangeUpdate, RelationID: 42, RelationVersion: 1,
			Before: userRow("3", "carol"), After: userRow("3", "carol3")},
		{LSN: MustParseLSN("0/1600"), Kind: ChangeDelete, RelationID: 42, RelationVersion: 2,
			Before: Row{"id": TextValue("2")}},
	}
	coordinator, err := NewCoordinator(Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(snapshotRows),
		WALSource:      NewStaticWALSource(changes),
		Sink:           sink,
		BatchSize:      100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); err != nil {
		t.Fatal(err)
	}

	rows := sink.Rows()
	if len(rows) != 3 {
		t.Fatalf("materialized rows = %d, want 3: %#v", len(rows), rows)
	}
	got := make(map[string]Row, len(rows))
	for _, row := range rows {
		got[row.Row["id"].Data] = row.Row
	}
	if got["1"]["name"].Data != "alice2" || got["3"]["name"].Data != "carol3" ||
		got["4"]["email"].Data != "d@example.com" {
		t.Fatalf("unexpected materialized rows: %#v", got)
	}
	if _, exists := got["2"]; exists {
		t.Fatal("deleted row remains")
	}
	if _, exists := got["9"]; exists {
		t.Fatal("change before the consistent point was applied")
	}

	applied := sink.AppliedChanges()
	if len(applied) != 6 {
		t.Fatalf("applied changes = %d, want 6", len(applied))
	}
	for _, change := range applied {
		if change.LSN == MustParseLSN("0/1500") {
			if change.Schema == nil || change.Schema.Version != 1 || len(change.Schema.Columns) != 2 {
				t.Fatalf("old tuple was resolved with the wrong schema: %#v", change.Schema)
			}
		}
		if change.LSN == MustParseLSN("0/1400") && change.Schema.Version != 2 {
			t.Fatal("new tuple was not resolved with version 2")
		}
	}

	state, ok := store.Current()
	if !ok {
		t.Fatal("no checkpoint saved")
	}
	if !state.SnapshotComplete || state.FlushLSN != MustParseLSN("0/1600") {
		t.Fatalf("checkpoint = complete %v flush %s", state.SnapshotComplete, state.FlushLSN)
	}
	if state.SnapshotRows != nil {
		t.Fatal("completed snapshot retained dedup keys")
	}
	if len(state.Relations) != 2 {
		t.Fatalf("checkpoint has %d relation versions, want 2", len(state.Relations))
	}
	if snapshotCalls, changeCalls := sink.Calls(); snapshotCalls != 1 || changeCalls != 1 {
		t.Fatalf("sink calls = %d/%d", snapshotCalls, changeCalls)
	}
}

func TestSnapshotDuplicateConflict(t *testing.T) {
	t.Parallel()
	coordinator, err := NewCoordinator(Config{
		Snapshot: testSnapshot(usersV1()),
		Store:    NewMemoryStore(),
		SnapshotSource: NewStaticSnapshotSource([]SnapshotRow{
			{RelationID: 42, RelationVersion: 1, Row: userRow("1", "alice")},
			{RelationID: 42, RelationVersion: 1, Row: userRow("1", "someone-else")},
		}),
		Sink:      NewMemorySink(),
		BatchSize: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = coordinator.RunSnapshot(context.Background())
	if !errors.Is(err, ErrSnapshotRowConflict) {
		t.Fatalf("error = %v", err)
	}
}

func TestSnapshotRequiresBoundVersionAndFullTuple(t *testing.T) {
	t.Parallel()
	v2 := usersV2()
	tests := []struct {
		name string
		row  SnapshotRow
		want error
	}{
		{
			name: "unknown version",
			row:  SnapshotRow{RelationID: 42, RelationVersion: 2, Row: userRowV2("1", "a", "a@x")},
			want: ErrRelationNotFound,
		},
		{
			name: "missing non-key column",
			row:  SnapshotRow{RelationID: 42, RelationVersion: 1, Row: Row{"id": TextValue("1")}},
			want: ErrInvalidRow,
		},
		{
			name: "extra column",
			row:  SnapshotRow{RelationID: 42, RelationVersion: 1, Row: userRowV2("1", "a", "a@x")},
			want: ErrInvalidRow,
		},
		{
			name: "conflicting supplied schema",
			row:  SnapshotRow{RelationID: 42, RelationVersion: 1, Row: userRow("1", "a"), Schema: &v2},
			want: ErrInvalidRow,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			coordinator, err := NewCoordinator(Config{
				Snapshot:       testSnapshot(usersV1()),
				Store:          NewMemoryStore(),
				SnapshotSource: NewStaticSnapshotSource([]SnapshotRow{test.row}),
				Sink:           NewMemorySink(),
			})
			if err != nil {
				t.Fatal(err)
			}
			err = coordinator.RunSnapshot(context.Background())
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestFlushDoesNotAdvanceWhenSinkFails(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	snapshot := testSnapshot(usersV1())

	snapshotCoordinator, err := NewCoordinator(Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource([]SnapshotRow{{RelationID: 42, RelationVersion: 1, Row: userRow("1", "a")}}),
		Sink:           NewMemorySink(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := snapshotCoordinator.RunSnapshot(ctx); err != nil {
		t.Fatal(err)
	}

	failingSink := SinkFuncs{
		Changes: func(context.Context, []Change) error {
			return ErrSinkNotConfirmed
		},
	}
	coordinator, err := NewCoordinator(Config{
		Snapshot:  snapshot,
		Store:     store,
		WALSource: NewStaticWALSource([]Change{{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("2", "b")}}),
		Sink:      failingSink,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.RunWAL(ctx); !errors.Is(err, ErrSinkNotConfirmed) {
		t.Fatalf("error = %v", err)
	}
	state, err := store.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if state.FlushLSN != state.ConsistentPoint {
		t.Fatalf("flush advanced to %s without sink confirmation", state.FlushLSN)
	}

	sink := NewMemorySink()
	coordinator, err = NewCoordinator(Config{
		Snapshot:  snapshot,
		Store:     store,
		WALSource: NewStaticWALSource([]Change{{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("2", "b")}}),
		Sink:      sink,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.RunWAL(ctx); err != nil {
		t.Fatal(err)
	}
	state, err = store.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if state.FlushLSN != MustParseLSN("0/1100") {
		t.Fatalf("flush = %s", state.FlushLSN)
	}
}

func TestWALRejectsBadChanges(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	snapshot := testSnapshot(usersV1())
	base := func(sink Sink, changes []Change, batchSize int) *Coordinator {
		t.Helper()
		store := NewMemoryStore()
		coordinator, err := NewCoordinator(Config{
			Snapshot:       snapshot,
			Store:          store,
			SnapshotSource: NewStaticSnapshotSource(nil),
			WALSource:      NewStaticWALSource(changes),
			Sink:           sink,
			BatchSize:      batchSize,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := coordinator.RunSnapshot(ctx); err != nil {
			t.Fatal(err)
		}
		return coordinator
	}

	t.Run("non-monotonic", func(t *testing.T) {
		t.Parallel()
		coordinator := base(NewMemorySink(), []Change{
			{LSN: MustParseLSN("0/1200"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")},
			{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("2", "b")},
		}, 10)
		if err := coordinator.RunWAL(ctx); !errors.Is(err, ErrNonMonotonicLSN) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("unknown version", func(t *testing.T) {
		t.Parallel()
		coordinator := base(NewMemorySink(), []Change{
			{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 2, After: userRowV2("1", "a", "a@x")},
		}, 1)
		if err := coordinator.RunWAL(ctx); !errors.Is(err, ErrRelationNotFound) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("unknown column", func(t *testing.T) {
		t.Parallel()
		coordinator := base(NewMemorySink(), []Change{
			{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRowV2("1", "a", "a@x")},
		}, 1)
		if err := coordinator.RunWAL(ctx); !errors.Is(err, ErrInvalidRow) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("future version", func(t *testing.T) {
		t.Parallel()
		registry := NewRelationRegistry()
		v1 := usersV1()
		v2 := usersV2()
		if err := registry.Add(v1, MustParseLSN("0/1000")); err != nil {
			t.Fatal(err)
		}
		if err := registry.Add(v2, MustParseLSN("0/2000")); err != nil {
			t.Fatal(err)
		}
		_, err := prepareChange(Change{
			LSN: MustParseLSN("0/1500"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 2,
			After: userRowV2("1", "a", "a@x"),
		}, registry)
		if !errors.Is(err, ErrFutureRelationVersion) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestSnapshotBindingMismatch(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	snapshot := testSnapshot(usersV1())
	coordinator, err := NewCoordinator(Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		Sink:           NewMemorySink(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.RunSnapshot(ctx); err != nil {
		t.Fatal(err)
	}

	other := snapshot
	other.ExportedSnapshot = "snapshot-0002"
	reopened, err := NewCoordinator(Config{
		Snapshot:       other,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		Sink:           NewMemorySink(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.RunSnapshot(ctx); !errors.Is(err, ErrSnapshotMismatch) {
		t.Fatalf("error = %v", err)
	}
}

func TestRecordLSNFlushDoesNotUseCommitLSN(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	snapshot := testSnapshot(usersV1())
	sink := NewMemorySink()
	coordinator, err := NewCoordinator(Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		WALSource: NewStaticWALSource([]Change{
			{LSN: MustParseLSN("0/1100"), CommitLSN: MustParseLSN("0/1200"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")},
			{LSN: MustParseLSN("0/1150"), CommitLSN: MustParseLSN("0/1200"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("2", "b")},
		}),
		Sink:      sink,
		BatchSize: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); err != nil {
		t.Fatal(err)
	}
	state, err := store.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if state.FlushLSN != MustParseLSN("0/1150") {
		t.Fatalf("flush = %s, want the last record LSN", state.FlushLSN)
	}
	if len(sink.Rows()) != 2 {
		t.Fatalf("rows = %d", len(sink.Rows()))
	}
}

func TestTruncateAndDeleteFallbackTuple(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	snapshot := testSnapshot(usersV1())
	sink := NewMemorySink()
	coordinator, err := NewCoordinator(Config{
		Snapshot: snapshot,
		Store:    NewMemoryStore(),
		SnapshotSource: NewStaticSnapshotSource([]SnapshotRow{
			{RelationID: 42, RelationVersion: 1, Row: userRow("1", "a")},
			{RelationID: 42, RelationVersion: 1, Row: userRow("2", "b")},
		}),
		WALSource: NewStaticWALSource([]Change{
			{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("3", "c")},
			// A delete may carry only the After tuple when the decoder exposes
			// the key there.
			{LSN: MustParseLSN("0/1200"), Kind: ChangeDelete, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")},
			{LSN: MustParseLSN("0/1300"), Kind: ChangeTruncate, RelationID: 42, RelationVersion: 1},
		}),
		Sink: sink,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if rows := sink.Rows(); len(rows) != 0 {
		t.Fatalf("truncate left rows: %#v", rows)
	}
}

func TestSchemaChangeVersionConflict(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	v2 := usersV2()
	changed := usersV2()
	changed.Columns = append(changed.Columns, Column{Name: "phone", Type: "text", Nullable: true})
	coordinator, err := NewCoordinator(Config{
		Snapshot:       testSnapshot(usersV1()),
		Store:          NewMemoryStore(),
		SnapshotSource: NewStaticSnapshotSource(nil),
		WALSource: NewStaticWALSource([]Change{
			{LSN: MustParseLSN("0/1100"), Kind: ChangeSchema, DDL: &v2},
			{LSN: MustParseLSN("0/1200"), Kind: ChangeSchema, DDL: &changed},
		}),
		Sink: NewMemorySink(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); !errors.Is(err, ErrRelationVersionConflict) {
		t.Fatalf("error = %v", err)
	}
}

func TestChangeRejectsCommitBeforeRecordLSN(t *testing.T) {
	t.Parallel()
	registry := NewRelationRegistry()
	if err := registry.Add(usersV1(), MustParseLSN("0/1000")); err != nil {
		t.Fatal(err)
	}
	_, err := prepareChange(Change{
		LSN:             MustParseLSN("0/1200"),
		CommitLSN:       MustParseLSN("0/1100"),
		Kind:            ChangeInsert,
		RelationID:      42,
		RelationVersion: 1,
		After:           userRow("1", "a"),
	}, registry)
	if !errors.Is(err, ErrInvalidChange) {
		t.Fatalf("error = %v", err)
	}
}
