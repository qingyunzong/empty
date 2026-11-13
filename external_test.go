package dataeng_test

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	"example.org/dataeng13/q0037"
)

func mustChunk(t *testing.T, r *dataeng.Reassembler, chunk dataeng.ExternalChunk) []dataeng.Event {
	t.Helper()
	events, err := r.IngestChunk(chunk)
	if err != nil {
		t.Fatalf("IngestChunk(%#v): %v", chunk, err)
	}
	return events
}

func TestExternalValueStaysInvisibleUntilComplete(t *testing.T) {
	r := newReassembler(t, accountsID)
	events := mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Update,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("7"), text("name"), external("large-1"),
		}},
	})
	if len(events) != 0 {
		t.Fatalf("incomplete value produced %d events", len(events))
	}
	if r.PendingChanges() != 1 || r.PendingChunks() != 1 {
		t.Fatalf("pending changes/chunks = %d/%d, want 1/1", r.PendingChanges(), r.PendingChunks())
	}

	// Chunks 0 and 2 arrive first. Chunk 1 is still missing.
	if events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "large-1", Index: 0, Total: 3, Data: []byte("hello "),
	}); len(events) != 0 {
		t.Fatalf("partial value produced %d events", len(events))
	}
	if events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "large-1", Index: 2, Total: 3, Data: []byte("!"),
	}); len(events) != 0 {
		t.Fatalf("value with a gap produced %d events", len(events))
	}
	if r.PendingChanges() != 1 {
		t.Fatalf("change became visible while a chunk was missing")
	}

	events = mustChunk(t, r, dataeng.ExternalChunk{
		ID: "large-1", Index: 1, Total: 3, Data: []byte("world"),
	})
	if len(events) != 1 {
		t.Fatalf("completed value produced %d events, want 1", len(events))
	}
	assertRow(t, events[0].New, &dataeng.Row{
		Columns: []int{0, 1, 2},
		Values:  []dataeng.Value{text("7"), text("name"), text("hello world!")},
	})
	assertRow(t, events[0].Key, &dataeng.Row{
		Columns: []int{0},
		Values:  []dataeng.Value{text("7")},
	})
	if r.PendingChanges() != 0 || r.PendingChunks() != 0 {
		t.Fatalf("pending changes/chunks = %d/%d after completion", r.PendingChanges(), r.PendingChunks())
	}
}

func TestChunkBeforeIdentifierFails(t *testing.T) {
	r := newReassembler(t, accountsID)
	_, err := r.IngestChunk(dataeng.ExternalChunk{
		ID: "not-referenced", Index: 0, Total: 1, Data: []byte("data"),
	})
	wantErr(t, err, dataeng.ErrUnknownExternal)
	if r.PendingChunks() != 0 {
		t.Fatalf("rejected chunk created pending state")
	}
}

func TestChunkValidationAndConflicts(t *testing.T) {
	r := newReassembler(t, accountsID)
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("n"), external("external-a"),
		}},
	})

	valid := dataeng.ExternalChunk{ID: "external-a", Index: 0, Total: 2, Data: []byte("a")}
	if events := mustChunk(t, r, valid); len(events) != 0 {
		t.Fatalf("incomplete external produced an event")
	}
	if events := mustChunk(t, r, valid); len(events) != 0 {
		t.Fatalf("repeated identical chunk produced an event")
	}

	badChunks := []struct {
		name  string
		chunk dataeng.ExternalChunk
		want  error
	}{
		{"empty id", dataeng.ExternalChunk{Index: 0, Total: 1}, dataeng.ErrInvalidChunk},
		{"zero total", dataeng.ExternalChunk{ID: "external-a", Index: 0, Total: 0}, dataeng.ErrInvalidChunk},
		{"negative index", dataeng.ExternalChunk{ID: "external-a", Index: -1, Total: 2}, dataeng.ErrInvalidChunk},
		{"index equals total", dataeng.ExternalChunk{ID: "external-a", Index: 2, Total: 2}, dataeng.ErrInvalidChunk},
		{"external format", dataeng.ExternalChunk{ID: "external-a", Index: 0, Total: 2, Format: dataeng.ValueExternal}, dataeng.ErrInvalidChunk},
		{"changed total", dataeng.ExternalChunk{ID: "external-a", Index: 1, Total: 3, Data: []byte("b")}, dataeng.ErrExternalConflict},
		{"changed format", dataeng.ExternalChunk{ID: "external-a", Index: 1, Total: 2, Format: dataeng.ValueBinary, Data: []byte("b")}, dataeng.ErrExternalConflict},
		{"different duplicate", dataeng.ExternalChunk{ID: "external-a", Index: 0, Total: 2, Data: []byte("different")}, dataeng.ErrExternalConflict},
	}
	for _, tc := range badChunks {
		t.Run(tc.name, func(t *testing.T) {
			_, err := r.IngestChunk(tc.chunk)
			wantErr(t, err, tc.want)
		})
	}

	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "external-a", Index: 1, Total: 2, Data: []byte("b"),
	})
	if len(events) != 1 {
		t.Fatalf("completed external produced %d events, want 1", len(events))
	}
	assertRow(t, events[0].New, &dataeng.Row{
		Columns: []int{0, 1, 2},
		Values:  []dataeng.Value{text("1"), text("n"), text("ab")},
	})
}

