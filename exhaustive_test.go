package formal

import (
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

type endpointVariant struct {
	status string
	ready  bool
	term   bool
}

var exhaustiveStatuses = []endpointVariant{
	{status: "ready", ready: true, term: false},
	{status: "terminating", ready: false, term: true},
	{status: "terminating-ready", ready: true, term: true},
	{status: "not-ready", ready: false, term: false},
}

var interleavedStatuses = []endpointVariant{
	{status: "ready", ready: true, term: false},
	{status: "terminating", ready: false, term: true},
	{status: "not-ready", ready: false, term: false},
}

var exhaustiveHints = []string{"", "a", "b", "c", "ghost"}

func exhaustiveZoneConfigs() [][]Zone {
	return [][]Zone{
		{z("a", 1)},
		{z("a", 1), z("b", 1)},
		{z("a", 2), z("b", 1)},
		{z("a", 1), z("b", 2)},
		{z("a", 1), z("b", 1), z("c", 1)},
		{z("a", 2), z("b", 1), z("c", 1)},
		{z("a", 1), z("b", 1), z("c", 0)},
	}
}

func interleavedZoneConfigs() [][]Zone {
	return [][]Zone{
		{z("a", 1), z("b", 1)},
		{z("a", 2), z("b", 1)},
		{z("a", 1), z("b", 1), z("c", 1)},
		{z("a", 2), z("b", 1), z("c", 1)},
		{z("a", 1), z("b", 0), z("c", 1)},
	}
}

func enumerateEndpointStates(count int, statuses []endpointVariant, hints []string) [][]Endpoint {
	if count == 0 {
		return [][]Endpoint{nil}
	}
	var states [][]Endpoint
	var build func(prefix []Endpoint)
	build = func(prefix []Endpoint) {
		if len(prefix) == count {
			state := append([]Endpoint(nil), prefix...)
			states = append(states, state)
			return
		}
		index := len(prefix)
		id := fmt.Sprintf("e%d", index+1)
		for _, status := range statuses {
			for _, hint := range hints {
				build(append(prefix, ep(id, hint, status.ready, status.term)))
			}
		}
	}
	build(nil)
	return states
}

func checkProportionalRecomputation(t *testing.T, zones []Zone, endpoints []Endpoint, result Result) {
	t.Helper()
	active := activeZones(zones)
	totalCapacity := 0.0
	for _, zone := range active {
		totalCapacity += zone.Capacity
	}
	weightedTotal := weightedEndpointCount(endpoints)

	sumCounts := 0
	sumWeighted := 0
	for _, zone := range active {
		exactWeighted := 0.0
		exactTotal := 0.0
		if totalCapacity > 0 {
			exactWeighted = float64(weightedTotal) * zone.Capacity / totalCapacity
			exactTotal = float64(len(endpoints)) * zone.Capacity / totalCapacity
		}
		weightedCount := result.WeightedCounts[zone.Name]
		totalCount := result.Counts[zone.Name]
		sumWeighted += weightedCount
		sumCounts += totalCount

		checkWithinOne(t, "weighted", zone.Name, weightedCount, exactWeighted)
		checkWithinOne(t, "total", zone.Name, totalCount, exactTotal)
	}
	if sumWeighted != weightedTotal {
		t.Fatalf("sum(WeightedCounts) = %d, want %d", sumWeighted, weightedTotal)
	}
	if sumCounts != len(endpoints) {
		t.Fatalf("sum(Counts) = %d, want %d", sumCounts, len(endpoints))
	}
	if len(result.Assignments) != len(endpoints) {
		t.Fatalf("assignments = %d, want %d", len(result.Assignments), len(endpoints))
	}
}

func checkWithinOne(t *testing.T, kind, zone string, count int, exact float64) {
	t.Helper()
	deviation := math.Abs(float64(count) - exact)
	if deviation > 1+1e-9 {
		t.Fatalf("%s count for zone %q = %d, exact share %.6f, deviation %.6f >= 1", kind, zone, count, exact, deviation)
	}
	lower := int(math.Floor(exact + 1e-9))
	upper := int(math.Ceil(exact - 1e-9))
	if count < lower || count > upper {
		t.Fatalf("%s count for zone %q = %d, exact share %.6f, want floor/ceil [%d,%d]", kind, zone, count, exact, lower, upper)
	}
}

func TestExhaustiveSmallTopologies(t *testing.T) {
	for configIndex, zones := range exhaustiveZoneConfigs() {
		for endpointCount := 0; endpointCount <= 3; endpointCount++ {
			states := enumerateEndpointStates(endpointCount, exhaustiveStatuses, exhaustiveHints)
			for stateIndex, endpoints := range states {
				context := fmt.Sprintf("config=%d endpointCount=%d state=%d", configIndex, endpointCount, stateIndex)
				result, err := Partition(zones, endpoints, nil)
				if err != nil {
					t.Fatalf("%s: Partition() error = %v", context, err)
				}
				func() {
					defer func() {
						if t.Failed() {
							t.Fatalf("%s: zones=%v endpoints=%v result=%+v", context, zones, endpoints, result)
						}
					}()
					checkInvariants(t, zones, endpoints, result)
					checkProportionalRecomputation(t, zones, endpoints, result)
				}()

				again, err := Partition(zones, endpoints, result.Assignments)
				if err != nil {
					t.Fatalf("%s: stable Partition() error = %v", context, err)
				}
				if len(again.Moved) != 0 {
					t.Fatalf("%s: stable input moved %v", context, again.Moved)
				}
				if !reflect.DeepEqual(result.Assignments, again.Assignments) {
					t.Fatalf("%s: stable input changed assignment", context)
				}
			}
		}
	}
}

func TestExhaustiveInterleavedTopologyAndReadiness(t *testing.T) {
	topologies := interleavedZoneConfigs()
	states := enumerateEndpointStates(3, interleavedStatuses, exhaustiveHints)
	allocator := NewAllocator()

	for topologyIndex := range topologies {
		for stateIndex := range states {
			zones := topologies[topologyIndex]
			endpoints := states[stateIndex]
			steps := []struct {
				zones     []Zone
				endpoints []Endpoint
			}{
				{
					zones:     zones,
					endpoints: states[(stateIndex+1)%len(states)],
				},
				{
					zones:     zones,
					endpoints: endpoints,
				},
				{
					zones:     topologies[(topologyIndex+1)%len(topologies)],
					endpoints: endpoints,
				},
				{
					zones:     topologies[(topologyIndex+2)%len(topologies)],
					endpoints: states[(stateIndex+7)%len(states)],
				},
			}
			for stepIndex, step := range steps {
				before := allocator.Assignments()
				result, err := allocator.Allocate(step.zones, step.endpoints)
				if err != nil {
					t.Fatalf("topology=%d state=%d step=%d: Allocate() error = %v", topologyIndex, stateIndex, stepIndex, err)
				}
				func() {
					defer func() {
						if t.Failed() {
							t.Fatalf(
								"topology=%d state=%d step=%d zones=%v endpoints=%v result=%+v",
								topologyIndex, stateIndex, stepIndex, step.zones, step.endpoints, result,
							)
						}
					}()
					checkInvariants(t, step.zones, step.endpoints, result)
					checkProportionalRecomputation(t, step.zones, step.endpoints, result)
					checkMoved(t, before, step.endpoints, result)
					checkExactCoverage(t, step.endpoints, result.Assignments)
				}()
			}

			lastStep := steps[len(steps)-1]
			result, err := allocator.Allocate(lastStep.zones, lastStep.endpoints)
			if err != nil {
				t.Fatalf("topology=%d state=%d: repeat Allocate() error = %v", topologyIndex, stateIndex, err)
			}
			if len(result.Moved) != 0 {
				t.Fatalf("topology=%d state=%d: repeat moved %v", topologyIndex, stateIndex, result.Moved)
			}
		}
	}
}

func checkExactCoverage(t *testing.T, endpoints []Endpoint, assignments Assignment) {
	t.Helper()
	seen := make(map[string]struct{}, len(endpoints))
	for _, endpoint := range endpoints {
		if _, duplicate := seen[endpoint.ID]; duplicate {
			t.Fatalf("duplicate endpoint ID %q in input", endpoint.ID)
		}
		seen[endpoint.ID] = struct{}{}
		if _, ok := assignments[endpoint.ID]; !ok {
			t.Fatalf("endpoint %q was lost", endpoint.ID)
		}
	}
	if len(assignments) != len(endpoints) {
		t.Fatalf("assignment count = %d, endpoint count = %d", len(assignments), len(endpoints))
	}
	for id := range assignments {
		if _, ok := seen[id]; !ok {
			t.Fatalf("assignment contains unknown endpoint %q", id)
		}
	}
}

func TestRandomTopologiesConserveCountsAndBounds(t *testing.T) {
	rng := rand.New(rand.NewSource(10034))
	for iteration := 0; iteration < 500; iteration++ {
		zoneCount := 1 + rng.Intn(4)
		zones := make([]Zone, 0, zoneCount)
		hasCapacity := false
		for index := 0; index < zoneCount; index++ {
			capacity := float64(rng.Intn(5))
			if rng.Intn(2) == 0 {
				capacity = rng.Float64() * 10
			}
			if capacity > 0 {
				hasCapacity = true
			}
			zones = append(zones, z(fmt.Sprintf("z%d", index), capacity))
		}
		endpointCount := rng.Intn(10)
		if endpointCount > 0 && !hasCapacity {
			zones[0].Capacity = 1
		}
		endpoints := make([]Endpoint, 0, endpointCount)
		for index := 0; index < endpointCount; index++ {
			status := exhaustiveStatuses[rng.Intn(len(exhaustiveStatuses))]
			hint := exhaustiveHints[rng.Intn(len(exhaustiveHints))]
			endpoints = append(endpoints, ep(fmt.Sprintf("e%d", index), hint, status.ready, status.term))
		}
		result, err := Partition(zones, endpoints, nil)
		if err != nil {
			t.Fatalf("iteration %d: Partition() error = %v", iteration, err)
		}
		checkInvariants(t, zones, endpoints, result)
		checkProportionalRecomputation(t, zones, endpoints, result)

		again, err := Partition(zones, endpoints, result.Assignments)
		if err != nil {
			t.Fatalf("iteration %d: stable Partition() error = %v", iteration, err)
		}
		if len(again.Moved) != 0 {
			t.Fatalf("iteration %d: stable input moved %v", iteration, again.Moved)
		}
	}
}

func TestRandomArbitraryPreviousAssignments(t *testing.T) {
	rng := rand.New(rand.NewSource(42017))
	for iteration := 0; iteration < 500; iteration++ {
		zoneCount := 1 + rng.Intn(4)
		zones := make([]Zone, 0, zoneCount)
		active := make([]string, 0, zoneCount)
		for index := 0; index < zoneCount; index++ {
			capacity := float64(rng.Intn(4))
			if rng.Intn(2) == 0 {
				capacity = rng.Float64() * 4
			}
			name := fmt.Sprintf("z%d", index)
			zones = append(zones, z(name, capacity))
			if capacity > 0 {
				active = append(active, name)
			}
		}
		if len(active) == 0 {
			zones[0].Capacity = 1
			active = append(active, zones[0].Name)
		}

		endpointCount := rng.Intn(9)
		endpoints := make([]Endpoint, 0, endpointCount)
		previous := make(Assignment, endpointCount)
		for index := 0; index < endpointCount; index++ {
			status := exhaustiveStatuses[rng.Intn(len(exhaustiveStatuses))]
			hint := exhaustiveHints[rng.Intn(len(exhaustiveHints))]
			id := fmt.Sprintf("e%d", index)
			endpoints = append(endpoints, ep(id, hint, status.ready, status.term))
			// Include inactive or nonexistent zones in the previous state.
			if rng.Intn(5) != 0 {
				zone := fmt.Sprintf("z%d", rng.Intn(zoneCount+1))
				previous[id] = zone
			}
		}

		result, err := Partition(zones, endpoints, previous)
		if err != nil {
			t.Fatalf("iteration %d: Partition() error = %v", iteration, err)
		}
		checkInvariants(t, zones, endpoints, result)
		checkProportionalRecomputation(t, zones, endpoints, result)
		checkMoved(t, previous, endpoints, result)
		for _, endpoint := range endpoints {
			if _, ok := result.Assignments[endpoint.ID]; !ok {
				t.Fatalf("iteration %d: endpoint %q lost", iteration, endpoint.ID)
			}
		}

		again, err := Partition(zones, endpoints, result.Assignments)
		if err != nil {
			t.Fatalf("iteration %d: stable Partition() error = %v", iteration, err)
		}
		if len(again.Moved) != 0 {
			t.Fatalf("iteration %d: stable input moved %v", iteration, again.Moved)
		}
	}

	// Capacity-only changes also rebalance without touching unrelated zones.
	zones := []Zone{z("a", 2), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "", true, false),
		ep("e2", "", true, false),
		ep("e3", "", true, false),
		ep("e4", "", true, false),
		ep("e5", "", true, false),
		ep("e6", "", true, false),
	}
	first, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("initial Partition() error = %v", err)
	}
	changedZones := []Zone{z("a", 1), z("b", 2)}
	second, err := Partition(changedZones, endpoints, first.Assignments)
	if err != nil {
		t.Fatalf("capacity change Partition() error = %v", err)
	}
	checkInvariants(t, changedZones, endpoints, second)
	checkMoved(t, first.Assignments, endpoints, second)
	if second.Counts["a"] != 2 || second.Counts["b"] != 4 {
		t.Fatalf("Counts = %v, want a=2 b=4", second.Counts)
	}
	if len(second.Moved) != 2 {
		t.Fatalf("capacity change moved %d endpoints, want 2", len(second.Moved))
	}
}

func TestProportionalQuotaTieBreakingIsDeterministic(t *testing.T) {
	zones := []Zone{z("b", 1), z("a", 1), z("c", 1)}
	previous := map[string]int{"a": 1}
	first := proportionalQuotas(zones, 2, previous)
	for i := 0; i < 100; i++ {
		other := proportionalQuotas([]Zone{z("c", 1), z("b", 1), z("a", 1)}, 2, previous)
		if !reflect.DeepEqual(first, other) {
			t.Fatalf("quota depends on zone order: %v != %v", first, other)
		}
	}
	keys := make([]string, 0, len(first))
	for zone := range first {
		keys = append(keys, zone)
	}
	sort.Strings(keys)
	if !reflect.DeepEqual(keys, []string{"a", "b", "c"}) {
		t.Fatalf("quota keys = %v", keys)
	}
}
