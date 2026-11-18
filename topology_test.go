package formal

import (
	"errors"
	"math"
	"reflect"
	"sort"
	"sync"
	"testing"
)

func ep(id, hint string, ready, terminating bool) Endpoint {
	return Endpoint{ID: id, ZoneHint: hint, Ready: ready, Terminating: terminating}
}

func z(name string, capacity float64) Zone {
	return Zone{Name: name, Capacity: capacity}
}

func activeZones(zones []Zone) []Zone {
	active := make([]Zone, 0, len(zones))
	for _, zone := range zones {
		if zone.Capacity > 0 {
			active = append(active, zone)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].Name < active[j].Name })
	return active
}

func weightedEndpointCount(endpoints []Endpoint) int {
	total := 0
	for _, endpoint := range endpoints {
		total += endpoint.Weight()
	}
	return total
}

func checkInvariants(t *testing.T, zones []Zone, endpoints []Endpoint, result Result, options ...Options) {
	t.Helper()
	if err := Verify(zones, endpoints, result.Assignments, options...); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if len(result.Assignments) != len(endpoints) {
		t.Fatalf("assignment count = %d, want %d", len(result.Assignments), len(endpoints))
	}

	active := activeZones(zones)
	activeByName := make(map[string]Zone, len(active))
	totalCapacity := 0.0
	for _, zone := range active {
		activeByName[zone.Name] = zone
		totalCapacity += zone.Capacity
	}

	wantCounts := make(map[string]int, len(active))
	wantWeighted := make(map[string]int, len(active))
	for _, zone := range active {
		wantCounts[zone.Name] = 0
		wantWeighted[zone.Name] = 0
	}
	seen := make(map[string]struct{}, len(endpoints))
	for _, endpoint := range endpoints {
		if _, duplicate := seen[endpoint.ID]; duplicate {
			t.Fatalf("endpoint %q appears twice in input", endpoint.ID)
		}
		seen[endpoint.ID] = struct{}{}
		zone, ok := result.Assignments[endpoint.ID]
		if !ok {
			t.Fatalf("endpoint %q is missing from result", endpoint.ID)
		}
		if _, ok := activeByName[zone]; !ok {
			t.Fatalf("endpoint %q assigned to inactive zone %q", endpoint.ID, zone)
		}
		wantCounts[zone]++
		if endpoint.Weight() == 1 {
			wantWeighted[zone]++
		}
	}
	for id := range result.Assignments {
		if _, ok := seen[id]; !ok {
			t.Fatalf("result contains unknown endpoint %q", id)
		}
	}

	sumCounts := 0
	sumWeighted := 0
	weightedTotal := weightedEndpointCount(endpoints)
	for _, zone := range active {
		if got := result.Counts[zone.Name]; got != wantCounts[zone.Name] {
			t.Errorf("Counts[%q] = %d, want %d", zone.Name, got, wantCounts[zone.Name])
		}
		if got := result.WeightedCounts[zone.Name]; got != wantWeighted[zone.Name] {
			t.Errorf("WeightedCounts[%q] = %d, want %d", zone.Name, got, wantWeighted[zone.Name])
		}
		sumCounts += result.Counts[zone.Name]
		sumWeighted += result.WeightedCounts[zone.Name]

		exactWeighted := 0.0
		if totalCapacity > 0 {
			exactWeighted = float64(weightedTotal) * zone.Capacity / totalCapacity
		}
		exactTotal := 0.0
		if totalCapacity > 0 {
			exactTotal = float64(len(endpoints)) * zone.Capacity / totalCapacity
		}
		if got := result.WeightedTargets[zone.Name]; math.Abs(got-exactWeighted) > 1e-12 {
			t.Errorf("WeightedTargets[%q] = %v, want %v", zone.Name, got, exactWeighted)
		}
		if got := result.TotalTargets[zone.Name]; math.Abs(got-exactTotal) > 1e-12 {
			t.Errorf("TotalTargets[%q] = %v, want %v", zone.Name, got, exactTotal)
		}

		maxDeviation := DefaultMaxDeviation
		if len(options) > 0 && options[0].MaxDeviation > 0 {
			maxDeviation = options[0].MaxDeviation
		}
		if got := math.Abs(float64(result.WeightedCounts[zone.Name]) - exactWeighted); got > maxDeviation+1e-9 {
			t.Errorf("weighted deviation for zone %q = %v, want <= %v", zone.Name, got, maxDeviation)
		}
		if got := math.Abs(float64(result.Counts[zone.Name]) - exactTotal); got > maxDeviation+1e-9 {
			t.Errorf("total deviation for zone %q = %v, want <= %v", zone.Name, got, maxDeviation)
		}
	}
	if sumCounts != len(endpoints) {
		t.Errorf("sum(Counts) = %d, want %d", sumCounts, len(endpoints))
	}
	if sumWeighted != weightedTotal {
		t.Errorf("sum(WeightedCounts) = %d, want %d", sumWeighted, weightedTotal)
	}
}

