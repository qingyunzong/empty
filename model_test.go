package formal

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// modelAspect is the batch oracle's representation of one last-writer-wins
// aspect. The oracle recomputes a snapshot from the complete accepted event
// log instead of incrementally mutating production state.
type modelAspect[T any] struct {
	set      bool
	revision uint64
	rank     uint64
	value    T
}

func (m *modelAspect[T]) consider(revision, rank uint64, value T) {
	if !m.set || revision > m.revision || (revision == m.revision && rank > m.rank) {
		m.set = true
		m.revision = revision
		m.rank = rank
		m.value = value
	}
}

func modelSnapshot(events []Event, defaultWeight uint32) []Instance {
	grouped := make(map[InstanceID][]Event)
	for _, event := range events {
		if event.Validate() != nil {
			continue
		}
		grouped[event.ID] = append(grouped[event.ID], event)
	}

	snapshots := make([]Instance, 0, len(grouped))
	for id, instanceEvents := range grouped {
		maxGeneration := instanceEvents[0].Generation
		for _, event := range instanceEvents[1:] {
			if event.Generation > maxGeneration {
				maxGeneration = event.Generation
			}
		}

		var health modelAspect[Health]
		var weight modelAspect[uint32]
		var drain modelAspect[DrainState]
		var membership modelAspect[bool]

		for _, event := range instanceEvents {
			if event.Generation != maxGeneration {
				continue
			}
			switch event.Kind {
			case EventHealth:
				health.consider(event.Revision, uint64(event.Health), event.Health)
			case EventWeight:
				weight.consider(event.Revision, uint64(event.Weight), event.Weight)
			case EventDrain:
				drain.consider(event.Revision, uint64(event.Drain), event.Drain)
			case EventAdd:
				membership.consider(event.Revision, 0, true)
			case EventRemove:
				membership.consider(event.Revision, 1, false)
			}
		}

		present := true
		if membership.set {
			present = membership.value
		}
		healthValue := HealthUnknown
		if health.set {
			healthValue = health.value
		}
		weightValue := defaultWeight
		if weight.set {
			weightValue = weight.value
		}
		drainValue := DrainActive
		if drain.set {
			drainValue = drain.value
		}

		live := present && drainValue != DrainDrained
		if !live {
			continue
		}
		snapshots = append(snapshots, Instance{
			ID:         id,
			Generation: maxGeneration,
			Health:     healthValue,
			Weight:     weightValue,
			Drain:      drainValue,
			Available:  healthValue == HealthHealthy && drainValue == DrainActive && weightValue > 0,
		})
	}

	sort.Slice(snapshots, func(i, j int) bool {
		return snapshots[i].ID < snapshots[j].ID
	})
	return snapshots
}

func availableFromSnapshot(snapshot []Instance) []Instance {
	available := make([]Instance, 0, len(snapshot))
	for _, instance := range snapshot {
		if instance.Available {
			available = append(available, instance)
		}
	}
	return available
}

func assertMatchesModel(t *testing.T, a *Aggregator, events []Event, defaultWeight uint32) {
	t.Helper()

	wantSnapshot := modelSnapshot(events, defaultWeight)
	if got := a.Snapshot(); !reflect.DeepEqual(got, wantSnapshot) {
		t.Fatalf("snapshot mismatch after %d events\n got: %+v\nwant: %+v\nevents: %+v",
			len(events), got, wantSnapshot, events)
	}

	wantAvailable := availableFromSnapshot(wantSnapshot)
	if got := a.Available(); !reflect.DeepEqual(got, wantAvailable) {
		t.Fatalf("available mismatch after %d events\n got: %+v\nwant: %+v\nevents: %+v",
			len(events), got, wantAvailable, events)
	}

	var wantWeight uint64
	for _, instance := range wantAvailable {
		wantWeight += uint64(instance.Weight)
	}
	if got := a.TotalWeight(); got != wantWeight {
		t.Fatalf("total weight = %d, want %d after events %+v", got, wantWeight, events)
	}
	if got := a.Len(); got != len(wantSnapshot) {
		t.Fatalf("Len = %d, want %d after events %+v", got, len(wantSnapshot), events)
	}
	for _, instance := range wantSnapshot {
		got, ok := a.Lookup(instance.ID)
		if !ok || !reflect.DeepEqual(got, instance) {
			t.Fatalf("Lookup(%q) = (%+v, %v), want (%+v, true)", instance.ID, got, ok, instance)
		}
	}
}

func TestExhaustiveFaultAndJitterSequences(t *testing.T) {
	alphabet := []Event{
		AddEvent("a", 1, 1),
		HealthEvent("a", 1, 1, HealthHealthy),
		HealthEvent("a", 1, 2, HealthUnhealthy),
		HealthEvent("a", 1, 3, HealthHealthy),
		WeightEvent("a", 1, 1, 3),
		WeightEvent("a", 1, 2, 0),
		DrainEvent("a", 1, 1, DrainDraining),
		DrainEvent("a", 1, 2, DrainActive),
		DrainEvent("a", 1, 3, DrainDrained),
		HealthEvent("a", 2, 1, HealthHealthy),
		WeightEvent("a", 2, 1, 5),
		RemoveEvent("a", 2, 2),
		HealthEvent("a", 1, 99, HealthHealthy),
		HealthEvent("b", 1, 1, HealthHealthy),
		WeightEvent("b", 1, 1, 2),
		DrainEvent("b", 1, 2, DrainDraining),
		RemoveEvent("b", 1, 3),
	}

	const maxLength = 4

	var walk func(events []Event)
	walk = func(events []Event) {
		a := New()
		for i, event := range events {
			if _, err := a.Apply(event); err != nil {
				t.Fatalf("Apply(%+v): %v", event, err)
			}
			assertMatchesModel(t, a, events[:i+1], 1)
		}
		if len(events) == maxLength {
			return
		}
		for _, event := range alphabet {
			next := make([]Event, len(events)+1)
			copy(next, events)
			next[len(events)] = event
			walk(next)
		}
	}

	walk(nil)
}

