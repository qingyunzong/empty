package dataeng_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"example.org/dataeng/q0213"
)

func TestFileStoreRejectsCorruptSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatalf("write corrupt file: %v", err)
	}

	st := dataeng.New()
	if loaded, err := st.Load(context.Background(), dataeng.NewFileStore(path)); err == nil || loaded {
		t.Fatalf("expected corruption error, loaded=%v err=%v", loaded, err)
	}
}

func TestTombstoneRefreshesAndPreservesDigest(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}

	// Vanish before fetch: no digest evidence yet.
	if err := st.ApplyVanished("INBOX", 9, 30, true); err != nil {
		t.Fatalf("vanish: %v", err)
	}
	// A later expunge for the same UID updates the reason without inventing
	// a digest.
	if err := st.ApplyExpunge("INBOX", 9, 31); err != nil {
		t.Fatalf("expunge: %v", err)
	}
	tombstone, ok := st.Tombstone("INBOX", 9)
	if !ok || tombstone.Reason != dataeng.ReasonExpunge || tombstone.Earlier ||
		!tombstone.Digest.IsZero() || tombstone.ModSeq != 31 {
		t.Fatalf("tombstone refresh wrong: %+v ok=%v", tombstone, ok)
	}

	// A fetched-then-removed UID keeps its body digest even if a second
	// removal event arrives later.
	if err := st.ApplyFetch("INBOX", msg(t, 8, 40, "keep-me")); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if err := st.ApplyExpunge("INBOX", 8, 41); err != nil {
		t.Fatalf("expunge: %v", err)
	}
	if err := st.ApplyVanished("INBOX", 8, 42, false); err != nil {
		t.Fatalf("vanish: %v", err)
	}
	tombstone, ok = st.Tombstone("INBOX", 8)
	if !ok || tombstone.Reason != dataeng.ReasonVanished ||
		!tombstone.Digest.Equal(mustDigest(t, "keep-me")) || tombstone.ModSeq != 42 {
		t.Fatalf("digest not preserved across refresh: %+v ok=%v", tombstone, ok)
	}
}

func TestMailboxesAreIsolated(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select inbox: %v", err)
	}
	if _, err := st.Select("Sent", 200); err != nil {
		t.Fatalf("select sent: %v", err)
	}

	if err := st.ApplyFetch("INBOX", msg(t, 1, 10, "inbox-body")); err != nil {
		t.Fatalf("inbox fetch: %v", err)
	}
	if err := st.ApplyFetch("Sent", msg(t, 1, 20, "sent-body")); err != nil {
		t.Fatalf("sent fetch: %v", err)
	}

	inbox, _ := st.Message("INBOX", 1)
	sent, _ := st.Message("Sent", 1)
	if !inbox.Digest.Equal(mustDigest(t, "inbox-body")) ||
		!sent.Digest.Equal(mustDigest(t, "sent-body")) ||
		inbox.Digest.Equal(sent.Digest) {
		t.Fatalf("mailbox state leaked between mailboxes: %+v %+v", inbox, sent)
	}

	if err := st.ApplyExpunge("INBOX", 1, 11); err != nil {
		t.Fatalf("inbox expunge: %v", err)
	}
	if _, ok := st.Tombstone("Sent", 1); ok {
		t.Fatal("inbox tombstone leaked into Sent")
	}
	if _, ok := st.Message("Sent", 1); !ok {
		t.Fatal("Sent message affected by inbox expunge")
	}
}

func TestReconcileRejectsDuplicates(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}
	_, err := st.Reconcile("INBOX", []dataeng.Message{
		msg(t, 1, 10, "a"),
		msg(t, 1, 11, "b"),
	})
	if err == nil {
		t.Fatal("expected duplicate UID rejection")
	}
	// A failed reconciliation must not mutate state.
	if len(st.Mailboxes()) != 1 {
		t.Fatal("mailbox set changed after failed reconcile")
	}
	view, err := st.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if len(view.Messages) != 0 || view.Initialized {
		t.Fatalf("state mutated after failed reconcile: %+v", view)
	}
}
