package dataeng

import (
	"fmt"
	"testing"
)

func newTestDetector(t *testing.T, cfg Config) *Detector {
	t.Helper()
	d, err := New(cfg)
	if err != nil {
		t.Fatalf("New(%+v): %v", cfg, err)
	}
	return d
}

func eventsOfKind(events []Event, kind EventKind) []Event {
	var out []Event
	for _, event := range events {
		if event.Kind == kind {
			out = append(out, event)
		}
	}
	return out
}

func TestNewNormalizesDefaults(t *testing.T) {
	d := newTestDetector(t, Config{})
	cfg := d.Config()
	if cfg.DeleteAfter != DefaultDeleteAfter {
		t.Fatalf("DeleteAfter = %d, want %d", cfg.DeleteAfter, DefaultDeleteAfter)
	}
	if cfg.MaxRecheckCycles != DefaultMaxRecheckCycles {
		t.Fatalf("MaxRecheckCycles = %d, want %d", cfg.MaxRecheckCycles, DefaultMaxRecheckCycles)
	}

	if _, err := New(Config{DeleteAfter: -1}); err == nil {
		t.Fatal("New accepted a negative DeleteAfter")
	}
	if _, err := New(Config{MaxRecheckCycles: -1}); err == nil {
		t.Fatal("New accepted a negative MaxRecheckCycles")
	}
}

func TestAccessorsAndStringNames(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 2, MaxRecheckCycles: 4})
	d.ObserveComplete([]ID{"a"})

	if got := d.MaxRecheckCycles(); got != 4 {
		t.Fatalf("MaxRecheckCycles = %d, want 4", got)
	}
	if got := d.DeleteAfter(); got != 2 {
		t.Fatalf("DeleteAfter = %d, want 2", got)
	}
	rec, ok := d.Lookup("a")
	if !ok {
		t.Fatal("Lookup did not find a")
	}
	if rec.Slot != d.RecheckSlot("a") {
		t.Fatalf("stored slot = %d, computed slot = %d", rec.Slot, d.RecheckSlot("a"))
	}
	if _, ok := d.Lookup("missing"); ok {
		t.Fatal("Lookup found an untracked ID")
	}

	names := map[EventKind]string{
		EventCreated:  "created",
		EventDeleted:  "deleted",
		EventRestored: "restored",
		EventKind(0):  "unknown",
	}
	for kind, want := range names {
		if got := kind.String(); got != want {
			t.Fatalf("%d.String() = %q, want %q", kind, got, want)
		}
	}
	for status, want := range map[Status]string{
		StatusActive:  "active",
		StatusPending: "pending",
		StatusDeleted: "deleted",
		Status(0xff):  "unknown",
	} {
		if got := status.String(); got != want {
			t.Fatalf("%d.String() = %q, want %q", status, got, want)
		}
	}
}

func TestCreateDeleteAndTombstone(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 3, MaxRecheckCycles: 1})

	events := d.ObserveComplete([]ID{"a", "b"})
	created := eventsOfKind(events, EventCreated)
	if len(created) != 2 {
		t.Fatalf("created events = %d, want 2", len(created))
	}
	for _, event := range created {
		if event.Version != 1 || event.Generation != 1 {
			t.Fatalf("unexpected create event: %+v", event)
		}
	}

	for generation := uint64(2); generation <= 4; generation++ {
		events = d.ObserveComplete(nil)
		deleted := eventsOfKind(events, EventDeleted)
		if generation < 4 {
			if len(deleted) != 0 {
				t.Fatalf("deleted before threshold at generation %d: %+v", generation, deleted)
			}
			rec, ok := d.Lookup("a")
			if !ok || rec.Status != StatusPending || rec.Missing != int(generation-1) {
				t.Fatalf("a at generation %d = %+v, want pending with %d misses", generation, rec, generation-1)
			}
			continue
		}
		if len(deleted) != 2 {
			t.Fatalf("deleted events at generation %d = %d, want 2", generation, len(deleted))
		}
		for _, event := range deleted {
			if event.Version != 2 || event.Generation != 4 || event.Missing != 3 {
				t.Fatalf("unexpected delete event: %+v", event)
			}
		}
	}

	events = d.ObserveComplete(nil)
	if len(events) != 0 {
		t.Fatalf("tombstone emitted another event: %+v", events)
	}
}