func forEachPermutation(events []Event, visit func([]Event)) {
	var generate func(int)
	generate = func(index int) {
		if index == len(events) {
			visit(events)
			return
		}
		for i := index; i < len(events); i++ {
			events[index], events[i] = events[i], events[index]
			generate(index + 1)
			events[index], events[i] = events[i], events[index]
		}
	}
	generate(0)
}

func TestReconnectInterleavingsAreOrderIndependent(t *testing.T) {
	fixture := []Event{
		HealthEvent("a", 1, 1, HealthHealthy),
		WeightEvent("a", 1, 1, 4),
		DrainEvent("a", 1, 2, DrainDrained),
		HealthEvent("a", 2, 1, HealthHealthy),
		DrainEvent("a", 1, 3, DrainDraining),
		HealthEvent("a", 2, 2, HealthUnhealthy),
		WeightEvent("a", 2, 1, 7),
		AddEvent("a", 3, 1),
	}

	permutations := 0
	forEachPermutation(fixture, func(order []Event) {
		permutations++
		a := New()
		for _, event := range order {
			if _, err := a.Apply(event); err != nil {
				t.Fatalf("Apply(%+v): %v", event, err)
			}
		}
		assertMatchesModel(t, a, order, 1)

		snapshot := a.Snapshot()
		if len(snapshot) != 1 {
			t.Fatalf("snapshot has %d instances, want one: %+v (order %+v)", len(snapshot), snapshot, order)
		}
		want := Instance{
			ID:         "a",
			Generation: 3,
			Health:     HealthUnknown,
			Weight:     1,
			Drain:      DrainActive,
			Available:  false,
		}
		if !reflect.DeepEqual(snapshot[0], want) {
			t.Fatalf("final instance = %+v, want %+v (order %+v)", snapshot[0], want, order)
		}
	})

	const wantPermutations = 40320
	if permutations != wantPermutations {
		t.Fatalf("visited %d permutations, want %d", permutations, wantPermutations)
	}
}

func TestRandomizedLongSequencesMatchModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261119))
	ids := []InstanceID{"a", "b", "c", "d"}

	for iteration := 0; iteration < 300; iteration++ {
		a := New()
		events := make([]Event, 0, 80)
		for step := 0; step < 80; step++ {
			var event Event
			if len(events) > 0 && rng.Intn(5) == 0 {
				event = events[rng.Intn(len(events))]
			} else {
				id := ids[rng.Intn(len(ids))]
				generation := uint64(rng.Intn(3) + 1)
				revision := uint64(rng.Intn(8))
				switch EventKind(rng.Intn(5)) {
				case EventHealth:
					event = HealthEvent(id, generation, revision, Health(rng.Intn(3)))
				case EventWeight:
					event = WeightEvent(id, generation, revision, uint32(rng.Intn(6)))
				case EventDrain:
					event = DrainEvent(id, generation, revision, DrainState(rng.Intn(3)))
				case EventAdd:
					event = AddEvent(id, generation, revision)
				case EventRemove:
					event = RemoveEvent(id, generation, revision)
				}
			}

			if _, err := a.Apply(event); err != nil {
				t.Fatalf("Apply(%+v): %v", event, err)
			}
			events = append(events, event)
			assertMatchesModel(t, a, events, 1)
		}
	}
}

func decodeEvents(data []byte) []Event {
	events := make([]Event, 0, len(data)/6)
	for i := 0; i+5 < len(data) && len(events) < 128; i += 6 {
		var id InstanceID
		if data[i]%7 != 0 {
			id = InstanceID(fmt.Sprintf("n%d", data[i]%4))
		}
		generation := uint64(data[i+1] % 4)
		revision := uint64(data[i+2] % 8)
		kind := EventKind(data[i+3] % 6)
		value := data[i+4]
		event := Event{
			ID:         id,
			Generation: generation,
			Revision:   revision,
			Kind:       kind,
		}
		switch kind {
		case EventHealth:
			event.Health = Health(value % 4)
		case EventWeight:
			event.Weight = uint32(value % 6)
		case EventDrain:
			event.Drain = DrainState(value % 4)
		}
		events = append(events, event)
	}
	return events
}

func FuzzAggregatorMatchesModel(f *testing.F) {
	f.Add([]byte{0, 1, 1, 0, 1, 0, 1, 1, 2, 3, 0, 0, 2, 2, 1, 0, 1, 0})
	f.Add([]byte{1, 2, 0, 3, 1, 0, 1, 1, 1, 2, 0, 0, 1, 2, 0, 0, 0, 0})
	f.Add([]byte{2, 0, 2, 2, 2, 0, 3, 1, 1, 1, 0, 0, 1, 3, 3, 4, 9, 9})

	f.Fuzz(func(t *testing.T, data []byte) {
		events := decodeEvents(data)
		a := New()
		accepted := make([]Event, 0, len(events))
		for _, event := range events {
			if _, err := a.Apply(event); err != nil {
				continue
			}
			accepted = append(accepted, event)
			assertMatchesModel(t, a, accepted, 1)
		}
	})
}
