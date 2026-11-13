package dataeng

import (
	"reflect"
	"testing"
)

func ev(tx string, seq int, digest string) Event {
	return Event{TxID: tx, Seq: seq, Digest: digest}
}

func marked(tx string, seq int, digest string, m Marker) Event {
	return Event{TxID: tx, Seq: seq, Digest: digest, Marker: m}
}

func wantPublished(t *testing.T, got []Event, want []Event) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCommitWithGapPublishesAfterGapFilled(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(marked("t1", 3, "c", MarkerCommit)), nil)
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(ev("t1", 2, "b")), []Event{
		ev("t1", 1, "a"), ev("t1", 2, "b"), ev("t1", 3, "c"),
	})
}

func TestCommitAfterAllEventsPublishesImmediately(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", 2, "b")), nil)
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(marked("t1", 3, "c", MarkerCommit)), []Event{
		ev("t1", 1, "a"), ev("t1", 2, "b"), ev("t1", 3, "c"),
	})
}

func TestAbortDiscardsAndIgnoresLaterEvents(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(marked("t1", 2, "b", MarkerAbort)), nil)
	wantPublished(t, b.Add(ev("t1", 3, "c")), nil)
	wantPublished(t, b.Add(marked("t1", 4, "d", MarkerCommit)), nil)
}

func TestDuplicateSameDigestIgnored(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(marked("t1", 2, "b", MarkerCommit)), []Event{
		ev("t1", 1, "a"), ev("t1", 2, "b"),
	})
}

func TestConflictingDigestFailsTransaction(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(ev("t1", 1, "different")), nil)
	wantPublished(t, b.Add(marked("t1", 2, "b", MarkerCommit)), nil)
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
}

func TestFirstMarkerWinsCommitThenAbort(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(marked("t1", 2, "b", MarkerCommit)), nil)
	wantPublished(t, b.Add(marked("t1", 1, "a", MarkerAbort)), []Event{
		ev("t1", 1, "a"), ev("t1", 2, "b"),
	})
}

func TestFirstMarkerWinsAbortThenCommit(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(marked("t1", 1, "a", MarkerAbort)), nil)
	wantPublished(t, b.Add(marked("t1", 2, "b", MarkerCommit)), nil)
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
}

func TestNoMarkerOnlyRetained(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(ev("t1", 2, "b")), nil)
	wantPublished(t, b.Add(ev("t1", 3, "c")), nil)
}

func TestSeqBelowOneFailsOnlyThatTransaction(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("bad", 1, "a")), nil)
	wantPublished(t, b.Add(ev("bad", 0, "x")), nil)
	wantPublished(t, b.Add(marked("bad", 2, "b", MarkerCommit)), nil)

	wantPublished(t, b.Add(ev("good", 1, "a")), nil)
	wantPublished(t, b.Add(marked("good", 2, "b", MarkerCommit)), []Event{
		ev("good", 1, "a"), ev("good", 2, "b"),
	})
}

func TestNegativeSeqFailsTransaction(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", -3, "x")), nil)
	wantPublished(t, b.Add(marked("t1", 1, "a", MarkerCommit)), nil)
}

func TestPublishedTransactionIgnoresLaterEvents(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(marked("t1", 1, "a", MarkerCommit)), []Event{
		ev("t1", 1, "a"),
	})
	wantPublished(t, b.Add(ev("t1", 2, "b")), nil)
}

func TestTransactionsAreIndependent(t *testing.T) {
	b := NewBuffer()
	wantPublished(t, b.Add(ev("t1", 1, "a")), nil)
	wantPublished(t, b.Add(marked("t2", 1, "x", MarkerCommit)), []Event{
		ev("t2", 1, "x"),
	})
	wantPublished(t, b.Add(marked("t1", 2, "b", MarkerCommit)), []Event{
		ev("t1", 1, "a"), ev("t1", 2, "b"),
	})
}