func TestIncompleteListingDoesNotCount(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 2, MaxRecheckCycles: 1})

	d.ObserveComplete([]ID{"a"})
	d.ObserveIncomplete()
	d.ObserveIncomplete()

	stats := d.Stats()
	if stats.Generation != 1 {
		t.Fatalf("Generation = %d, want 1", stats.Generation)
	}
	if stats.IncompleteObservations != 2 {
		t.Fatalf("IncompleteObservations = %d, want 2", stats.IncompleteObservations)
	}
	rec, _ := d.Lookup("a")
	if rec.Missing != 0 || rec.Status != StatusActive {
		t.Fatalf("incomplete listings changed record: %+v", rec)
	}

	d.ObserveComplete(nil)           // miss 1
	d.ObserveIncomplete()            // neutral
	events := d.ObserveComplete(nil) // miss 2
	deleted := eventsOfKind(events, EventDeleted)
	if len(deleted) != 1 || deleted[0].ID != "a" {
		t.Fatalf("delete after two complete misses = %+v", deleted)
	}
}

func TestIncompleteListingNeverDeletes(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 1, MaxRecheckCycles: 1})
	d.ObserveComplete([]ID{"a"})

	for i := 0; i < 10; i++ {
		d.ObserveIncomplete()
	}
	if stats := d.Stats(); stats.Deleted != 0 {
		t.Fatalf("incomplete pages deleted a resource: %+v", stats)
	}
	if rec, _ := d.Lookup("a"); rec.Status != StatusActive {
		t.Fatalf("a status = %s, want active", rec.Status)
	}
}

func TestPresenceResetRequiresFullThresholdAgain(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 3, MaxRecheckCycles: 1})
	d.ObserveComplete([]ID{"a"})

	d.ObserveComplete(nil) // miss 1
	d.ObserveComplete(nil) // miss 2
	d.ObserveComplete([]ID{"a"})
	if rec, _ := d.Lookup("a"); rec.Missing != 0 {
		t.Fatalf("presence did not reset miss count: %+v", rec)
	}

	d.ObserveComplete(nil)           // miss 1
	d.ObserveComplete(nil)           // miss 2
	events := d.ObserveComplete(nil) // miss 3
	if len(eventsOfKind(events, EventDeleted)) != 1 {
		t.Fatalf("third miss after reset did not delete: %+v", events)
	}
}

func TestRestoreVersionAfterReappearance(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 1, MaxRecheckCycles: 1})

	first := d.ObserveComplete([]ID{"a"})
	if got := eventsOfKind(first, EventCreated); len(got) != 1 || got[0].Version != 1 {
		t.Fatalf("create = %+v", got)
	}

	second := d.ObserveComplete(nil)
	if got := eventsOfKind(second, EventDeleted); len(got) != 1 || got[0].Version != 2 {
		t.Fatalf("delete = %+v", got)
	}

	third := d.ObserveComplete([]ID{"a"})
	restored := eventsOfKind(third, EventRestored)
	if len(restored) != 1 || restored[0].Version != 3 || restored[0].ID != "a" {
		t.Fatalf("restore = %+v", restored)
	}

	fourth := d.ObserveComplete(nil)
	if got := eventsOfKind(fourth, EventDeleted); len(got) != 1 || got[0].Version != 4 {
		t.Fatalf("second delete = %+v", got)
	}

	fifth := d.ObserveComplete([]ID{"a"})
	restored = eventsOfKind(fifth, EventRestored)
	if len(restored) != 1 || restored[0].Version != 5 {
		t.Fatalf("second restore = %+v", restored)
	}
}

func TestIncompleteListingDoesNotRestore(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 1, MaxRecheckCycles: 1})
	d.ObserveComplete([]ID{"a"})
	d.ObserveComplete(nil)

	events := d.Observe(Listing{Complete: false, IDs: []ID{"a"}})
	if len(events) != 0 {
		t.Fatalf("partial listing restored a resource: %+v", events)
	}
	if rec, _ := d.Lookup("a"); rec.Status != StatusDeleted {
		t.Fatalf("a status = %s, want deleted", rec.Status)
	}
}

func TestDuplicateIDsAreObservedOnce(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 2, MaxRecheckCycles: 2})
	events := d.ObserveComplete([]ID{"a", "a", "a"})
	created := eventsOfKind(events, EventCreated)
	if len(created) != 1 {
		t.Fatalf("duplicate IDs produced %d create events, want 1", len(created))
	}
}

