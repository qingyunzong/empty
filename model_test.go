package logcompact

import (
	"bytes"
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

// fullModel is the full-retention oracle: it keeps every record ever
// appended, so model[from:] is exactly what a retainer pinned at `from`
// must still be able to read.
type fullModel struct {
	records []Record
}

func (m *fullModel) append(key string, value []byte) {
	m.records = append(m.records, Record{
		Offset: uint64(len(m.records)),
		Key:    key,
		Value:  append([]byte(nil), value...),
	})
}

// verifyAgainstModel checks the two safety invariants against the oracle:
//  1. no over-reclamation: the log base never passed any live retainer;
//  2. retained records are exactly the model's tail from base on.
func verifyAgainstModel(t *testing.T, l *Log, m *fullModel) {
	t.Helper()
	base := l.Base()
	for _, s := range l.Snapshots() {
		if s.From < base {
			t.Fatalf("reclaimed past snapshot %+v: base=%d", s, base)
		}
	}
	for _, lease := range l.Leases() {
		if lease.From < base {
			t.Fatalf("reclaimed past lease %+v: base=%d", lease, base)
		}
	}
	got := l.ReadFrom(base)
	want := m.records[base:]
	if len(got) != len(want) {
		t.Fatalf("retained %d records from base %d, model has %d", len(got), base, len(want))
	}
	for i := range want {
		if got[i].Offset != want[i].Offset || got[i].Key != want[i].Key || !bytes.Equal(got[i].Value, want[i].Value) {
			t.Fatalf("record %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
	// Every live retainer sees exactly the model's records from its offset.
	for _, lease := range l.Leases() {
		if got := l.ReadFrom(lease.From); len(got) != len(m.records[lease.From:]) {
			t.Fatalf("lease %+v sees %d records, model has %d", lease, len(got), len(m.records[lease.From:]))
		}
	}
}

// roundPlan describes one barrier-synchronized round. The controller fills
// it in before releasing the workers, so each round interleaves snapshot
// publishing, lease renewal/release and truncation across goroutines.
type roundPlan struct {
	publish   bool
	discardID uint64 // 0 means no discard

	acquireName string // "" means no acquire
	renew       Lease  // Token 0 means no renew
	release     Lease  // Token 0 means no release

	truncateTo uint64
}

type roundResult struct {
	snap  Snapshot
	lease Lease
}

// TestBarrierInterleavedModel runs randomized rounds where a snapshotter, a
// leaser and a truncator act concurrently behind a barrier, then checks the
// compacted log against a full-retention model after every round.
func TestBarrierInterleavedModel(t *testing.T) {
	for _, seed := range []int64{1, 7, 42} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			l := New()
			var model fullModel

			var (
				liveSnaps  []Snapshot
				liveLeases []Lease // current lease per name
				stale      []Lease // old handles kept to attempt stale releases
			)
			names := []string{"r0", "r1", "r2"}

			bar := newBarrier(4) // controller + snapshotter + leaser + truncator
			var plan roundPlan
			var res [3]roundResult
			var wg sync.WaitGroup
			stop := make(chan struct{})

			worker := func(idx int, act func()) {
				defer wg.Done()
				for {
					bar.await()
					select {
					case <-stop:
						return
					default:
					}
					act()
					bar.await()
				}
			}

			wg.Add(3)
			go worker(0, func() { // snapshotter
				if plan.publish {
					res[0].snap = l.PublishSnapshot()
				}
				if plan.discardID != 0 {
					l.DiscardSnapshot(plan.discardID)
				}
			})
			go worker(1, func() { // leaser
				if plan.acquireName != "" {
					res[1].lease = l.Acquire(plan.acquireName)
				}
				if plan.renew.Token != 0 {
					l.Renew(plan.renew)
				}
				if plan.release.Token != 0 {
					l.Release(plan.release)
				}
			})
			go worker(2, func() { // truncator
				l.Truncate(plan.truncateTo)
			})

			const rounds = 500
			for round := 0; round < rounds; round++ {
				// Controller appends 0-3 records to both log and model.
				for n := rng.Intn(4); n > 0; n-- {
					v := []byte(fmt.Sprintf("s%d-r%d", seed, round))
					l.Append("k", v)
					model.append("k", v)
				}

				plan = roundPlan{}
				if n := uint64(len(model.records)); n > 0 {
					plan.truncateTo = rng.Uint64() % (n + 1)
				}
				if rng.Intn(3) == 0 {
					plan.publish = true
				}
				if len(liveSnaps) > 0 && rng.Intn(3) == 0 {
					plan.discardID = liveSnaps[rng.Intn(len(liveSnaps))].ID
				}
				if rng.Intn(2) == 0 {
					plan.acquireName = names[rng.Intn(len(names))]
				}
				if len(liveLeases) > 0 && rng.Intn(2) == 0 {
					plan.renew = liveLeases[rng.Intn(len(liveLeases))]
				}
				// Deliberately release stale handles half the time.
				if len(stale) > 0 && rng.Intn(2) == 0 {
					plan.release = stale[rng.Intn(len(stale))]
				} else if len(liveLeases) > 0 && rng.Intn(3) == 0 {
					plan.release = liveLeases[rng.Intn(len(liveLeases))]
				}

				bar.await() // release workers onto the plan
				bar.await() // wait for them to finish

				// Merge results into controller state.
				if plan.publish {
					liveSnaps = append(liveSnaps, res[0].snap)
					res[0].snap = Snapshot{}
				}
				if plan.discardID != 0 {
					for i, s := range liveSnaps {
						if s.ID == plan.discardID {
							liveSnaps = append(liveSnaps[:i], liveSnaps[i+1:]...)
							break
						}
					}
				}
				if plan.acquireName != "" {
					for i, ls := range liveLeases {
						if ls.Name == plan.acquireName {
							stale = append(stale, ls)
							liveLeases = append(liveLeases[:i], liveLeases[i+1:]...)
							break
						}
					}
					liveLeases = append(liveLeases, res[1].lease)
					res[1].lease = Lease{}
				}
				if plan.release.Token != 0 {
					for i, ls := range liveLeases {
						if ls == plan.release {
							liveLeases = append(liveLeases[:i], liveLeases[i+1:]...)
							break
						}
					}
				}

				verifyAgainstModel(t, l, &model)
			}

			close(stop)
			bar.await()
			wg.Wait()
		})
	}
}

// TestLeaseRenewalAcrossGenerations uses a two-party barrier to interleave
// re-acquisition with renewal of the previous generation: once a new lease
// for the same name exists, renewing the old handle must fail and must not
// disturb the new lease's retention floor.
func TestLeaseRenewalAcrossGenerations(t *testing.T) {
	for i := 0; i < 500; i++ {
		l := New()
		var model fullModel
		for n := 0; n < 4; n++ {
			l.Append("k", []byte{byte(n)})
			model.append("k", []byte{byte(n)})
		}
		old := l.Acquire("reader")

		bar := newBarrier(2)
		var wg sync.WaitGroup
		wg.Add(1)
		var cur Lease
		go func() {
			defer wg.Done()
			bar.await()
			cur = l.Acquire("reader") // same name, new generation
		}()
		bar.await()
		l.Renew(old) // races with re-acquisition; outcome is irrelevant
		wg.Wait()

		if l.Renew(old) {
			t.Fatalf("iter %d: stale lease renewed after re-acquire", i)
		}
		if !l.Renew(cur) {
			t.Fatalf("iter %d: new lease lost after stale renew", i)
		}
		if l.Release(old) {
			t.Fatalf("iter %d: stale release succeeded after re-acquire", i)
		}
		l.Truncate(4)
		verifyAgainstModel(t, l, &model)
		if !l.Release(cur) {
			t.Fatalf("iter %d: current release failed", i)
		}
	}
}