func checkMoved(t *testing.T, before Assignment, endpoints []Endpoint, result Result) {
	t.Helper()
	var want []string
	for _, endpoint := range endpoints {
		previousZone, ok := before[endpoint.ID]
		if ok && previousZone != result.Assignments[endpoint.ID] {
			want = append(want, endpoint.ID)
		}
	}
	sort.Strings(want)
	if len(result.Moved) != len(want) {
		t.Fatalf("Moved = %v, want %v", result.Moved, want)
	}
	for i := range want {
		if result.Moved[i] != want[i] {
			t.Fatalf("Moved = %v, want %v", result.Moved, want)
		}
	}
	for i := 1; i < len(result.Moved); i++ {
		if result.Moved[i-1] >= result.Moved[i] {
			t.Fatalf("Moved is not strictly ordered: %v", result.Moved)
		}
	}
}

func TestPartitionProportionalCounts(t *testing.T) {
	tests := []struct {
		name       string
		zones      []Zone
		endpoints  []Endpoint
		wantCounts map[string]int
	}{
		{
			name:  "equal zones",
			zones: []Zone{z("a", 1), z("b", 1)},
			endpoints: []Endpoint{
				ep("e1", "", true, false),
				ep("e2", "", true, false),
				ep("e3", "", true, false),
				ep("e4", "", true, false),
			},
			wantCounts: map[string]int{"a": 2, "b": 2},
		},
		{
			name:  "two to one capacity",
			zones: []Zone{z("a", 2), z("b", 1)},
			endpoints: []Endpoint{
				ep("e1", "", true, false),
				ep("e2", "", true, false),
				ep("e3", "", true, false),
				ep("e4", "", true, false),
				ep("e5", "", true, false),
				ep("e6", "", true, false),
			},
			wantCounts: map[string]int{"a": 4, "b": 2},
		},
		{
			name:  "zero capacity zone is inactive",
			zones: []Zone{z("a", 3), z("b", 0)},
			endpoints: []Endpoint{
				ep("e1", "b", true, false),
				ep("e2", "b", true, false),
			},
			wantCounts: map[string]int{"a": 2},
		},
		{
			name:       "no endpoints",
			zones:      []Zone{z("a", 1), z("b", 1)},
			endpoints:  nil,
			wantCounts: map[string]int{"a": 0, "b": 0},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := Partition(test.zones, test.endpoints, nil)
			if err != nil {
				t.Fatalf("Partition() error = %v", err)
			}
			checkInvariants(t, test.zones, test.endpoints, result)
			for zone, want := range test.wantCounts {
				if got := result.Counts[zone]; got != want {
					t.Errorf("Counts[%q] = %d, want %d", zone, got, want)
				}
			}
			if len(result.Moved) != 0 {
				t.Errorf("Moved = %v, want none on first allocation", result.Moved)
			}
		})
	}
}

func TestHintsAreHonoredWithinProportionalTargets(t *testing.T) {
	zones := []Zone{z("a", 2), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "b", true, false),
		ep("e2", "b", true, false),
		ep("e3", "b", true, false),
	}
	result, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, result)
	if result.WeightedCounts["a"] != 2 || result.WeightedCounts["b"] != 1 {
		t.Fatalf("WeightedCounts = %v, want a=2 b=1", result.WeightedCounts)
	}
	hintedInB := 0
	for _, endpoint := range endpoints {
		if result.Assignments[endpoint.ID] == "b" {
			hintedInB++
		}
	}
	if hintedInB != 1 {
		t.Fatalf("zone b received %d hinted endpoints, want 1", hintedInB)
	}
}

