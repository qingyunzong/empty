package formal

import (
	"math/rand"
	"sync"
	"testing"
)

func TestConcurrentApplyAndReaders(t *testing.T) {
	a := New()
	ids := []InstanceID{"a", "b", "c", "d", "e"}

	const (
		workers         = 8
		eventsPerWorker = 300
	)

	batches := make([][]Event, workers)
	for worker := 0; worker < workers; worker++ {
		rng := rand.New(rand.NewSource(int64(worker + 1)))
		batch := make([]Event, 0, eventsPerWorker)
		for i := 0; i < eventsPerWorker; i++ {
			id := ids[rng.Intn(len(ids))]
			generation := uint64(rng.Intn(3) + 1)
			revision := uint64(rng.Intn(60))
			switch EventKind(rng.Intn(5)) {
			case EventHealth:
				batch = append(batch, HealthEvent(id, generation, revision, Health(rng.Intn(3))))
			case EventWeight:
				batch = append(batch, WeightEvent(id, generation, revision, uint32(rng.Intn(8))))
			case EventDrain:
				batch = append(batch, DrainEvent(id, generation, revision, DrainState(rng.Intn(3))))
			case EventAdd:
				batch = append(batch, AddEvent(id, generation, revision))
			case EventRemove:
				batch = append(batch, RemoveEvent(id, generation, revision))
			}
		}
		batches[worker] = batch
	}

	var applyWG sync.WaitGroup
	for _, batch := range batches {
		applyWG.Add(1)
		go func(batch []Event) {
			defer applyWG.Done()
			for _, event := range batch {
				if _, err := a.Apply(event); err != nil {
					t.Errorf("Apply(%+v): %v", event, err)
				}
			}
		}(batch)
	}

	stop := make(chan struct{})
	var readerWG sync.WaitGroup
	for i := 0; i < 4; i++ {
		readerWG.Add(1)
		go func() {
			defer readerWG.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}

				snapshot := a.Snapshot()
				available := a.Available()
				stats := a.Stats()

				for _, instance := range available {
					if !instance.Available {
						t.Errorf("Available returned unavailable instance %+v", instance)
					}
					if instance.Health != HealthHealthy || instance.Drain != DrainActive || instance.Weight == 0 {
						t.Errorf("available instance has invalid state: %+v", instance)
					}
				}
				if stats.AvailableInstances > 0 && stats.TotalWeight == 0 {
					t.Errorf("stats report available instances without weight: %+v", stats)
				}
				for _, instance := range snapshot {
					if instance.Drain == DrainDraining && instance.Available {
						t.Errorf("draining instance reported available: %+v", instance)
					}
				}
			}
		}()
	}

	applyWG.Wait()
	close(stop)
	readerWG.Wait()

	var all []Event
	for _, batch := range batches {
		all = append(all, batch...)
	}
	assertMatchesModel(t, a, all, 1)

	stats := a.Stats()
	if stats.Applied+stats.Ignored != uint64(len(all)) {
		t.Fatalf("applied + ignored = %d, want %d", stats.Applied+stats.Ignored, len(all))
	}
}

func TestConcurrentSelectionNeverPicksDraining(t *testing.T) {
	a := New()
	apply(t, a, HealthEvent("active", 1, 1, HealthHealthy))
	apply(t, a, WeightEvent("active", 1, 1, 1))
	apply(t, a, HealthEvent("draining", 1, 1, HealthHealthy))
	apply(t, a, WeightEvent("draining", 1, 1, 1000))
	apply(t, a, DrainEvent("draining", 1, 2, DrainDraining))

	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			for i := 0; i < 2000; i++ {
				id, ok := a.Pick(rng)
				if !ok || id != "active" {
					t.Errorf("Pick = (%q, %v), want (active, true)", id, ok)
					return
				}
			}
		}(int64(worker + 1))
	}
	wg.Wait()
}
