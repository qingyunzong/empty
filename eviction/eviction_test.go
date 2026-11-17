package eviction

import (
	"reflect"
	"testing"
)

func testManager() *Manager {
	return &Manager{Thresholds: Resources{
		ResourceMemory: 100,
		ResourceDisk:   100,
		ResourceInodes: 10,
		ResourcePIDs:   5,
	}}
}

func podNames(pods []Pod) []string {
	var names []string
	for _, p := range pods {
		names = append(names, p.Name)
	}
	return names
}

func TestPressuredBoundary(t *testing.T) {
	m := testManager()
	at := Resources{ResourceMemory: 100, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	if got := m.Pressured(at); len(got) != 0 {
		t.Fatalf("available equal to thresholds must not be pressure, got %v", got)
	}
	below := Resources{ResourceMemory: 99, ResourceDisk: 100, ResourceInodes: 9, ResourcePIDs: 4}
	want := []Resource{ResourceMemory, ResourceInodes, ResourcePIDs}
	if got := m.Pressured(below); !reflect.DeepEqual(got, want) {
		t.Fatalf("Pressured = %v, want %v (fixed AllResources order)", got, want)
	}
}

func TestNoPressureNoEviction(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "a", Usage: Resources{ResourceMemory: 50}},
		{Name: "b", Terminating: true, Usage: Resources{ResourceMemory: 50}},
	}
	available := Resources{ResourceMemory: 500, ResourceDisk: 500, ResourceInodes: 50, ResourcePIDs: 50}
	d := m.Plan(pods, available)
	if len(d.Pressures) != 0 || len(d.Evict) != 0 {
		t.Fatalf("no pressure must mean no new evictions, got %+v", d)
	}
	if !d.Relieved {
		t.Fatal("no pressure must report Relieved")
	}
	if got := podNames(d.InFlight); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("in-flight termination must be kept, not revoked: %v", got)
	}
}

func TestInFlightTerminationSuffices(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "dying", Terminating: true, Usage: Resources{ResourceMemory: 300}},
		{Name: "healthy", Usage: Resources{ResourceMemory: 300}},
	}
	available := Resources{ResourceMemory: 0, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	d := m.Plan(pods, available)
	if len(d.Evict) != 0 {
		t.Fatalf("in-flight reclaim already relieves pressure, must not evict: %v", podNames(d.Evict))
	}
	if !d.Relieved {
		t.Fatal("projected availability must satisfy thresholds")
	}
}

func TestTerminatingPodNeverReselected(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "dying", Terminating: true, Usage: Resources{ResourceMemory: 50}},
		{Name: "next", Usage: Resources{ResourceMemory: 200}},
	}
	available := Resources{ResourceMemory: 0, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	d := m.Plan(pods, available)
	if got := podNames(d.Evict); !reflect.DeepEqual(got, []string{"next"}) {
		t.Fatalf("Evict = %v, want [next]; terminating pod must not be re-selected", got)
	}
	if got := podNames(d.InFlight); !reflect.DeepEqual(got, []string{"dying"}) {
		t.Fatalf("InFlight = %v, want [dying]", got)
	}
}

func TestRankingOrder(t *testing.T) {
	pressures := []Resource{ResourceMemory}
	pods := []Pod{
		{Name: "guaranteed", QoS: QoSGuaranteed, Priority: -1000, Usage: Resources{ResourceMemory: 9999}},
		{Name: "burstable-low-prio", QoS: QoSBurstable, Priority: -5, Usage: Resources{ResourceMemory: 1}},
		{Name: "besteffort-high-prio", QoS: QoSBestEffort, Priority: 100, Usage: Resources{ResourceMemory: 1}},
		{Name: "besteffort-big-excess", QoS: QoSBestEffort, Priority: 100,
			Requests: Resources{ResourceMemory: 10}, Usage: Resources{ResourceMemory: 60}},
		{Name: "besteffort-small-excess-costly", QoS: QoSBestEffort, Priority: 100,
			Requests: Resources{ResourceMemory: 10}, Usage: Resources{ResourceMemory: 20}, TerminationCost: 5},
		{Name: "besteffort-small-excess-cheap", QoS: QoSBestEffort, Priority: 100,
			Requests: Resources{ResourceMemory: 10}, Usage: Resources{ResourceMemory: 20}, TerminationCost: 1},
	}
	got := podNames(RankPods(pods, pressures))
	want := []string{
		"besteffort-big-excess",          // QoS, then priority, then excess desc
		"besteffort-small-excess-cheap",  // equal excess: lower cost first
		"besteffort-small-excess-costly", // then higher cost
		"besteffort-high-prio",           // zero excess last within the class
		"burstable-low-prio",             // higher QoS class evicted later
		"guaranteed",                     // guaranteed always last
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rank order = %v, want %v", got, want)
	}
}

func TestMinimalPrefixStopsEarly(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "first", Usage: Resources{ResourceMemory: 60}},
		{Name: "second", Usage: Resources{ResourceMemory: 60}},
		{Name: "third", Usage: Resources{ResourceMemory: 60}},
	}
	available := Resources{ResourceMemory: 0, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	d := m.Plan(pods, available)
	if got := podNames(d.Evict); !reflect.DeepEqual(got, []string{"first", "second"}) {
		t.Fatalf("Evict = %v, want the minimal relieving prefix [first second]", got)
	}
	if !d.Relieved {
		t.Fatal("selected prefix must relieve the pressure")
	}
}

func TestMultiResourcePressure(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "mem-hog", Usage: Resources{ResourceMemory: 150}},
		{Name: "pid-hog", Usage: Resources{ResourcePIDs: 10}},
	}
	available := Resources{ResourceMemory: 0, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 0}
	d := m.Plan(pods, available)
	if want := []Resource{ResourceMemory, ResourcePIDs}; !reflect.DeepEqual(d.Pressures, want) {
		t.Fatalf("Pressures = %v, want %v", d.Pressures, want)
	}
	if len(d.Evict) != 2 || !d.Relieved {
		t.Fatalf("both pressured resources must be relieved, got %+v", d)
	}
}

func TestUnrelievablePressureEvictsAll(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "only", Usage: Resources{ResourceMemory: 10}},
	}
	available := Resources{ResourceMemory: 0, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	d := m.Plan(pods, available)
	if got := podNames(d.Evict); !reflect.DeepEqual(got, []string{"only"}) {
		t.Fatalf("Evict = %v, want [only]", got)
	}
	if d.Relieved {
		t.Fatal("pressure cannot be relieved by the available pods")
	}
}