func TestExternalBinaryChunks(t *testing.T) {
	r := newReassembler(t, binaryID)
	mustIngest(t, r, dataeng.Change{
		Relation:  binaryID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), external("binary-1"),
		}},
	})
	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "binary-1", Index: 0, Total: 2, Format: dataeng.ValueBinary, Data: []byte{0, 1, 2},
	})
	if len(events) != 0 {
		t.Fatalf("partial binary value produced an event")
	}
	events = mustChunk(t, r, dataeng.ExternalChunk{
		// An unset format inherits the format established by the first chunk.
		ID: "binary-1", Index: 1, Total: 2, Data: []byte{3, 4},
	})
	if len(events) != 1 {
		t.Fatalf("complete binary value produced %d events, want 1", len(events))
	}
	if !bytes.Equal(events[0].New.Values[1].Bytes, []byte{0, 1, 2, 3, 4}) {
		t.Fatalf("binary chunks were not concatenated in index order: %v", events[0].New.Values[1].Bytes)
	}
	if events[0].New.Values[1].Kind != dataeng.ValueBinary {
		t.Fatalf("resolved binary value has kind %d", events[0].New.Values[1].Kind)
	}
}

func TestExternalValueIsValidatedAgainstRelation(t *testing.T) {
	r := newReassembler(t, changingID)
	mustIngest(t, r, dataeng.Change{
		Relation:  changingID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), external("number"),
		}},
	})
	_, err := r.IngestChunk(dataeng.ExternalChunk{
		ID: "number", Index: 0, Total: 1, Data: []byte("not-an-int"),
	})
	wantErr(t, err, dataeng.ErrInvalidValue)
	if r.PendingChanges() != 0 || r.PendingChunks() != 0 {
		t.Fatalf("invalid external value left pending state")
	}
}

func TestPendingTupleUsesRelationSnapshot(t *testing.T) {
	r := newReassembler(t, changingID)
	mustIngest(t, r, dataeng.Change{
		Relation:  changingID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), external("snapshot-number"),
		}},
	})

	replacement := fixture(t, changingID).relation
	replacement.Columns = append([]dataeng.Column(nil), replacement.Columns...)
	replacement.Columns[1].Type = dataeng.TypeBool
	if err := r.AddRelation(replacement); err != nil {
		t.Fatalf("AddRelation: %v", err)
	}

	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "snapshot-number", Index: 0, Total: 1, Data: []byte("42"),
	})
	if len(events) != 1 {
		t.Fatalf("snapshot type rejected a valid int4 value")
	}
	want := fixture(t, changingID).relation
	if !reflect.DeepEqual(events[0].Relation, want) {
		t.Fatalf("event used the replacement relation instead of the arrival snapshot")
	}
}

func TestMultipleExternalReferencesInOneChange(t *testing.T) {
	r := newReassembler(t, accountsID)
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Update,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("new"), external("body-new"),
		}},
		Old: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("old"), external("body-old"),
		}},
		Key: &dataeng.Tuple{Values: []dataeng.Value{text("1")}},
	})

	if events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "body-new", Index: 0, Total: 1, Data: []byte("new body"),
	}); len(events) != 0 {
		t.Fatalf("change became visible with one external value missing")
	}
	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "body-old", Index: 0, Total: 1, Data: []byte("old body"),
	})
	if len(events) != 1 {
		t.Fatalf("complete change produced %d events, want 1", len(events))
	}
	if !bytes.Equal([]byte(events[0].New.Values[2].Text), []byte("new body")) {
		t.Fatalf("new body = %q", events[0].New.Values[2].Text)
	}
	if !bytes.Equal([]byte(events[0].Old.Values[2].Text), []byte("old body")) {
		t.Fatalf("old body = %q", events[0].Old.Values[2].Text)
	}
}