func TestTerminatingEndpointsDoNotAddHintWeight(t *testing.T) {
	zones := []Zone{z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("ready-a", "a", true, false),
		ep("ready-b", "b", true, false),
	}
	for i := 0; i < 10; i++ {
		id := "terminating-" + string(rune('a'+i))
		endpoints = append(endpoints, ep(id, "a", false, true))
	}

	result, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, result)

	if result.WeightedCounts["a"] != 1 || result.WeightedCounts["b"] != 1 {
		t.Fatalf("WeightedCounts = %v, want a=1 b=1", result.WeightedCounts)
	}
	// The ten terminating endpoints all hint zone a, but their hint weight is
	// zero, so the total distribution stays proportional (6/6).
	if result.Counts["a"] != 6 || result.Counts["b"] != 6 {
		t.Fatalf("Counts = %v, want a=6 b=6", result.Counts)
	}
	if result.Assignments["ready-a"] != "a" || result.Assignments["ready-b"] != "b" {
		t.Fatalf("ready hints were not honored: %v", result.Assignments)
	}
	terminatingInA := 0
	for _, endpoint := range endpoints {
		if endpoint.Terminating && result.Assignments[endpoint.ID] == "a" {
			terminatingInA++
		}
	}
	if terminatingInA != 5 {
		t.Fatalf("%d terminating endpoints placed in hinted zone a, want 5 (quota-limited)", terminatingInA)
	}
}

func TestTerminatingReadyEndpointStillHasZeroWeight(t *testing.T) {
	zones := []Zone{z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("ready", "a", true, false),
		ep("terminating-ready", "a", true, true),
	}
	result, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, result)
	if got := result.WeightedCounts["a"] + result.WeightedCounts["b"]; got != 1 {
		t.Fatalf("weighted total = %d, want 1", got)
	}
	if result.Counts["a"] != 1 || result.Counts["b"] != 1 {
		t.Fatalf("Counts = %v, want a=1 b=1", result.Counts)
	}
}

func TestZoneAddAndRemoveRebalances(t *testing.T) {
	endpoints := []Endpoint{
		ep("e1", "", true, false),
		ep("e2", "", true, false),
		ep("e3", "", true, false),
		ep("e4", "", true, false),
		ep("e5", "", true, false),
		ep("e6", "", true, false),
	}
	twoZones := []Zone{z("a", 1), z("b", 1)}
	result, err := Partition(twoZones, endpoints, nil)
	if err != nil {
		t.Fatalf("initial Partition() error = %v", err)
	}
	checkInvariants(t, twoZones, endpoints, result)
	if result.Counts["a"] != 3 || result.Counts["b"] != 3 {
		t.Fatalf("initial Counts = %v, want a=3 b=3", result.Counts)
	}

	threeZones := []Zone{z("a", 1), z("b", 1), z("c", 1)}
	before := result.Assignments
	result, err = Partition(threeZones, endpoints, before)
	if err != nil {
		t.Fatalf("zone add Partition() error = %v", err)
	}
	checkInvariants(t, threeZones, endpoints, result)
	checkMoved(t, before, endpoints, result)
	if result.Counts["c"] != 2 {
		t.Fatalf("Counts after add = %v, want c=2", result.Counts)
	}
	if len(result.Moved) != 2 {
		t.Fatalf("moved %d endpoints after adding a zone, want 2", len(result.Moved))
	}

	twoZonesAgain := []Zone{z("a", 1), z("c", 1)}
	before = result.Assignments
	result, err = Partition(twoZonesAgain, endpoints, before)
	if err != nil {
		t.Fatalf("zone remove Partition() error = %v", err)
	}
	checkInvariants(t, twoZonesAgain, endpoints, result)
	checkMoved(t, before, endpoints, result)
	if result.Counts["a"] != 3 || result.Counts["c"] != 3 {
		t.Fatalf("Counts after remove = %v, want a=3 c=3", result.Counts)
	}
	if len(result.Moved) != 2 {
		t.Fatalf("moved %d endpoints after removing a zone, want 2", len(result.Moved))
	}
}

