package logcompact_test

import (
	"errors"
	"testing"

	"logcompact"
)

func TestReaderAcquireRelease(t *testing.T) {
	reg := logcompact.NewReaderRegistry()
	tok := reg.Acquire(42)
	if reg.Active() != 1 {
		t.Fatalf("Active = %d, want 1", reg.Active())
	}
	if min, ok := reg.MinSnapshot(); !ok || min != 42 {
		t.Fatalf("MinSnapshot = %d,%v", min, ok)
	}
	if err := reg.Release(tok); err != nil {
		t.Fatal(err)
	}
	if reg.Active() != 0 {
		t.Fatalf("Active = %d after release", reg.Active())
	}
	if _, ok := reg.MinSnapshot(); ok {
		t.Fatal("MinSnapshot should report none after release")
	}
}

func TestStaleReleaseRejected(t *testing.T) {
	reg := logcompact.NewReaderRegistry()

	// Double release of the same token.
	tok := reg.Acquire(10)
	if err := reg.Release(tok); err != nil {
		t.Fatal(err)
	}
	if err := reg.Release(tok); !errors.Is(err, logcompact.ErrStaleRelease) {
		t.Fatalf("double release: %v", err)
	}

	// Slot recycling: a token from an older generation must not release
	// the newer reader occupying the same slot.
	old := reg.Acquire(20)
	if err := reg.Release(old); err != nil {
		t.Fatal(err)
	}
	cur := reg.Acquire(30)
	if cur.ID != old.ID {
		t.Fatalf("expected slot reuse, old id %d new id %d", old.ID, cur.ID)
	}
	if cur.Generation == old.Generation {
		t.Fatal("generation must bump on reuse")
	}
	if err := reg.Release(old); !errors.Is(err, logcompact.ErrStaleRelease) {
		t.Fatalf("stale release after reuse: %v", err)
	}
	// The current reader must be untouched by the stale release.
	if min, ok := reg.MinSnapshot(); !ok || min != 30 {
		t.Fatalf("MinSnapshot after stale release = %d,%v", min, ok)
	}
	if err := reg.Release(cur); err != nil {
		t.Fatalf("current generation release must succeed: %v", err)
	}
	if reg.Active() != 0 {
		t.Fatalf("Active = %d, want 0", reg.Active())
	}
}

func TestUnknownTokenRejected(t *testing.T) {
	reg := logcompact.NewReaderRegistry()
	bogus := logcompact.ReaderToken{ID: 77, Generation: 1, Snapshot: 5}
	if err := reg.Release(bogus); !errors.Is(err, logcompact.ErrStaleRelease) {
		t.Fatalf("unknown token: %v", err)
	}
}