func TestExternalValueMayFeedMultipleChanges(t *testing.T) {
	r := newReassembler(t, accountsID)
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("first"), external("shared"),
		}},
	})
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("2"), text("second"), external("shared"),
		}},
	})
	if r.PendingChanges() != 2 {
		t.Fatalf("pending changes = %d, want 2", r.PendingChanges())
	}

	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "shared", Index: 0, Total: 1, Data: []byte("common body"),
	})
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	if events[0].New.Values[0].Text != "1" || events[1].New.Values[0].Text != "2" {
		t.Fatalf("events were not returned in ingestion order: %#v", []string{
			events[0].New.Values[0].Text, events[1].New.Values[0].Text,
		})
	}
	if events[0].New.Values[2].Text != "common body" || events[1].New.Values[2].Text != "common body" {
		t.Fatalf("shared external value was not resolved for both changes")
	}
}

func TestVisibilityOrderFollowsIngestionOrder(t *testing.T) {
	r := newReassembler(t, accountsID)
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("one"), external("first-body"),
		}},
	})
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("2"), text("two"), external("second-body"),
		}},
	})

	// The second change becomes complete first.
	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "second-body", Index: 0, Total: 1, Data: []byte("second"),
	})
	if len(events) != 1 || events[0].New.Values[0].Text != "2" {
		t.Fatalf("second change did not become visible alone: %#v", events)
	}
	events = mustChunk(t, r, dataeng.ExternalChunk{
		ID: "first-body", Index: 0, Total: 1, Data: []byte("first"),
	})
	if len(events) != 1 || events[0].New.Values[0].Text != "1" {
		t.Fatalf("first change did not become visible after its chunk: %#v", events)
	}
}

func TestExternalChunksInKeyTuple(t *testing.T) {
	r := newReassembler(t, accountsID)
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Delete,
		Key:       &dataeng.Tuple{Values: []dataeng.Value{external("key-id")}},
	})
	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "key-id", Index: 0, Total: 1, Data: []byte("42"),
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	assertRow(t, events[0].Key, &dataeng.Row{
		Columns: []int{0},
		Values:  []dataeng.Value{text("42")},
	})
}

func TestUnknownExternalErrorIsWrapped(t *testing.T) {
	r := newReassembler(t, accountsID)
	_, err := r.IngestChunk(dataeng.ExternalChunk{
		ID: "missing", Index: 0, Total: 1, Data: []byte("x"),
	})
	if !errors.Is(err, dataeng.ErrUnknownExternal) {
		t.Fatalf("got %v, want wrapped ErrUnknownExternal", err)
	}
}

func TestCompletedExternalValueCanBeReusedOrEvicted(t *testing.T) {
	r := newReassembler(t, accountsID)
	first := dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("one"), external("reused-body"),
		}},
	}
	mustIngest(t, r, first)
	events := mustChunk(t, r, dataeng.ExternalChunk{
		ID: "reused-body", Index: 0, Total: 1, Data: []byte("large body"),
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}

	second := first
	second.New = &dataeng.Tuple{Values: []dataeng.Value{
		text("2"), text("two"), external("reused-body"),
	}}
	events = mustIngest(t, r, second)
	if len(events) != 1 {
		t.Fatalf("completed external value was not reusable")
	}
	if events[0].New.Values[2].Text != "large body" {
		t.Fatalf("reused value = %q", events[0].New.Values[2].Text)
	}

	r.EvictExternal("reused-body")
	mustIngest(t, r, second)
	if r.PendingChanges() != 1 {
		t.Fatalf("evicted value was not treated as missing")
	}
	events = mustChunk(t, r, dataeng.ExternalChunk{
		ID: "reused-body", Index: 0, Total: 1, Data: []byte("large body"),
	})
	if len(events) != 1 {
		t.Fatalf("evicted value could not be rebuilt")
	}
}
