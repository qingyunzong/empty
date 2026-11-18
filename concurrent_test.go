package formal

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
)

// TestConcurrentAdvanceAndLongScan interleaves concurrent committers and
// GC passes with long-running range scans. A scan must observe a stable
// snapshot for its whole lifetime: no version visible to it may be
// reclaimed early.
func TestConcurrentAdvanceAndLongScan(t *testing.T) {
	eng := NewEngine()
	const (
		writers         = 4
		commitsPerWrite = 300
		scanners        = 2
		scansPerScanner = 60
		nkeys           = 8
	)

	var wg sync.WaitGroup
	stopGC := make(chan struct{})
	gcDone := make(chan struct{})

	// GC goroutine: advance + collect continuously, asserting the
	// watermark never regresses.
	go func() {
		defer close(gcDone)
		var lastSafe uint64
		for {
			st := eng.GC()
			if st.SafeTS < lastSafe {
				t.Errorf("watermark regressed: %d -> %d", lastSafe, st.SafeTS)
				return
			}
			lastSafe = st.SafeTS
			select {
			case <-stopGC:
				eng.GC()
				return
			default:
			}
		}
	}()

	// Writer goroutines: small transactions committing new versions.
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			r := rand.New(rand.NewSource(int64(w)))
			for i := 0; i < commitsPerWrite; i++ {
				tx := eng.Begin()
				key := fmt.Sprintf("k%d", r.Intn(nkeys))
				tx.Write(key, fmt.Sprintf("w%d-i%d", w, i))
				tx.Commit()
			}
		}(w)
	}

	// Long scanners: hold a snapshot and re-scan repeatedly; every
	// re-scan must resolve to exactly the same versions.
	for s := 0; s < scanners; s++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for iter := 0; iter < scansPerScanner; iter++ {
				tx := eng.Begin()
				snap := tx.SnapshotTS()
				base := tx.Scan("k", "l")
				want := make(map[string]uint64, len(base))
				for _, v := range base {
					want[v.Key] = v.TS
				}
				for j := 0; j < 25; j++ {
					got := tx.Scan("k", "l")
					if len(got) != len(want) {
						t.Errorf("snap %d: scan returned %d keys, want %d (premature reclaim?)",
							snap, len(got), len(want))
						break
					}
					for _, v := range got {
						if want[v.Key] != v.TS {
							t.Errorf("snap %d: key %s resolved to @%d, was @%d (premature reclaim)",
								snap, v.Key, v.TS, want[v.Key])
						}
						if v.TS > snap {
							t.Errorf("snap %d: scan returned future version %s@%d", snap, v.Key, v.TS)
						}
					}
					for key, ts := range want {
						v, ok := tx.Get(key)
						if !ok || v.TS != ts {
							t.Errorf("snap %d: Get(%s) changed mid-scan", snap, key)
						}
					}
				}
				tx.Rollback()
			}
		}()
	}

	wg.Wait()
	close(stopGC)
	<-gcDone

	// Final pass with no active transactions: every chain must collapse
	// to its newest version, and accounting must balance exactly.
	eng.GC()
	st := eng.Stats()
	for key, tss := range eng.DumpChains() {
		if len(tss) != 1 {
			t.Errorf("chain %s has %d versions after final GC, want 1", key, len(tss))
		}
	}
	if st.ReclaimedVersions+st.LiveVersions != st.TotalVersions {
		t.Errorf("version accounting broken: %d + %d != %d",
			st.ReclaimedVersions, st.LiveVersions, st.TotalVersions)
	}
	if st.ReclaimedBytes+st.LiveBytes != st.TotalBytes {
		t.Errorf("byte accounting broken: %d + %d != %d",
			st.ReclaimedBytes, st.LiveBytes, st.TotalBytes)
	}
	if st.ReclaimedBytes == 0 {
		t.Errorf("expected GC to reclaim bytes during the run")
	}
}

// TestConcurrentBeginCloseSameSnapshot hammers begin/close pairs at the
// same snapshot timestamp while GC runs; the refcounted snapshot set
// must never drop a still-active snapshot.
func TestConcurrentBeginCloseSameSnapshot(t *testing.T) {
	eng := NewEngine()
	var stop atomic.Bool
	var wg sync.WaitGroup
	writerDone := make(chan struct{})

	go func() {
		defer close(writerDone)
		for i := 0; ; i++ {
			if stop.Load() {
				return
			}
			tx := eng.Begin()
			tx.Write("hot", fmt.Sprintf("v%d", i))
			tx.Commit()
		}
	}()

	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				tx := eng.Begin()
				if _, ok := tx.Get("hot"); ok {
					// The version we just read must remain readable.
					if _, ok2 := tx.Get("hot"); !ok2 {
						t.Errorf("version disappeared under an active snapshot")
					}
				}
				tx.Rollback()
				eng.GC()
			}
		}()
	}
	wg.Wait()
	stop.Store(true)
	<-writerDone
}
