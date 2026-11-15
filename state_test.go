package dataeng_test

import (
	"bytes"
	"testing"

	"example.org/dataeng/q0213"
)

func mustDigest(t *testing.T, body string) dataeng.Digest {
	t.Helper()
	digest, err := dataeng.SHA256Digest(bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	return digest
}

func msg(t *testing.T, uid uint32, modSeq uint64, body string, flags ...string) dataeng.Message {
	t.Helper()
	return dataeng.Message{
		UID:    uid,
		ModSeq: modSeq,
		Digest: mustDigest(t, body),
		Flags:  flags,
	}
}

func TestSelectAndReconcile(t *testing.T) {
	st := dataeng.New()

	sel, err := st.Select("INBOX", 100)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if !sel.FullRescan || sel.Generation != 1 || sel.UIDValidity != 100 {
		t.Fatalf("unexpected first selection: %+v", sel)
	}

	m1 := msg(t, 1, 10, "body-1", `\Seen`)
	m2 := msg(t, 2, 11, "body-2")
	report, err := st.Reconcile("INBOX", []dataeng.Message{m1, m2})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if report.Added != 2 || report.Removed != 0 {
		t.Fatalf("unexpected reconcile report: %+v", report)
	}

	got, ok := st.Message("INBOX", 1)
	if !ok || !got.Digest.Equal(m1.Digest) || len(got.Flags) != 1 {
		t.Fatalf("stored message mismatch: %+v ok=%v", got, ok)
	}

	// Re-selecting the same UIDVALIDITY resumes incrementally.
	sel, err = st.Select("INBOX", 100)
	if err != nil {
		t.Fatalf("reselect: %v", err)
	}
	if sel.FullRescan || sel.Generation != 1 || sel.UIDNext != 3 || sel.HighestModSeq != 11 {
		t.Fatalf("unexpected reselection: %+v", sel)
	}

	// A second reconcile updates an existing UID and tombstones the removed one.
	m1Updated := msg(t, 1, 12, "body-1-v2")
	report, err = st.Reconcile("INBOX", []dataeng.Message{m1Updated})
	if err != nil {
		t.Fatalf("reconcile 2: %v", err)
	}
	if report.Updated != 1 || report.Removed != 1 {
		t.Fatalf("unexpected second report: %+v", report)
	}
	if _, ok := st.Message("INBOX", 2); ok {
		t.Fatal("UID 2 should no longer be live")
	}
	tombstone, ok := st.Tombstone("INBOX", 2)
	if !ok || tombstone.Reason != dataeng.ReasonReconcile || !tombstone.Digest.Equal(m2.Digest) {
		t.Fatalf("missing removal evidence for UID 2: %+v ok=%v", tombstone, ok)
	}
}
