package dataeng

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
)

var errInjectedCrash = errors.New("injected crash")

type crashStore struct {
	inner  *MemoryStore
	mu     sync.Mutex
	failAt int
	saves  int
}

func (s *crashStore) Load(ctx context.Context) (State, error) { return s.inner.Load(ctx) }

func (s *crashStore) Save(ctx context.Context, state State) error {
	s.mu.Lock()
	s.saves++
	if s.failAt > 0 && s.saves == s.failAt {
		s.mu.Unlock()
		return errInjectedCrash
	}
	s.mu.Unlock()
	return s.inner.Save(ctx, state)
}

func (s *crashStore) disarm() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failAt = 0
}

type crashAfterWALStore struct {
	inner  *MemoryStore
	mu     sync.Mutex
	failed bool
}

func (s *crashAfterWALStore) Load(ctx context.Context) (State, error) { return s.inner.Load(ctx) }

func (s *crashAfterWALStore) Save(ctx context.Context, state State) error {
	s.mu.Lock()
	if !s.failed && state.SnapshotComplete && state.FlushLSN > state.ConsistentPoint {
		s.failed = true
		s.mu.Unlock()
		return errInjectedCrash
	}
	s.mu.Unlock()
	return s.inner.Save(ctx, state)
}

func (s *crashAfterWALStore) disarm() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failed = true
}

func TestRecoverSnapshotCrashAtAnyBatch(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	inner := NewMemoryStore()
	store := &crashStore{inner: inner, failAt: 2}
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	rows := []SnapshotRow{
		{RelationID: 42, RelationVersion: 1, Row: userRow("1", "a")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("2", "b")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("3", "c")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("4", "d")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("5", "e")},
	}
	config := Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(rows),
		Sink:           sink,
		BatchSize:      2,
	}
	coordinator, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.RunSnapshot(ctx); !errors.Is(err, errInjectedCrash) {
		t.Fatalf("first run error = %v", err)
	}
	if len(sink.Rows()) != 2 {
		t.Fatalf("sink confirmed %d rows before crash, want 2", len(sink.Rows()))
	}
	persisted, err := inner.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.SnapshotComplete {
		t.Fatal("crash checkpoint unexpectedly marked snapshot complete")
	}

	store.disarm()
	config.Store = store
	recovered, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := recovered.RunSnapshot(ctx); err != nil {
		t.Fatal(err)
	}
	if got := len(sink.Rows()); got != len(rows) {
		t.Fatalf("rows after recovery = %d, want %d", got, len(rows))
	}
	state, err := inner.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !state.SnapshotComplete || state.FlushLSN != state.ConsistentPoint {
		t.Fatalf("state after recovery = complete %v flush %s", state.SnapshotComplete, state.FlushLSN)
	}
}

func TestRecoverWALCrashAfterSinkConfirmation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	inner := NewMemoryStore()
	store := &crashAfterWALStore{inner: inner}
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	changes := []Change{
		{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")},
		{LSN: MustParseLSN("0/1200"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("2", "b")},
		{LSN: MustParseLSN("0/1300"), Kind: ChangeUpdate, RelationID: 42, RelationVersion: 1,
			Before: userRow("1", "a"), After: userRow("1", "a2")},
	}
	config := Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		WALSource:      NewStaticWALSource(changes),
		Sink:           sink,
		BatchSize:      2,
	}
	coordinator, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); !errors.Is(err, errInjectedCrash) {
		t.Fatalf("first run error = %v", err)
	}
	persisted, err := inner.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.FlushLSN != persisted.ConsistentPoint {
		t.Fatalf("flush advanced despite failed checkpoint: %s", persisted.FlushLSN)
	}

	store.disarm()
	recovered, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := recovered.Run(ctx); err != nil {
		t.Fatal(err)
	}
	rows := sink.Rows()
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	for _, row := range rows {
		if row.Row["id"].Data == "1" && row.Row["name"].Data != "a2" {
			t.Fatalf("row 1 not recovered to final state: %#v", row.Row)
		}
	}
	state, err := inner.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if state.FlushLSN != MustParseLSN("0/1300") {
		t.Fatalf("flush = %s", state.FlushLSN)
	}
}

func TestRecoverMidTransactionWithoutSkippingRemainingChanges(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	inner := NewMemoryStore()
	// Save 1 creates the initial checkpoint, save 2 completes the snapshot,
	// save 3 persists the first WAL record, and save 4 is the first checkpoint
	// after a WAL record that is allowed to fail.
	store := &crashStore{inner: inner, failAt: 4}
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	changes := []Change{
		{LSN: MustParseLSN("0/1100"), CommitLSN: MustParseLSN("0/1200"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")},
		{LSN: MustParseLSN("0/1150"), CommitLSN: MustParseLSN("0/1200"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("2", "b")},
	}
	config := Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		WALSource:      NewStaticWALSource(changes),
		Sink:           sink,
		BatchSize:      1,
	}
	coordinator, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); !errors.Is(err, errInjectedCrash) {
		t.Fatalf("first run error = %v", err)
	}
	persisted, err := inner.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.FlushLSN != MustParseLSN("0/1100") {
		t.Fatalf("flush = %s, want first record LSN not commit LSN", persisted.FlushLSN)
	}
	store.disarm()
	recovered, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := recovered.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sink.Rows()) != 2 {
		t.Fatalf("rows after recovery = %d, want 2", len(sink.Rows()))
	}
	applied := sink.AppliedChanges()
	if len(applied) != 2 {
		t.Fatalf("applied unique changes = %d, want 2", len(applied))
	}
}

