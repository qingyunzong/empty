package formal

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestDecodeJSON(t *testing.T) {
	parts, err := DecodeJSON([]byte(`{"server":"127.0.0.1:8080","workers":4}`))
	if err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if len(parts) != 2 {
		t.Fatalf("got %d parts, want 2", len(parts))
	}
	if parts[0].Name != "server" || parts[0].Value != "127.0.0.1:8080" {
		t.Fatalf("parts[0] = %#v", parts[0])
	}
	if parts[1].Name != "workers" {
		t.Fatalf("parts[1].Name = %q, want workers", parts[1].Name)
	}
	workers, ok := parts[1].Value.(json.Number)
	if !ok || workers.String() != "4" {
		t.Fatalf("workers = %#v (%T), want json.Number(4)", parts[1].Value, parts[1].Value)
	}

	for _, input := range []string{`null`, `[1,2]`, `{} {}`, `{"a":`} {
		if _, err := DecodeJSON([]byte(input)); err == nil {
			t.Errorf("DecodeJSON(%q) succeeded, want error", input)
		}
	}
}

func TestSourceFunc(t *testing.T) {
	m := newTestManager(t)
	source := SourceFunc(func(context.Context) (<-chan Update, error) {
		updates := make(chan Update, 1)
		updates <- Update{Parts: []Part{{Name: "a", Value: "A1"}, {Name: "b", Value: "B1"}}}
		close(updates)
		return updates, nil
	})
	if err := m.Watch(context.Background(), source); err != nil {
		t.Fatalf("Watch: %v", err)
	}
	if got := m.Current().ID(); got != 2 {
		t.Fatalf("current ID = %d, want 2", got)
	}

	if _, err := (SourceFunc(nil)).Watch(context.Background()); err == nil {
		t.Fatal("nil SourceFunc did not return an error")
	}
	if err := m.Watch(context.Background(), nil); err == nil {
		t.Fatal("Watch accepted a nil Source")
	}

	m.ReportRejection(nil, nil)
	if got := m.Stats().Rejected; got != 1 {
		t.Fatalf("Rejected = %d, want 1", got)
	}
	if _, err := (&FileSource{}).Watch(context.Background()); err == nil {
		t.Fatal("FileSource without a path did not return an error")
	}
	sourceErr := errors.New("watch failed")
	err := m.Watch(context.Background(), SourceFunc(func(context.Context) (<-chan Update, error) {
		return nil, sourceErr
	}))
	if !errors.Is(err, sourceErr) {
		t.Fatalf("Watch source error = %v", err)
	}
}
