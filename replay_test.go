package dataeng_test

import (
	"testing"

	"example.org/dataeng/q0213"
)

func TestReplayOutOfOrderConverges(t *testing.T) {
	events := []dataeng.Event{
		{Kind: dataeng.EventFetch, UID: 1, ModSeq: 10, Message: msg(t, 1, 10, "a")},
		{Kind: dataeng.EventFetch, UID: 2, ModSeq: 11, Message: msg(t, 2, 11, "b")},
		{Kind: dataeng.EventVanished, UID: 1, ModSeq: 12},
		// Out of order: the fetch that revives UID 1 arrives before the
		// vanish event in the wire sequence but has a higher MODSEQ.
		{Kind: dataeng.EventFetch, UID: 1, ModSeq: 13, Message: msg(t, 1, 13, "a-v2")},
		{Kind: dataeng.EventExpunge, UID: 2, ModSeq: 14},
		{Kind: dataeng.EventFetch, UID: 3, ModSeq: 15, Message: msg(t, 3, 15, "c")},
	}

	shuffled := buildReplayState(t, []dataeng.Event{
		events[5], events[2], events[4], events[0], events[3], events[1],
	})
	ordered := buildReplayState(t, events)

	shuffledView, err := shuffled.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("shuffled view: %v", err)
	}
	orderedView, err := ordered.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("ordered view: %v", err)
	}

	if len(shuffledView.Messages) != 2 {
		t.Fatalf("expected UID 1 and 3 live, got %+v", shuffledView.Messages)
	}
	if live, ok := shuffled.Message("INBOX", 1); !ok || live.ModSeq != 13 ||
		!live.Digest.Equal(mustDigest(t, "a-v2")) {
		t.Fatalf("UID 1 should be revived at MODSEQ 13: %+v", live)
	}
	if _, ok := shuffled.Message("INBOX", 2); ok {
		t.Fatal("UID 2 should be expunged")
	}
	if tombstone, ok := shuffled.Tombstone("INBOX", 2); !ok ||
		tombstone.Reason != dataeng.ReasonExpunge || tombstone.ModSeq != 14 {
		t.Fatalf("UID 2 tombstone wrong: %+v", tombstone)
	}

	if !viewsEqual(shuffledView, orderedView) {
		t.Fatalf("out-of-order replay did not converge:\nshuffled=%+v\nordered=%+v",
			shuffledView, orderedView)
	}

	// Replay against the complete listing must produce the same live set and
	// retain removal evidence.
	reconciled := dataeng.New()
	if _, err := reconciled.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}
	full := []dataeng.Message{msg(t, 1, 13, "a-v2"), msg(t, 3, 15, "c")}
	if _, err := reconciled.Reconcile("INBOX", full); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	reconView, err := reconciled.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("reconcile view: %v", err)
	}
	if !liveViewsEqual(shuffledView, reconView) {
		t.Fatalf("replay and full listing disagree:\nreplay=%+v\nreconcile=%+v",
			shuffledView, reconView)
	}
}

func TestReplaySkipsStaleFetchAndValidates(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}

	// Once MODSEQ 20 is already known, a directly applied out-of-order
	// MODSEQ 10 fetch must be ignored rather than downgrading the state.
	if err := st.ApplyFetch("INBOX", msg(t, 1, 20, "new")); err != nil {
		t.Fatalf("seed fetch: %v", err)
	}
	if err := st.ApplyFetch("INBOX", msg(t, 1, 10, "stale")); err != nil {
		t.Fatalf("stale fetch: %v", err)
	}
	if live, ok := st.Message("INBOX", 1); !ok || live.ModSeq != 20 ||
		!live.Digest.Equal(mustDigest(t, "new")) {
		t.Fatalf("stale direct fetch changed state: %+v ok=%v", live, ok)
	}

	report, err := st.Replay("INBOX", []dataeng.Event{
		{Kind: dataeng.EventFetch, UID: 2, ModSeq: 20, Message: msg(t, 2, 20, "new-2")},
		{Kind: dataeng.EventFetch, UID: 1, ModSeq: 10, Message: msg(t, 1, 10, "stale")},
	})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	// Sorted replay applies MODSEQ 10 first then 20, so nothing is stale at
	// application time. Here UID 1 already sits at MODSEQ 20 from the seed,
	// so its sorted MODSEQ 10 event is skipped while UID 2 is applied.
	if report.Applied != 1 || report.Skipped != 1 {
		t.Fatalf("unexpected replay report: %+v", report)
	}
	live, ok := st.Message("INBOX", 1)
	if !ok || live.ModSeq != 20 || !live.Digest.Equal(mustDigest(t, "new")) {
		t.Fatalf("replay did not converge on newest state: %+v ok=%v", live, ok)
	}

	if _, err := st.Replay("INBOX", []dataeng.Event{{Kind: "bogus", UID: 1}}); err == nil {
		t.Fatal("expected invalid event kind error")
	}
	if _, err := st.Replay("INBOX", []dataeng.Event{
		{Kind: dataeng.EventFetch, UID: 2, Message: dataeng.Message{UID: 3}},
	}); err == nil {
		t.Fatal("expected UID mismatch validation error")
	}
}

func buildReplayState(t *testing.T, events []dataeng.Event) *dataeng.State {
	t.Helper()
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}
	report, err := st.Replay("INBOX", events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if report.HighestModSeq != 15 || report.UIDNext != 4 {
		t.Fatalf("cursors not advanced by replay: %+v", report)
	}
	return st
}

func viewsEqual(a, b dataeng.GenerationView) bool {
	return liveViewsEqual(a, b) && tombstonesEqual(a.Tombstones, b.Tombstones)
}

func liveViewsEqual(a, b dataeng.GenerationView) bool {
	if a.UIDValidity != b.UIDValidity || a.UIDNext != b.UIDNext ||
		a.HighestModSeq != b.HighestModSeq || len(a.Messages) != len(b.Messages) {
		return false
	}
	for i := range a.Messages {
		left, right := a.Messages[i], b.Messages[i]
		if left.UID != right.UID || left.ModSeq != right.ModSeq ||
			!left.Digest.Equal(right.Digest) {
			return false
		}
	}
	return true
}

func tombstonesEqual(a, b []dataeng.Tombstone) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].UID != b[i].UID || a[i].ModSeq != b[i].ModSeq ||
			a[i].Reason != b[i].Reason || !a[i].Digest.Equal(b[i].Digest) {
			return false
		}
	}
	return true
}
