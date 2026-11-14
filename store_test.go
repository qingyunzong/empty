package dataeng

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func validTestState(t *testing.T) State {
	t.Helper()
	snapshot := Snapshot{
		Database:         "db",
		Slot:             "slot",
		ExportedSnapshot: "snap",
		ConsistentPoint:  MustParseLSN("0/1000"),
		Relations:        []Relation{usersV1()},
	}
	fingerprint, err := snapshot.Fingerprint()
	if err != nil {
		t.Fatal(err)
	}
	state := newInitialState(snapshot, fingerprint)
	state.SnapshotComplete = true
	state.FlushLSN = MustParseLSN("0/2000")
	state.SnapshotRows = nil
	if err := state.Validate(); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestMemoryStoreRoundTrip(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	if _, err := store.Load(context.Background()); !errors.Is(err, ErrStateNotFound) {
		t.Fatalf("empty load error = %v", err)
	}
	state := validTestState(t)
	if err := store.Save(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if loaded.FlushLSN != state.FlushLSN || !loaded.SnapshotComplete {
		t.Fatalf("loaded state = %#v", loaded)
	}
	loaded.Relations[0].Relation.Columns[0].Name = "mutated"
	current, _ := store.Current()
	if current.Relations[0].Relation.Columns[0].Name != "id" {
		t.Fatal("MemoryStore leaked aliases")
	}
}

func TestFileStateStoreAtomicRoundTrip(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "checkpoint.json")
	store := NewFileStateStore(path)
	if _, err := store.Load(context.Background()); !errors.Is(err, ErrStateNotFound) {
		t.Fatalf("missing file error = %v", err)
	}
	first := validTestState(t)
	first.FlushLSN = MustParseLSN("0/2000")
	if err := store.Save(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.FlushLSN = MustParseLSN("0/3000")
	if err := store.Save(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if loaded.FlushLSN != second.FlushLSN {
		t.Fatalf("flush = %s, want %s", loaded.FlushLSN, second.FlushLSN)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["checksum"] == "" {
		t.Fatal("checkpoint has no checksum")
	}
}

func TestFileStateStoreDetectsCorruption(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "checkpoint.json")
	store := NewFileStateStore(path)
	if err := store.Save(context.Background(), validTestState(t)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var envelope fileEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Checksum = "0000000000000000000000000000000000000000000000000000000000000000"
	corrupted, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, corrupted, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(context.Background()); !errors.Is(err, ErrStateChecksum) {
		t.Fatalf("corrupted load error = %v", err)
	}
}
