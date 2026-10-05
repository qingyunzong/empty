package recovery

import (
	"reflect"
	"testing"
)

func entryIndexes(entries []Entry) []uint64 {
	var out []uint64
	for _, e := range entries {
		out = append(out, e.Index)
	}
	return out
}

func TestLogBufferingDuringInstall(t *testing.T) {
	dir := t.TempDir()
	n, err := NewNode(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Normal traffic before any snapshot is applied immediately.
	n.Append(Entry{Index: 1, Data: []byte("a")})
	n.Append(Entry{Index: 2, Data: []byte("b")})

	// Snapshot covers log through index 4, arrives in two chunks.
	chunks := [][]byte{[]byte("snap-"), []byte("data")}
	if err := n.BeginSnapshot(metaFor(1, 4, chunks)); err != nil {
		t.Fatal(err)
	}
	// New log entries arriving during installation are buffered.
	n.Append(Entry{Index: 3, Data: []byte("c")})
	n.Append(Entry{Index: 4, Data: []byte("d")})
	n.Append(Entry{Index: 5, Data: []byte("e")})
	n.Append(Entry{Index: 6, Data: []byte("f")})
	if got := entryIndexes(n.Applied()); !reflect.DeepEqual(got, []uint64{1, 2}) {
		t.Fatalf("applied during install = %v", got)
	}
	if got := entryIndexes(n.Buffered()); !reflect.DeepEqual(got, []uint64{3, 4, 5, 6}) {
		t.Fatalf("buffered = %v", got)
	}

	n.WriteSnapshotChunk(1, 0, chunks[0])
	n.WriteSnapshotChunk(1, 1, chunks[1])
	if err := n.CompleteSnapshot(1); err != nil {
		t.Fatal(err)
	}
	// Entries 3 and 4 are covered by the snapshot; only 5 and 6 apply.
	if got := entryIndexes(n.Applied()); !reflect.DeepEqual(got, []uint64{1, 2, 5, 6}) {
		t.Fatalf("applied after publish = %v", got)
	}
	if len(n.Buffered()) != 0 {
		t.Fatalf("buffer not drained: %v", n.Buffered())
	}
	idx, ok := n.SnapshotIndex()
	if !ok || idx != 4 {
		t.Fatalf("snapshot index = %d, %v", idx, ok)
	}
	// Post-publish traffic applies immediately; stale entries drop.
	n.Append(Entry{Index: 4, Data: []byte("stale")})
	n.Append(Entry{Index: 7, Data: []byte("g")})
	if got := entryIndexes(n.Applied()); !reflect.DeepEqual(got, []uint64{1, 2, 5, 6, 7}) {
		t.Fatalf("applied final = %v", got)
	}
}

func TestAbortSnapshotAppliesBuffered(t *testing.T) {
	dir := t.TempDir()
	n, _ := NewNode(dir)
	n.BeginSnapshot(metaFor(1, 10, [][]byte{[]byte("x")}))
	n.Append(Entry{Index: 11, Data: []byte("a")})
	n.Append(Entry{Index: 12, Data: []byte("b")})
	if err := n.AbortSnapshot(); err != nil {
		t.Fatal(err)
	}
	if got := entryIndexes(n.Applied()); !reflect.DeepEqual(got, []uint64{11, 12}) {
		t.Fatalf("applied after abort = %v", got)
	}
}

func TestNodeRestartKeepsSnapshotIndex(t *testing.T) {
	dir := t.TempDir()
	n, _ := NewNode(dir)
	chunks := [][]byte{[]byte("payload")}
	n.BeginSnapshot(metaFor(1, 42, chunks))
	n.WriteSnapshotChunk(1, 0, chunks[0])
	if err := n.CompleteSnapshot(1); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewNode(dir)
	if err != nil {
		t.Fatal(err)
	}
	idx, ok := reopened.SnapshotIndex()
	if !ok || idx != 42 {
		t.Fatalf("snapshot index after restart = %d, %v", idx, ok)
	}
	reopened.Append(Entry{Index: 42, Data: []byte("covered")})
	reopened.Append(Entry{Index: 43, Data: []byte("new")})
	if got := entryIndexes(reopened.Applied()); !reflect.DeepEqual(got, []uint64{43}) {
		t.Fatalf("applied after restart = %v", got)
	}
}