func TestDuplicateChangeLSNIsAppliedOnce(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	insert := Change{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")}
	config := Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		WALSource:      NewStaticWALSource([]Change{insert, insert}),
		Sink:           sink,
	}
	coordinator, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sink.AppliedChanges()) != 1 {
		t.Fatalf("duplicate LSN applied %d times", len(sink.AppliedChanges()))
	}
}

func TestCheckpointReplayAfterCrashDoesNotLoseSnapshotRows(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	inner := NewMemoryStore()
	store := &crashStore{inner: inner, failAt: 3}
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	rows := []SnapshotRow{
		{RelationID: 42, RelationVersion: 1, Row: userRow("1", "a")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("2", "b")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("3", "c")},
	}
	config := Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(rows),
		Sink:           sink,
		BatchSize:      1,
	}
	coordinator, _ := NewCoordinator(config)
	if err := coordinator.RunSnapshot(ctx); !errors.Is(err, errInjectedCrash) {
		t.Fatalf("first run error = %v", err)
	}
	store.disarm()
	recovered, err := NewCoordinator(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := recovered.RunSnapshot(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sink.Rows()) != 3 {
		t.Fatalf("rows after recovery = %d", len(sink.Rows()))
	}
	state, err := inner.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !state.SnapshotComplete {
		t.Fatal("snapshot did not complete after recovery")
	}
}

func TestRecoverFromEverySnapshotCheckpointBoundary(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	rows := []SnapshotRow{
		{RelationID: 42, RelationVersion: 1, Row: userRow("1", "a")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("2", "b")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("3", "c")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("4", "d")},
		{RelationID: 42, RelationVersion: 1, Row: userRow("5", "e")},
	}
	// Initial checkpoint, three batches, and the completion checkpoint.
	for failAt := 2; failAt <= 5; failAt++ {
		failAt := failAt
		t.Run("save-"+strconv.Itoa(failAt), func(t *testing.T) {
			t.Parallel()
			inner := NewMemoryStore()
			store := &crashStore{inner: inner, failAt: failAt}
			sink := NewMemorySink()
			config := Config{
				Snapshot:       testSnapshot(usersV1()),
				Store:          store,
				SnapshotSource: NewStaticSnapshotSource(rows),
				Sink:           sink,
				BatchSize:      2,
			}
			coordinator, err := NewCoordinator(config)
			if err != nil {
				t.Fatal(err)
			}
			if err := coordinator.RunSnapshot(ctx); !errors.Is(err, errInjectedCrash) {
				t.Fatalf("run error = %v", err)
			}
			store.disarm()
			recovered, err := NewCoordinator(config)
			if err != nil {
				t.Fatal(err)
			}
			if err := recovered.RunSnapshot(ctx); err != nil {
				t.Fatal(err)
			}
			if got := len(sink.Rows()); got != len(rows) {
				t.Fatalf("rows = %d, want %d", got, len(rows))
			}
			state, err := inner.Load(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !state.SnapshotComplete || state.FlushLSN != state.ConsistentPoint {
				t.Fatalf("state = complete %v flush %s", state.SnapshotComplete, state.FlushLSN)
			}
		})
	}
}

func TestStateRejectsInvalidShapes(t *testing.T) {
	t.Parallel()
	valid := validTestState(t)
	cases := []State{
		{},
		func() State { s := valid; s.FormatVersion = 99; return s }(),
		func() State { s := valid; s.FlushLSN = MustParseLSN("0/0900"); return s }(),
		func() State { s := valid; s.SnapshotComplete = false; return s }(),
		func() State {
			s := valid
			s.Relations = append(s.Relations, RelationEntry{Relation: usersV1(), EffectiveLSN: MustParseLSN("0/1000")})
			return s
		}(),
	}
	for i, state := range cases {
		if err := state.Validate(); !errors.Is(err, ErrInvalidState) {
			t.Fatalf("state %d error = %v", i, err)
		}
	}
}

func TestFileCheckpointSurvivesCoordinatorRestart(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	path := t.TempDir() + "/nested/checkpoint.json"
	store := NewFileStateStore(path)
	sink := NewMemorySink()
	snapshot := testSnapshot(usersV1())
	changes := []Change{
		{LSN: MustParseLSN("0/1100"), Kind: ChangeInsert, RelationID: 42, RelationVersion: 1, After: userRow("1", "a")},
	}
	config := Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource([]SnapshotRow{{RelationID: 42, RelationVersion: 1, Row: userRow("2", "b")}}),
		WALSource:      NewStaticWALSource(changes),
		Sink:           sink,
		BatchSize:      1,
	}
	coordinator, err := NewCoordinator(config)
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
	if state.FlushLSN != MustParseLSN("0/1100") {
		t.Fatalf("flush = %s", state.FlushLSN)
	}
	if !strings.Contains(string(mustReadFile(t, path)), "snapshot-0001") {
		t.Fatal("checkpoint does not record the exported snapshot binding")
	}

	// A new coordinator must bind to the same snapshot and resume from the
	// durable flush position rather than rescanning or rewinding.
	reopenedSink := NewMemorySink()
	reopened, err := NewCoordinator(Config{
		Snapshot:       snapshot,
		Store:          store,
		SnapshotSource: NewStaticSnapshotSource(nil),
		WALSource:      NewStaticWALSource(changes),
		Sink:           reopenedSink,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if calls := reopenedSink.AppliedChanges(); len(calls) != 0 {
		t.Fatalf("reopened coordinator replayed %d flushed changes", len(calls))
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
