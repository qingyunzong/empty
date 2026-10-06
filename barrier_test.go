package faultinj_test

import (
	"sync"
	"sync/atomic"
	"testing"

	"faultinj"
)

// No party passes the barrier before all parties have arrived.
func TestBarrierReleasesAllParties(t *testing.T) {
	const parties = 8
	bar := faultinj.NewBarrier(parties)
	var arrived, passed atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < parties; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			arrived.Add(1)
			bar.Await()
			if got := arrived.Load(); got != parties {
				t.Errorf("passed barrier with only %d arrivals", got)
			}
			passed.Add(1)
		}()
	}
	wg.Wait()
	if got := passed.Load(); got != parties {
		t.Fatalf("want %d parties released, got %d", parties, got)
	}
}

// The barrier resets itself and synchronizes repeated phases.
func TestBarrierReuseAcrossPhases(t *testing.T) {
	const parties, phases = 4, 25
	bar := faultinj.NewBarrier(parties)
	phase := make([]atomic.Int64, parties)
	var wg sync.WaitGroup
	for i := 0; i < parties; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for p := 0; p < phases; p++ {
				phase[i].Store(int64(p))
				bar.Await()
				for j := 0; j < parties; j++ {
					if got := phase[j].Load(); got < int64(p) {
						t.Errorf("party %d still at phase %d while %d is past it", j, got, i)
					}
				}
			}
		}(i)
	}
	wg.Wait()
}

func TestBarrierRejectsZeroParties(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("want panic for zero parties")
		}
	}()
	faultinj.NewBarrier(0)
}