func TestStableTopologyPreservesAssignments(t *testing.T) {
	zones := []Zone{z("a", 2), z("b", 1), z("c", 1)}
	endpoints := []Endpoint{
		ep("e1", "a", true, false),
		ep("e2", "b", true, false),
		ep("e3", "c", true, false),
		ep("e4", "a", true, false),
		ep("e5", "b", false, true),
		ep("e6", "", false, false),
	}
	first, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("first Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, first)

	second, err := Partition(zones, endpoints, first.Assignments)
	if err != nil {
		t.Fatalf("second Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, second)
	checkMoved(t, first.Assignments, endpoints, second)
	if len(second.Moved) != 0 {
		t.Fatalf("Moved = %v, want no movement for stable input", second.Moved)
	}
	if !reflect.DeepEqual(first.Assignments, second.Assignments) {
		t.Fatalf("stable input changed assignment:\nfirst: %v\nsecond: %v", first.Assignments, second.Assignments)
	}
}

func TestReadinessFlipPreservesOtherAssignments(t *testing.T) {
	zones := []Zone{z("a", 1), z("b", 1), z("c", 1)}
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
		t.Fatalf("first Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, first)

	changed := append([]Endpoint(nil), endpoints...)
	changed[0].Ready = false
	second, err := Partition(zones, changed, first.Assignments)
	if err != nil {
		t.Fatalf("second Partition() error = %v", err)
	}
	checkInvariants(t, zones, changed, second)
	checkMoved(t, first.Assignments, changed, second)
	if len(second.Moved) > 1 {
		t.Fatalf("readiness flip moved %d endpoints, want at most 1", len(second.Moved))
	}

	// A terminating endpoint is still sticky and does not consume hint weight.
	terminating := append([]Endpoint(nil), endpoints...)
	terminating[0].Terminating = true
	third, err := Partition(zones, terminating, first.Assignments)
	if err != nil {
		t.Fatalf("third Partition() error = %v", err)
	}
	checkInvariants(t, zones, terminating, third)
	if third.Counts["a"]+third.Counts["b"]+third.Counts["c"] != len(endpoints) {
		t.Fatalf("endpoint count changed after terminating flip: %v", third.Counts)
	}
}

func TestTotalQuotaTieBreakPrefersExistingTerminatingEndpoint(t *testing.T) {
	zones := []Zone{z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "", true, false),
		ep("e2", "", true, false),
		ep("e3", "", true, false),
		ep("e4", "", true, false),
		ep("e5", "", true, false),
	}
	first, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("first Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, first)

	before := first.Assignments
	var terminatingID string
	for _, endpoint := range endpoints {
		if before[endpoint.ID] == "b" {
			terminatingID = endpoint.ID
			break
		}
	}
	if terminatingID == "" {
		t.Fatal("test setup expected at least one endpoint in zone b")
	}
	changed := append([]Endpoint(nil), endpoints...)
	for i := range changed {
		if changed[i].ID == terminatingID {
			changed[i].Ready = false
			changed[i].Terminating = true
		}
	}
	second, err := Partition(zones, changed, before)
	if err != nil {
		t.Fatalf("second Partition() error = %v", err)
	}
	checkInvariants(t, zones, changed, second)
	checkMoved(t, before, changed, second)
	if second.Assignments[terminatingID] != before[terminatingID] {
		t.Fatalf("terminating endpoint %q moved from %q to %q", terminatingID, before[terminatingID], second.Assignments[terminatingID])
	}
	if len(second.Moved) != 1 {
		t.Fatalf("Moved = %v, want exactly one ready endpoint rebalanced", second.Moved)
	}
}

func TestDeterministicAcrossInputOrder(t *testing.T) {
	zones := []Zone{z("c", 2), z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("e6", "b", true, false),
		ep("e1", "a", true, false),
		ep("e5", "c", true, false),
		ep("e3", "b", false, true),
		ep("e4", "", true, false),
		ep("e2", "c", true, false),
	}
	first, err := Partition(zones, endpoints, nil)
	if err != nil {
		t.Fatalf("Partition() error = %v", err)
	}

	reversedZones := []Zone{z("b", 1), z("c", 2), z("a", 1)}
	reversedEndpoints := make([]Endpoint, len(endpoints))
	for i := range endpoints {
		reversedEndpoints[i] = endpoints[len(endpoints)-1-i]
	}
	second, err := Partition(reversedZones, reversedEndpoints, nil)
	if err != nil {
		t.Fatalf("Partition() error = %v", err)
	}
	if !reflect.DeepEqual(first.Assignments, second.Assignments) {
		t.Fatalf("assignment depends on input order:\nfirst: %v\nsecond: %v", first.Assignments, second.Assignments)
	}
}

func TestInvalidInput(t *testing.T) {
	validZones := []Zone{z("a", 1)}
	validEndpoints := []Endpoint{ep("e1", "", true, false)}
	tests := []struct {
		name      string
		zones     []Zone
		endpoints []Endpoint
		options   []Options
		wantErr   error
	}{
		{
			name:      "duplicate endpoint",
			zones:     validZones,
			endpoints: []Endpoint{ep("e1", "", true, false), ep("e1", "", false, true)},
		},
		{
			name:      "empty endpoint id",
			zones:     validZones,
			endpoints: []Endpoint{ep("", "", true, false)},
		},
		{
			name:      "duplicate zone",
			zones:     []Zone{z("a", 1), z("a", 2)},
			endpoints: validEndpoints,
		},
		{
			name:      "empty zone name",
			zones:     []Zone{z("", 1)},
			endpoints: validEndpoints,
		},
		{
			name:      "negative capacity",
			zones:     []Zone{z("a", -1)},
			endpoints: validEndpoints,
		},
		{
			name:      "NaN capacity",
			zones:     []Zone{z("a", math.NaN())},
			endpoints: validEndpoints,
		},
		{
			name:      "infinite capacity",
			zones:     []Zone{z("a", math.Inf(1))},
			endpoints: validEndpoints,
		},
		{
			name:      "no active zones",
			zones:     []Zone{z("a", 0)},
			endpoints: validEndpoints,
			wantErr:   ErrNoActiveZones,
		},
		{
			name:      "invalid deviation",
			zones:     validZones,
			endpoints: validEndpoints,
			options:   []Options{{MaxDeviation: -1}},
		},
		{
			name:      "too many options",
			zones:     validZones,
			endpoints: validEndpoints,
			options:   []Options{{}, {}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Partition(test.zones, test.endpoints, nil, test.options...)
			if err == nil {
				t.Fatal("Partition() error = nil, want error")
			}
			if test.wantErr != nil && !errors.Is(err, test.wantErr) {
				t.Fatalf("Partition() error = %v, want %v", err, test.wantErr)
			}
		})
	}

	result, err := Partition([]Zone{z("a", 0)}, nil, nil)
	if err != nil {
		t.Fatalf("Partition() with no endpoints and no active zones error = %v", err)
	}
	if len(result.Assignments) != 0 || len(result.Counts) != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestVerifyRejectsBadAssignments(t *testing.T) {
	zones := []Zone{z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "", true, false),
		ep("e2", "", true, false),
	}
	tests := []struct {
		name        string
		assignments Assignment
	}{
		{name: "missing endpoint", assignments: Assignment{"e1": "a"}},
		{name: "unknown endpoint", assignments: Assignment{"e1": "a", "e2": "b", "e3": "a"}},
		{name: "inactive zone", assignments: Assignment{"e1": "a", "e2": "c"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := Verify(zones, endpoints, test.assignments); err == nil {
				t.Fatal("Verify() error = nil, want error")
			}
		})
	}
}

func TestAllocatorRetainsStateAndResets(t *testing.T) {
	var allocator Allocator // zero value is usable
	zones := []Zone{z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "", true, false),
		ep("e2", "", true, false),
		ep("e3", "", true, false),
		ep("e4", "", true, false),
	}
	first, err := allocator.Allocate(zones, endpoints)
	if err != nil {
		t.Fatalf("Allocate() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, first)

	stored := allocator.Assignments()
	if !reflect.DeepEqual(stored, first.Assignments) {
		t.Fatalf("Assignments() = %v, want %v", stored, first.Assignments)
	}
	stored["e1"] = "corrupted"
	if allocator.Assignments()["e1"] == "corrupted" {
		t.Fatal("Assignments() returned an alias of internal state")
	}

	second, err := allocator.Allocate(zones, endpoints)
	if err != nil {
		t.Fatalf("Allocate() error = %v", err)
	}
	if len(second.Moved) != 0 {
		t.Fatalf("Moved = %v, want none", second.Moved)
	}

	allocator.Reset()
	third, err := allocator.Allocate(zones, endpoints)
	if err != nil {
		t.Fatalf("Allocate() after Reset error = %v", err)
	}
	if !reflect.DeepEqual(first.Assignments, third.Assignments) {
		t.Fatalf("allocation after Reset = %v, want %v", third.Assignments, first.Assignments)
	}

	// An error must not overwrite the last successful assignment.
	_, err = allocator.Allocate([]Zone{z("a", 0)}, endpoints)
	if !errors.Is(err, ErrNoActiveZones) {
		t.Fatalf("Allocate() error = %v, want ErrNoActiveZones", err)
	}
	if got := allocator.Assignments(); !reflect.DeepEqual(got, third.Assignments) {
		t.Fatalf("failed Allocate changed state: %v, want %v", got, third.Assignments)
	}
}

func TestMaxDeviationBound(t *testing.T) {
	// Two equal zones and three endpoints have exact shares of 1.5 each, so a
	// deviation below 0.5 is infeasible.
	zones := []Zone{z("a", 1), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "", true, false),
		ep("e2", "", true, false),
		ep("e3", "", true, false),
	}
	if _, err := Partition(zones, endpoints, nil, Options{MaxDeviation: 0.4}); err == nil {
		t.Fatal("Partition() error = nil, want infeasible deviation error")
	}
	result, err := Partition(zones, endpoints, nil, Options{MaxDeviation: 0.5})
	if err != nil {
		t.Fatalf("Partition() error = %v", err)
	}
	checkInvariants(t, zones, endpoints, result, Options{MaxDeviation: 0.5})
}

func TestNilAllocatorAndInvalidOptions(t *testing.T) {
	var nilAllocator *Allocator
	zones := []Zone{z("a", 1)}
	endpoints := []Endpoint{ep("e1", "", true, false)}
	if _, err := nilAllocator.Allocate(zones, endpoints); err == nil {
		t.Fatal("nil Allocator.Allocate() error = nil, want error")
	}
	if nilAllocator.Assignments() != nil {
		t.Fatal("nil Allocator.Assignments() should return nil")
	}
	nilAllocator.Reset() // must not panic

	tooMany := NewAllocator(Options{}, Options{})
	if _, err := tooMany.Allocate(zones, endpoints); err == nil {
		t.Fatal("Allocate() with invalid constructor options error = nil, want error")
	}
	if _, err := tooMany.Allocate(zones, endpoints, Options{}); err != nil {
		t.Fatalf("per-call options should override constructor options: %v", err)
	}

	invalid := NewAllocator(Options{MaxDeviation: math.NaN()})
	if _, err := invalid.Allocate(zones, endpoints); err == nil {
		t.Fatal("Allocate() with NaN deviation error = nil, want error")
	}
}

func TestAllocatorConcurrentUse(t *testing.T) {
	allocator := NewAllocator()
	zones := []Zone{z("a", 2), z("b", 1)}
	endpoints := []Endpoint{
		ep("e1", "a", true, false),
		ep("e2", "b", true, false),
		ep("e3", "", true, false),
		ep("e4", "", false, true),
	}
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for iteration := 0; iteration < 50; iteration++ {
				result, err := allocator.Allocate(zones, endpoints)
				if err != nil {
					t.Errorf("Allocate() error = %v", err)
					return
				}
				if len(result.Assignments) != len(endpoints) {
					t.Errorf("assignments = %d, want %d", len(result.Assignments), len(endpoints))
					return
				}
				want := allocator.Assignments()
				if len(want) != len(endpoints) {
					t.Errorf("stored assignments = %d, want %d", len(want), len(endpoints))
					return
				}
			}
		}()
	}
	wg.Wait()
}
