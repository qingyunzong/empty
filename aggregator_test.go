package formal

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func apply(t *testing.T, a *Aggregator, event Event) ApplyResult {
	t.Helper()
	result, err := a.Apply(event)
	if err != nil {
		t.Fatalf("Apply(%+v): %v", event, err)
	}
	return result
}

func TestLifecycleAndAvailability(t *testing.T) {
	a := New()

	if got := apply(t, a, HealthEvent("api-1", 1, 1, HealthHealthy)); got != ResultApplied {
		t.Fatalf("health result = %v, want applied", got)
	}

	got, ok := a.Lookup("api-1")
	if !ok {
		t.Fatal("api-1 not found after health observation")
	}
	want := Instance{
		ID:         "api-1",
		Generation: 1,
		Health:     HealthHealthy,
		Weight:     1,
		Drain:      DrainActive,
		Available:  true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lookup = %+v, want %+v", got, want)
	}

	apply(t, a, WeightEvent("api-1", 1, 1, 7))
	apply(t, a, DrainEvent("api-1", 1, 1, DrainDraining))

	got, _ = a.Lookup("api-1")
	if got.Drain != DrainDraining || got.Available {
		t.Fatalf("draining instance = %+v, want live but unavailable", got)
	}
	if _, ok := a.Select(0); ok {
		t.Fatal("Select returned an instance while it was draining")
	}
	if got := a.Available(); len(got) != 0 {
		t.Fatalf("Available = %+v, want empty", got)
	}

	apply(t, a, DrainEvent("api-1", 1, 2, DrainActive))
	apply(t, a, HealthEvent("api-1", 1, 2, HealthUnhealthy))
	if _, ok := a.Lookup("api-1"); !ok {
		t.Fatal("unhealthy instance should remain live")
	}
	if _, ok := a.Select(0); ok {
		t.Fatal("Select returned an unhealthy instance")
	}

	apply(t, a, HealthEvent("api-1", 1, 3, HealthHealthy))
	if id, ok := a.Select(0); !ok || id != "api-1" {
		t.Fatalf("Select = (%q, %v), want (api-1, true)", id, ok)
	}

	apply(t, a, DrainEvent("api-1", 1, 3, DrainDrained))
	if _, ok := a.Lookup("api-1"); ok {
		t.Fatal("drained instance is still live")
	}
	if got := a.Snapshot(); len(got) != 0 {
		t.Fatalf("Snapshot = %+v, want empty", got)
	}
}

func TestLatestRevisionWinsPerAspect(t *testing.T) {
	a := New()

	apply(t, a, HealthEvent("a", 1, 10, HealthHealthy))
	if got := apply(t, a, HealthEvent("a", 1, 9, HealthUnhealthy)); got != ResultIgnored {
		t.Fatalf("older health result = %v, want ignored", got)
	}
	if got := apply(t, a, HealthEvent("a", 1, 10, HealthHealthy)); got != ResultIgnored {
		t.Fatalf("duplicate health result = %v, want ignored", got)
	}

	apply(t, a, WeightEvent("a", 1, 10, 9))
	apply(t, a, WeightEvent("a", 1, 9, 3))

	apply(t, a, DrainEvent("a", 1, 10, DrainActive))
	apply(t, a, DrainEvent("a", 1, 9, DrainDraining))

	got, ok := a.Lookup("a")
	if !ok {
		t.Fatal("instance missing")
	}
	if got.Health != HealthHealthy {
		t.Fatalf("health = %s, want healthy", got.Health)
	}
	if got.Weight != 9 {
		t.Fatalf("weight = %d, want 9", got.Weight)
	}
	if got.Drain != DrainActive {
		t.Fatalf("drain = %s, want active", got.Drain)
	}
	if !got.Available {
		t.Fatal("instance should be available")
	}
}

func TestAspectsHaveIndependentRevisions(t *testing.T) {
	a := New()

	apply(t, a, HealthEvent("a", 1, 100, HealthHealthy))
	apply(t, a, WeightEvent("a", 1, 1, 4))
	apply(t, a, DrainEvent("a", 1, 1, DrainActive))
	apply(t, a, AddEvent("a", 1, 1))

	got, ok := a.Lookup("a")
	if !ok {
		t.Fatal("instance missing")
	}
	if got.Health != HealthHealthy || got.Weight != 4 || !got.Available {
		t.Fatalf("instance = %+v, want healthy weight 4 available", got)
	}
}

