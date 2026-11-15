package dataeng_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"example.org/dataeng/q0213"
)

func TestSHA256Digest(t *testing.T) {
	body := []byte("the quick brown fox")
	digest, err := dataeng.SHA256Digest(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("digest: %v", err)
	}

	sum := sha256.Sum256(body)
	if digest.Alg != "sha256" || digest.Hex != hex.EncodeToString(sum[:]) || digest.Size != int64(len(body)) {
		t.Fatalf("digest mismatch: %+v", digest)
	}

	again, _ := dataeng.SHA256Digest(bytes.NewReader(body))
	if !digest.Equal(again) || digest.IsZero() {
		t.Fatal("digest equality/zero helpers broken")
	}

	other, _ := dataeng.SHA256Digest(bytes.NewReader([]byte("different body")))
	if digest.Equal(other) {
		t.Fatal("distinct bodies produced equal digests")
	}
}

func TestCursorMonotonicAndMailboxListing(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}

	cursor, err := st.SyncCursor("INBOX", 10, 50)
	if err != nil || cursor.UIDNext != 10 || cursor.HighestModSeq != 50 {
		t.Fatalf("initial cursor wrong: %+v err=%v", cursor, err)
	}
	// Cursors only move forward; smaller observed values are clamped.
	cursor, err = st.SyncCursor("INBOX", 4, 20)
	if err != nil || cursor.UIDNext != 10 || cursor.HighestModSeq != 50 {
		t.Fatalf("cursor moved backwards: %+v err=%v", cursor, err)
	}

	// Fetching a high UID raises UIDNext even without an explicit sync.
	if err := st.ApplyFetch("INBOX", msg(t, 42, 60, "x")); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	cursor, err = st.Cursor("INBOX")
	if err != nil || cursor.UIDNext != 43 || cursor.HighestModSeq != 60 {
		t.Fatalf("cursor did not follow fetch: %+v err=%v", cursor, err)
	}

	if _, err := st.Select("Sent", 55); err != nil {
		t.Fatalf("select sent: %v", err)
	}
	if names := st.Mailboxes(); len(names) != 2 || names[0] != "INBOX" || names[1] != "Sent" {
		t.Fatalf("mailbox listing wrong: %v", names)
	}
}
