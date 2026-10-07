package fakestore_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"example.com/synclib"
	"example.com/synclib/fakestore"
)

func rec() synclib.Record {
	return synclib.Record{
		ID:     "id-1",
		Fields: map[string]string{"a": "1", "b": "2"},
		Attachments: []synclib.Attachment{
			{Name: "x", Data: []byte("x")},
			{Name: "y", Data: []byte("y")},
		},
	}
}

func TestPartialWriteInjection(t *testing.T) {
	store := fakestore.New()
	injected := errors.New("injected")
	store.Partials = []fakestore.PartialWrite{{
		OnCall:          1,
		DropFields:      []string{"b"},
		DropAttachments: []string{"y"},
		Err:             injected,
	}}
	ctx := context.Background()

	if _, err := store.Write(ctx, rec()); !errors.Is(err, injected) {
		t.Fatalf("want injected error, got %v", err)
	}
	got, _, err := store.Read(ctx, "id-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got.Fields["b"]; ok {
		t.Fatal("field b should have been dropped")
	}
	if len(got.Attachments) != 1 || got.Attachments[0].Name != "x" {
		t.Fatalf("attachment y should have been dropped: %+v", got.Attachments)
	}

	// Second write is unaffected by the OnCall: 1 injection.
	if _, err := store.Write(ctx, rec()); err != nil {
		t.Fatal(err)
	}
	got, _, _ = store.Read(ctx, "id-1")
	if got.Fields["b"] != "2" || len(got.Attachments) != 2 {
		t.Fatalf("second write should be complete: %+v", got)
	}
}

func TestDelayedReadBack(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := fakestore.New()
	store.SetClock(func() time.Time { return now })
	store.ConsistencyWindow = 30 * time.Second
	ctx := context.Background()

	receipt, err := store.Write(ctx, rec())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Read(ctx, "id-1"); !errors.Is(err, synclib.ErrNotFound) {
		t.Fatalf("read within consistency window must be stale, got %v", err)
	}
	now = now.Add(31 * time.Second)
	got, gotReceipt, err := store.Read(ctx, "id-1")
	if err != nil {
		t.Fatal(err)
	}
	if gotReceipt != receipt {
		t.Fatalf("receipt mismatch: %+v vs %+v", gotReceipt, receipt)
	}
	if got.Fields["a"] != "1" {
		t.Fatalf("delayed record not visible: %+v", got)
	}
}
