package dataeng

import (
	"sync"
	"testing"
)

func TestConcurrentSubmission(t *testing.T) {
	collector, err := NewCollector(4, 4, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	const versions = 50
	var wg sync.WaitGroup
	for version := 1; version <= versions; version++ {
		wg.Add(1)
		go func(version int) {
			defer wg.Done()
			batch := Batch{
				Version: version,
				Events:  []Event{ev("e", 0, 0, "1")},
			}
			if _, err := collector.Submit(batch); err != nil {
				t.Errorf("version %d: %v", version, err)
			}
			// Idempotent redelivery from another goroutine must stay safe.
			if _, err := collector.Submit(batch); err != nil {
				t.Errorf("redelivery %d: %v", version, err)
			}
		}(version)
	}
	wg.Wait()

	if collector.NextVersion() != versions+1 {
		t.Fatalf("next version = %d, want %d", collector.NextVersion(), versions+1)
	}
	for version := 1; version <= versions; version++ {
		if collector.Snapshot(version) == nil {
			t.Fatalf("missing snapshot for version %d", version)
		}
	}
	if collector.PendingBytes() != 0 {
		t.Fatalf("pending bytes = %d, want 0", collector.PendingBytes())
	}
}
