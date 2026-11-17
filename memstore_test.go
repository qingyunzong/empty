package formal

import (
	"context"
	"errors"
	"testing"
)

func TestMemStoreConditionalWrites(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)

	first, err := store.Put(ctx, "k", []byte("one"), Condition{IfNoneMatch: true})
	if err != nil {
		t.Fatalf("first put: %v", err)
	}
	if _, err := store.Put(ctx, "k", []byte("two"), Condition{IfNoneMatch: true}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("if-none-match put: got %v, want ErrAlreadyExists", err)
	}

	second, err := store.Put(ctx, "k", []byte("two"), Condition{IfMatch: first.Version})
	if err != nil {
		t.Fatalf("compare-and-swap put: %v", err)
	}
	if _, err := store.Put(ctx, "k", []byte("three"), Condition{IfMatch: first.Version}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale compare-and-swap put: got %v, want ErrPreconditionFailed", err)
	}

	obj, err := store.Get(ctx, "k")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(obj.Data) != "two" || obj.Version != second.Version {
		t.Fatalf("get = %q version %q, want two version %q", obj.Data, obj.Version, second.Version)
	}
}

func TestMemStoreVisibilityDelay(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(2)
	if _, err := store.Put(ctx, "k", []byte("value"), Condition{}); err != nil {
		t.Fatalf("put: %v", err)
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := store.Get(ctx, "k"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("get %d: got %v, want ErrNotFound", attempt, err)
		}
	}
	obj, err := store.Get(ctx, "k")
	if err != nil {
		t.Fatalf("get after delay: %v", err)
	}
	if string(obj.Data) != "value" {
		t.Fatalf("data = %q", obj.Data)
	}

	// A new version may remain invisible while the previous one is still
	// visible to readers.
	if _, err := store.Put(ctx, "k", []byte("next"), Condition{}); err != nil {
		t.Fatalf("second put: %v", err)
	}
	obj, err = store.Get(ctx, "k")
	if err != nil {
		t.Fatalf("get old version: %v", err)
	}
	if string(obj.Data) != "value" {
		t.Fatalf("expected old version while new one lags, got %q", obj.Data)
	}
}
