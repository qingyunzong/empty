package dataeng_test

import (
	"errors"
	"testing"

	"example.org/dataeng/q0213"
)

func TestUIDValidityRotationOpensGeneration(t *testing.T) {
	st := dataeng.New()

	first, err := st.Select("INBOX", 100)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if _, err := st.Reconcile("INBOX", []dataeng.Message{msg(t, 5, 9, "old")}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	// UIDVALIDITY change: new generation, empty snapshot, forced rescan.
	rotated, err := st.Select("INBOX", 200)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if !rotated.FullRescan || rotated.Generation != first.Generation+1 ||
		rotated.UIDNext != 0 || rotated.HighestModSeq != 0 {
		t.Fatalf("rotation did not reset cursors: %+v", rotated)
	}

	// Old UID 5 is not visible in the new generation and carries no cursor.
	if _, ok := st.Message("INBOX", 5); ok {
		t.Fatal("old generation UID must not leak into the new generation")
	}
	cursor, err := st.Cursor("INBOX")
	if err != nil || cursor.UIDValidity != 200 || cursor.UIDNext != 0 {
		t.Fatalf("cursor reused old generation data: %+v err=%v", cursor, err)
	}

	// A UID that meant something else in the old epoch can be re-fetched.
	if err := st.ApplyFetch("INBOX", msg(t, 5, 1, "brand-new")); err != nil {
		t.Fatalf("fetch in new generation: %v", err)
	}

	// The old generation remains archived with its snapshot and evidence.
	oldView, err := st.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("old generation: %v", err)
	}
	if oldView.UIDValidity != 100 || len(oldView.Messages) != 1 {
		t.Fatalf("old generation not archived: %+v", oldView)
	}
	numbers, err := st.Generations("INBOX")
	if err != nil || len(numbers) != 2 || numbers[0] != 1 || numbers[1] != 2 {
		t.Fatalf("generation history wrong: %v err=%v", numbers, err)
	}
}

func TestUnknownMailboxAndInvalidArgs(t *testing.T) {
	st := dataeng.New()

	if _, err := st.Cursor("missing"); !errors.Is(err, dataeng.ErrUnknownMailbox) {
		t.Fatalf("expected ErrUnknownMailbox, got %v", err)
	}
	if _, err := st.Select("", 1); !errors.Is(err, dataeng.ErrInvalidArgument) {
		t.Fatalf("expected invalid mailbox error, got %v", err)
	}
	if _, err := st.Select("INBOX", 0); !errors.Is(err, dataeng.ErrInvalidArgument) {
		t.Fatalf("expected invalid uidvalidity error, got %v", err)
	}
	if _, err := st.Generation("missing", 1); !errors.Is(err, dataeng.ErrUnknownMailbox) {
		t.Fatalf("expected unknown mailbox, got %v", err)
	}

	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}
	if _, err := st.Generation("INBOX", 9); !errors.Is(err, dataeng.ErrGenerationNotFound) {
		t.Fatalf("expected generation not found, got %v", err)
	}
	if err := st.ApplyFetch("INBOX", dataeng.Message{UID: 1}); !errors.Is(err, dataeng.ErrInvalidArgument) {
		t.Fatalf("expected missing digest error, got %v", err)
	}
}
