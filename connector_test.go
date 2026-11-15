package dataeng

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestConnectorIncrementalPollSavesCheckpoint(t *testing.T) {
	t.Parallel()

	registerFakeDriver()
	db, err := sql.Open("dataeng-fake-cdc", "")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer db.Close()

	reader, err := NewSQLReader(db, "dbo_customers")
	if err != nil {
		t.Fatalf("NewSQLReader() error = %v", err)
	}
	watermark := MustParseLSN("0000002a:0000005c:0001")
	store := NewMemoryStore(State{Watermark: watermark})

	var handled []Change
	connector := Connector{
		Reader:      reader,
		Store:       store,
		ColumnOrder: []string{"id", "name"},
		Handle: func(_ context.Context, batch Batch) error {
			handled = append(handled, batch.Changes...)
			return nil
		},
	}
	batch, err := connector.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if batch.Plan.Action != ActionQuery || len(handled) != 1 {
		t.Fatalf("batch = %#v, handled = %#v", batch, handled)
	}

	saved, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	max := MustParseLSN("0000002a:0000005c:0005")
	if !saved.Watermark.Equal(max) {
		t.Fatalf("saved watermark = %s", saved.Watermark)
	}
}

func TestConnectorTakesSnapshotOnMissingState(t *testing.T) {
	t.Parallel()

	registerFakeDriver()
	db, err := sql.Open("dataeng-fake-cdc", "")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer db.Close()

	reader, err := NewSQLReader(db, "dbo_customers")
	if err != nil {
		t.Fatalf("NewSQLReader() error = %v", err)
	}
	store := NewMemoryStore()
	snapshotLSN := MustParseLSN("0000002a:0000005c:0005")
	snapshotCalls := 0
	connector := Connector{
		Reader: reader,
		Store:  store,
		Snapshot: func(_ context.Context, plan Plan) (LSN, error) {
			snapshotCalls++
			if plan.Action != ActionSnapshot {
				t.Fatalf("snapshot plan action = %s", plan.Action)
			}
			return snapshotLSN, nil
		},
	}

	batch, err := connector.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if batch.Plan.Action != ActionSnapshot || snapshotCalls != 1 {
		t.Fatalf("batch plan = %#v, calls = %d", batch.Plan, snapshotCalls)
	}
	saved, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !saved.Watermark.Equal(snapshotLSN) || !saved.SnapshotLSN.Equal(snapshotLSN) {
		t.Fatalf("state = %#v", saved)
	}

	batch, err = connector.Poll(context.Background())
	if err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if batch.Plan.Action != ActionNoop || snapshotCalls != 1 {
		t.Fatalf("second poll = %#v, calls = %d", batch.Plan, snapshotCalls)
	}
}

func TestConnectorPropagatesSnapshotError(t *testing.T) {
	t.Parallel()

	registerFakeDriver()
	db, err := sql.Open("dataeng-fake-cdc", "")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer db.Close()

	reader, err := NewSQLReader(db, "dbo_customers")
	if err != nil {
		t.Fatalf("NewSQLReader() error = %v", err)
	}
	expected := errors.New("snapshot failed")
	connector := Connector{
		Reader: reader,
		Store:  NewMemoryStore(),
		Snapshot: func(context.Context, Plan) (LSN, error) {
			return nil, expected
		},
	}
	if _, err := connector.Poll(context.Background()); !errors.Is(err, expected) {
		t.Fatalf("Poll() error = %v", err)
	}
}
