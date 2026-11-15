package dataeng

import (
	"context"
	"errors"
	"testing"
)

func TestPollTreatsFetchFailureAsIncomplete(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 1, MaxRecheckCycles: 1})
	d.ObserveComplete([]ID{"a"})

	calls := 0
	fetch := func(context.Context) (Listing, error) {
		calls++
		return Listing{}, errors.New("temporary upstream failure")
	}

	if _, err := d.Poll(context.Background(), fetch); err == nil {
		t.Fatal("Poll hid the fetch error")
	}
	if calls != 1 {
		t.Fatalf("fetch calls = %d, want 1", calls)
	}
	if stats := d.Stats(); stats.Deleted != 0 || stats.Generation != 1 || stats.IncompleteObservations != 1 {
		t.Fatalf("unexpected stats after failed poll: %+v", stats)
	}
}

func TestPollAcceptsIncompleteListing(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 1, MaxRecheckCycles: 1})
	d.ObserveComplete([]ID{"a"})

	fetch := func(context.Context) (Listing, error) {
		return Listing{Complete: false}, nil
	}
	events, err := d.Poll(context.Background(), fetch)
	if err != nil {
		t.Fatalf("Poll returned an error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("incomplete listing produced events: %+v", events)
	}
	if stats := d.Stats(); stats.Generation != 1 || stats.IncompleteObservations != 1 {
		t.Fatalf("unexpected stats after incomplete poll: %+v", stats)
	}
}