func TestRotationDeletesEachIDOnceAtUpperBound(t *testing.T) {
	const (
		cycles        = 4
		deleteAfter   = 2
		resourceCount = 200
	)
	d := newTestDetector(t, Config{DeleteAfter: deleteAfter, MaxRecheckCycles: cycles})

	ids := make([]ID, resourceCount)
	for i := range ids {
		ids[i] = ID(fmt.Sprintf("resource-%03d", i))
	}
	d.ObserveComplete(ids)

	seenDeletes := make(map[ID]int)
	finalGeneration := uint64(1 + cycles*deleteAfter)
	for generation := uint64(2); generation <= finalGeneration; generation++ {
		events := d.ObserveComplete(nil)
		for _, event := range eventsOfKind(events, EventDeleted) {
			seenDeletes[event.ID]++
		}
		if generation < finalGeneration {
			if stats := d.Stats(); stats.Deleted == resourceCount {
				t.Fatalf("all resources deleted before generation %d", finalGeneration)
			}
		}
	}

	stats := d.Stats()
	if stats.Deleted != resourceCount {
		t.Fatalf("Deleted = %d, want %d after %d complete generations", stats.Deleted, resourceCount, finalGeneration)
	}
	if len(seenDeletes) != resourceCount {
		t.Fatalf("unique delete events = %d, want %d", len(seenDeletes), resourceCount)
	}
	for id, count := range seenDeletes {
		if count != 1 {
			t.Fatalf("resource %s had %d delete events, want 1", id, count)
		}
	}

	for _, id := range ids {
		rec, ok := d.Lookup(id)
		if !ok || rec.Status != StatusDeleted || rec.Missing != deleteAfter {
			t.Fatalf("%s = %+v, want deleted with %d misses", id, rec, deleteAfter)
		}
	}
}

func TestRotationIsStableAndBalanced(t *testing.T) {
	const (
		cycles = 8
		count  = 10000
	)
	cfg := Config{MaxRecheckCycles: cycles, HashSalt: "collector-v1"}
	d := newTestDetector(t, cfg)

	slots := make([]int, cycles)
	for i := 0; i < count; i++ {
		id := ID(fmt.Sprintf("id-%d", i))
		slot := d.RecheckSlot(id)
		if slot < 0 || slot >= cycles {
			t.Fatalf("slot for %s = %d, want [0,%d)", id, slot, cycles)
		}
		slots[slot]++
	}

	for slot, n := range slots {
		if n < count/20 || n > count/4 {
			t.Fatalf("slot %d has %d of %d IDs; distribution is implausible", slot, n, count)
		}
	}

	other := newTestDetector(t, cfg)
	for i := 0; i < 100; i++ {
		id := ID(fmt.Sprintf("id-%d", i))
		if a, b := d.RecheckSlot(id), other.RecheckSlot(id); a != b {
			t.Fatalf("slot for %s changed from %d to %d", id, a, b)
		}
	}
}

func TestEveryIDRecheckedWithinWindow(t *testing.T) {
	const (
		cycles = 6
		count  = 300
	)
	d := newTestDetector(t, Config{DeleteAfter: 2, MaxRecheckCycles: cycles})

	ids := make([]ID, count)
	for i := range ids {
		ids[i] = ID(fmt.Sprintf("resource-%03d", i))
	}
	d.ObserveComplete(ids)

	// The creation generation checks slot 0. Feed exactly one full rotation of
	// empty listings; every ID must then have been scheduled once.
	for i := 0; i < cycles; i++ {
		d.ObserveComplete(nil)
	}

	for _, id := range ids {
		rec, ok := d.Lookup(id)
		if !ok {
			t.Fatalf("missing record for %s", id)
		}
		if rec.Missing != 1 {
			t.Fatalf("%s missing count after one rotation = %d, want 1", id, rec.Missing)
		}
	}
}

func TestNextRecheckWithinUpperBound(t *testing.T) {
	const cycles = 5
	d := newTestDetector(t, Config{MaxRecheckCycles: cycles})

	for i := 0; i < 200; i++ {
		id := ID(fmt.Sprintf("id-%d", i))
		for generation := uint64(0); generation < 12; generation++ {
			next, wait := d.NextRecheck(id)
			if wait < 1 || wait > cycles {
				t.Fatalf("NextRecheck(%s) at generation %d wait = %d, want [1,%d]", id, d.Generation(), wait, cycles)
			}
			if next != d.Generation()+wait {
				t.Fatalf("NextRecheck(%s) generation = %d, want %d", id, next, d.Generation()+wait)
			}
			slotAtNext := int((next - 1) % cycles)
			if slotAtNext != d.RecheckSlot(id) {
				t.Fatalf("NextRecheck(%s) points at slot %d, want %d", id, slotAtNext, d.RecheckSlot(id))
			}

			if generation%3 == 0 {
				d.ObserveIncomplete()
			} else {
				d.ObserveComplete(nil)
			}
		}
	}
}

func TestObserveEventsAreSorted(t *testing.T) {
	d := newTestDetector(t, Config{DeleteAfter: 1, MaxRecheckCycles: 1})
	events := d.ObserveComplete([]ID{"c", "a", "b"})
	for i := 1; i < len(events); i++ {
		if events[i-1].ID > events[i].ID {
			t.Fatalf("events are not sorted: %+v", events)
		}
	}
}
