package dataeng_test

import (
	"errors"
	"testing"

	"example.org/dataeng/q0213"
)

func TestExpungeAndVanishedKeepEvidence(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}

	if err := st.ApplyFetch("INBOX", msg(t, 1, 10, "one")); err != nil {
		t.Fatalf("fetch 1: %v", err)
	}
	if err := st.ApplyFetch("INBOX", msg(t, 2, 11, "two")); err != nil {
		t.Fatalf("fetch 2: %v", err)
	}

	if err := st.ApplyExpunge("INBOX", 1, 12); err != nil {
		t.Fatalf("expunge: %v", err)
	}
	if err := st.ApplyVanished("INBOX", 2, 13, true); err != nil {
		t.Fatalf("vanished: %v", err)
	}

	tombstone1, ok := st.Tombstone("INBOX", 1)
	if !ok || tombstone1.Reason != dataeng.ReasonExpunge || tombstone1.ModSeq != 12 ||
		!tombstone1.Digest.Equal(mustDigest(t, "one")) {
		t.Fatalf("expunge tombstone wrong: %+v", tombstone1)
	}
	tombstone2, ok := st.Tombstone("INBOX", 2)
	if !ok || tombstone2.Reason != dataeng.ReasonVanished || !tombstone2.Earlier ||
		tombstone2.ModSeq != 13 {
		t.Fatalf("vanished tombstone wrong: %+v", tombstone2)
	}

	// A removal for a never-fetched UID still leaves evidence.
	if err := st.ApplyVanished("INBOX", 99, 14, false); err != nil {
		t.Fatalf("vanish unseen: %v", err)
	}
	if tombstone, ok := st.Tombstone("INBOX", 99); !ok ||
		!tombstone.Digest.IsZero() || tombstone.Reason != dataeng.ReasonVanished {
		t.Fatalf("unseen UID removal evidence wrong: %+v ok=%v", tombstone, ok)
	}

	// Direct fetch of a tombstoned UID is rejected within a generation.
	if err := st.ApplyFetch("INBOX", msg(t, 1, 15, "reborn")); !errors.Is(err, dataeng.ErrInvalidArgument) {
		t.Fatalf("expected ErrInvalidArgument for tombstoned fetch, got %v", err)
	}

	// The highest MODSEQ cursor tracks removals too.
	cursor, err := st.Cursor("INBOX")
	if err != nil || cursor.HighestModSeq != 14 {
		t.Fatalf("cursor did not track removal modseq: %+v err=%v", cursor, err)
	}
}