func TestConflictTieBreaksAreCommutative(t *testing.T) {
	tests := []struct {
		name  string
		left  Event
		right Event
		check func(t *testing.T, got Instance)
	}{
		{
			name:  "health",
			left:  HealthEvent("a", 1, 1, HealthHealthy),
			right: HealthEvent("a", 1, 1, HealthUnhealthy),
			check: func(t *testing.T, got Instance) {
				if got.Health != HealthUnhealthy {
					t.Fatalf("health = %s, want unhealthy", got.Health)
				}
			},
		},
		{
			name:  "weight",
			left:  WeightEvent("a", 1, 1, 2),
			right: WeightEvent("a", 1, 1, 5),
			check: func(t *testing.T, got Instance) {
				if got.Weight != 5 {
					t.Fatalf("weight = %d, want 5", got.Weight)
				}
			},
		},
		{
			name:  "drain",
			left:  DrainEvent("a", 1, 1, DrainActive),
			right: DrainEvent("a", 1, 1, DrainDraining),
			check: func(t *testing.T, got Instance) {
				if got.Drain != DrainDraining {
					t.Fatalf("drain = %s, want draining", got.Drain)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for _, order := range [][2]Event{{tc.left, tc.right}, {tc.right, tc.left}} {
				a := New()
				apply(t, a, order[0])
				apply(t, a, order[1])
				got, ok := a.Lookup("a")
				if !ok {
					t.Fatal("instance missing")
				}
				tc.check(t, got)
			}
		})
	}

	t.Run("membership", func(t *testing.T) {
		for _, order := range [][2]Event{
			{AddEvent("a", 1, 1), RemoveEvent("a", 1, 1)},
			{RemoveEvent("a", 1, 1), AddEvent("a", 1, 1)},
		} {
			a := New()
			apply(t, a, order[0])
			apply(t, a, order[1])
			if _, ok := a.Lookup("a"); ok {
				t.Fatal("removal should win an equal-revision membership conflict")
			}
		}
	})
}

func TestReconnectAndHealthChecksDoNotCreateGhosts(t *testing.T) {
	a := New()

	apply(t, a, HealthEvent("a", 1, 1, HealthHealthy))
	apply(t, a, WeightEvent("a", 1, 1, 5))

	// The connection reconnects at generation 2 before late reports from the
	// old connection arrive.
	apply(t, a, HealthEvent("a", 2, 1, HealthHealthy))
	if got := apply(t, a, DrainEvent("a", 1, 100, DrainDrained)); got != ResultIgnored {
		t.Fatalf("stale drain result = %v, want ignored", got)
	}
	if got := apply(t, a, HealthEvent("a", 1, 101, HealthUnhealthy)); got != ResultIgnored {
		t.Fatalf("stale health result = %v, want ignored", got)
	}
	if got := apply(t, a, RemoveEvent("a", 1, 102)); got != ResultIgnored {
		t.Fatalf("stale removal result = %v, want ignored", got)
	}

	got, ok := a.Lookup("a")
	if !ok {
		t.Fatal("generation 2 instance disappeared")
	}
	if got.Generation != 2 || got.Health != HealthHealthy || got.Weight != 1 || !got.Available {
		t.Fatalf("instance = %+v, want generation 2 with fresh defaults", got)
	}

	apply(t, a, WeightEvent("a", 2, 1, 7))
	apply(t, a, DrainEvent("a", 2, 2, DrainDraining))
	if _, ok := a.Select(0); ok {
		t.Fatal("draining generation 2 instance was selected")
	}

	apply(t, a, DrainEvent("a", 2, 3, DrainDrained))
	if _, ok := a.Lookup("a"); ok {
		t.Fatal("drained generation 2 instance is still live")
	}

	// A stale health report from generation 1 still cannot resurrect it.
	apply(t, a, HealthEvent("a", 1, 200, HealthHealthy))
	if _, ok := a.Lookup("a"); ok {
		t.Fatal("stale generation 1 health report resurrected the instance")
	}

	apply(t, a, HealthEvent("a", 3, 1, HealthHealthy))
	got, ok = a.Lookup("a")
	if !ok {
		t.Fatal("generation 3 instance missing")
	}
	if got.Generation != 3 || !got.Available {
		t.Fatalf("instance = %+v, want live generation 3", got)
	}
}

func TestDrainedHealthObservationDoesNotReviveWithoutDrainEvent(t *testing.T) {
	a := New()

	apply(t, a, HealthEvent("a", 1, 1, HealthHealthy))
	apply(t, a, DrainEvent("a", 1, 2, DrainDrained))
	apply(t, a, HealthEvent("a", 1, 3, HealthHealthy))

	if _, ok := a.Lookup("a"); ok {
		t.Fatal("health observation revived a drained instance")
	}

	// A newer drain observation is an explicit report that the pool is usable
	// again. Old-generation events still cannot do this.
	apply(t, a, DrainEvent("a", 1, 4, DrainActive))
	if _, ok := a.Lookup("a"); !ok {
		t.Fatal("newer active drain observation did not restore the instance")
	}
}

func TestWeightedSelectionSkipsUnavailableInstances(t *testing.T) {
	a := New()

	for _, id := range []InstanceID{"a", "b", "c", "d", "e", "f"} {
		apply(t, a, HealthEvent(id, 1, 1, HealthHealthy))
	}
	apply(t, a, WeightEvent("a", 1, 1, 1))
	apply(t, a, WeightEvent("b", 1, 1, 3))
	apply(t, a, WeightEvent("c", 1, 1, 0))
	apply(t, a, WeightEvent("d", 1, 1, 10))
	apply(t, a, HealthEvent("d", 1, 2, HealthUnhealthy))
	apply(t, a, WeightEvent("e", 1, 1, 10))
	apply(t, a, DrainEvent("e", 1, 2, DrainDraining))
	apply(t, a, WeightEvent("f", 1, 1, 10))
	apply(t, a, RemoveEvent("f", 1, 2))

	if got := a.TotalWeight(); got != 4 {
		t.Fatalf("TotalWeight = %d, want 4", got)
	}

	want := []InstanceID{"a", "b", "b", "b"}
	for selector, wantID := range want {
		got, ok := a.Select(uint64(selector))
		if !ok || got != wantID {
			t.Fatalf("Select(%d) = (%q, %v), want (%q, true)", selector, got, ok, wantID)
		}
	}
	if got, ok := a.Select(4); !ok || got != "a" {
		t.Fatalf("Select(4) = (%q, %v), want (a, true)", got, ok)
	}
	if got, ok := a.Pick(nil); !ok || got != "a" {
		t.Fatalf("Pick(nil) = (%q, %v), want (a, true)", got, ok)
	}

	rnd := rand.New(rand.NewSource(42))
	for i := 0; i < 1000; i++ {
		got, ok := a.Pick(rnd)
		if !ok || (got != "a" && got != "b") {
			t.Fatalf("Pick = (%q, %v), want a or b", got, ok)
		}
	}

	stats := a.Stats()
	wantStats := Stats{
		LiveInstances:      5,
		AvailableInstances: 2,
		TotalWeight:        4,
		Applied:            15,
		Ignored:            0,
	}
	if stats != wantStats {
		t.Fatalf("Stats = %+v, want %+v", stats, wantStats)
	}
}

func TestSnapshotsAreSortedAndCopied(t *testing.T) {
	a := New()
	for _, id := range []InstanceID{"c", "a", "b"} {
		apply(t, a, HealthEvent(id, 1, 1, HealthHealthy))
	}

	got := a.Snapshot()
	var ids []InstanceID
	for _, instance := range got {
		ids = append(ids, instance.ID)
	}
	if want := []InstanceID{"a", "b", "c"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("snapshot IDs = %v, want %v", ids, want)
	}

	got[0].Weight = 99
	got[1].Available = false
	again := a.Snapshot()
	if again[0].Weight != 1 || !again[1].Available {
		t.Fatalf("snapshot mutation leaked into aggregator: %+v", again)
	}
}

func TestValidationDoesNotMutateState(t *testing.T) {
	a := New()
	apply(t, a, HealthEvent("a", 1, 1, HealthHealthy))
	before := a.Snapshot()
	beforeStats := a.Stats()

	tests := []struct {
		name  string
		event Event
		want  error
	}{
		{"empty ID", HealthEvent("", 1, 1, HealthHealthy), ErrEmptyInstanceID},
		{"kind", Event{ID: "a", Kind: EventKind(99)}, ErrInvalidKind},
		{"health", Event{ID: "a", Kind: EventHealth, Health: Health(8)}, ErrInvalidHealth},
		{"drain", Event{ID: "a", Kind: EventDrain, Drain: DrainState(8)}, ErrInvalidDrain},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result, err := a.Apply(tc.event)
			if result != ResultIgnored {
				t.Fatalf("result = %v, want ignored", result)
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}

	if got := a.Snapshot(); !reflect.DeepEqual(got, before) {
		t.Fatalf("invalid events changed snapshot: %+v, want %+v", got, before)
	}
	if got := a.Stats(); got != beforeStats {
		t.Fatalf("invalid events changed stats: %+v, want %+v", got, beforeStats)
	}
}

func TestStatsCountDeduplicatedEvents(t *testing.T) {
	a := New()

	apply(t, a, HealthEvent("a", 1, 2, HealthHealthy))
	if got := apply(t, a, HealthEvent("a", 1, 1, HealthUnhealthy)); got != ResultIgnored {
		t.Fatalf("stale result = %v, want ignored", got)
	}
	if got := apply(t, a, HealthEvent("a", 1, 2, HealthHealthy)); got != ResultIgnored {
		t.Fatalf("duplicate result = %v, want ignored", got)
	}
	apply(t, a, HealthEvent("a", 2, 1, HealthHealthy))

	stats := a.Stats()
	if stats.Applied != 2 || stats.Ignored != 2 {
		t.Fatalf("stats = %+v, want 2 applied and 2 ignored", stats)
	}
}

func TestZeroValueAggregator(t *testing.T) {
	var a Aggregator

	if got := a.Snapshot(); len(got) != 0 {
		t.Fatalf("Snapshot on zero value = %+v, want empty", got)
	}
	if got := a.Available(); len(got) != 0 {
		t.Fatalf("Available on zero value = %+v, want empty", got)
	}
	if _, ok := a.Lookup("missing"); ok {
		t.Fatal("Lookup found an instance in a zero value aggregator")
	}
	if _, ok := a.Select(0); ok {
		t.Fatal("Select found an instance in a zero value aggregator")
	}

	apply(t, &a, HealthEvent("a", 1, 1, HealthHealthy))
	if got, ok := a.Lookup("a"); !ok || got.Weight != 1 || !got.Available {
		t.Fatalf("zero value aggregator instance = %+v, %v", got, ok)
	}
}

func TestCustomDefaultWeight(t *testing.T) {
	a := New(WithDefaultWeight(4))
	apply(t, a, HealthEvent("a", 1, 1, HealthHealthy))

	if got := a.TotalWeight(); got != 4 {
		t.Fatalf("TotalWeight = %d, want 4", got)
	}
	if got, _ := a.Lookup("a"); got.Weight != 4 {
		t.Fatalf("weight = %d, want 4", got.Weight)
	}
}

func TestStringForms(t *testing.T) {
	if got := HealthUnknown.String(); got != "unknown" {
		t.Fatalf("HealthUnknown = %q", got)
	}
	if got := HealthHealthy.String(); got != "healthy" {
		t.Fatalf("HealthHealthy = %q", got)
	}
	if got := HealthUnhealthy.String(); got != "unhealthy" {
		t.Fatalf("HealthUnhealthy = %q", got)
	}
	if got := Health(9).String(); got != "Health(9)" {
		t.Fatalf("Health(9) = %q", got)
	}

	if got := DrainActive.String(); got != "active" {
		t.Fatalf("DrainActive = %q", got)
	}
	if got := DrainDraining.String(); got != "draining" {
		t.Fatalf("DrainDraining = %q", got)
	}
	if got := DrainDrained.String(); got != "drained" {
		t.Fatalf("DrainDrained = %q", got)
	}
	if got := DrainState(9).String(); got != "DrainState(9)" {
		t.Fatalf("DrainState(9) = %q", got)
	}

	if got := EventHealth.String(); got != "health" {
		t.Fatalf("EventHealth = %q", got)
	}
	if got := EventWeight.String(); got != "weight" {
		t.Fatalf("EventWeight = %q", got)
	}
	if got := EventDrain.String(); got != "drain" {
		t.Fatalf("EventDrain = %q", got)
	}
	if got := EventAdd.String(); got != "add" {
		t.Fatalf("EventAdd = %q", got)
	}
	if got := EventRemove.String(); got != "remove" {
		t.Fatalf("EventRemove = %q", got)
	}
	if got := EventKind(9).String(); got != "EventKind(9)" {
		t.Fatalf("EventKind(9) = %q", got)
	}
}
