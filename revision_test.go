package dataeng

import (
	"context"
	"testing"
	"time"
)

func TestRevisionTrackerObserveAndConfirm(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewRevisionTracker(store)
	tracker.Now = func() time.Time {
		return time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	ctx := context.Background()
	url := "https://example.com/a"
	lastMod := time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)

	decision, err := tracker.Observe(ctx, url, []byte("body"), lastMod)
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Publish || !decision.FirstSeen {
		t.Fatalf("decision = %#v", decision)
	}
	if err := tracker.Confirm(ctx, decision); err != nil {
		t.Fatal(err)
	}
	record, ok, err := store.Get(ctx, url)
	if err != nil || !ok {
		t.Fatalf("record=%#v ok=%v err=%v", record, ok, err)
	}
	if !record.Confirmed || record.Revision != 1 {
		t.Fatalf("record = %#v", record)
	}

	decision, err = tracker.Observe(ctx, url, []byte("body"), lastMod.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if decision.Publish || !decision.LastModHintOnly {
		t.Fatalf("lastmod-only decision = %#v", decision)
	}
}
