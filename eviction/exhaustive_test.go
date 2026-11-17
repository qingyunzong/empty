package eviction

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"testing"
)

// corpus enumerates pods covering every combination of the ranking
// attributes, with unique names.
func corpus() []Pod {
	var pods []Pod
	for _, qos := range []QoSClass{QoSBestEffort, QoSBurstable, QoSGuaranteed} {
		for _, prio := range []int32{-1, 0, 1} {
			for _, excess := range []int64{0, 5} {
				for _, cost := range []int64{0, 1} {
					pods = append(pods, Pod{
						Name:            fmt.Sprintf("p%02d", len(pods)),
						QoS:             qos,
						Priority:        prio,
						Requests:        Resources{ResourceMemory: 10},
						Usage:           Resources{ResourceMemory: 10 + excess},
						TerminationCost: cost,
					})
				}
			}
		}
	}
	return pods
}

func permutations(items []Pod, emit func([]Pod)) {
	var rec func(k int)
	rec = func(k int) {
		if k == len(items) {
			emit(items)
			return
		}
		for i := k; i < len(items); i++ {
			items[k], items[i] = items[i], items[k]
			rec(k + 1)
			items[k], items[i] = items[i], items[k]
		}
	}
	rec(0)
}

func sameDecision(a, b Decision) bool {
	return reflect.DeepEqual(a.Pressures, b.Pressures) &&
		a.Relieved == b.Relieved &&
		reflect.DeepEqual(podNames(a.Evict), podNames(b.Evict)) &&
		reflect.DeepEqual(podNames(a.InFlight), podNames(b.InFlight))
}

// TestLessIsTotalOrder exhaustively checks irreflexivity, antisymmetry,
// comparability and transitivity over the full attribute corpus.
func TestLessIsTotalOrder(t *testing.T) {
	pods := corpus()
	pressures := []Resource{ResourceMemory}
	for _, a := range pods {
		for _, b := range pods {
			ab, ba := Less(a, b, pressures), Less(b, a, pressures)
			if ab && ba {
				t.Fatalf("Less(%s,%s) and Less(%s,%s) both true", a.Name, b.Name, b.Name, a.Name)
			}
			if a.Name == b.Name {
				if ab || ba {
					t.Fatalf("Less(%s,%s) must be irreflexive", a.Name, b.Name)
				}
			} else if !ab && !ba {
				t.Fatalf("%s and %s are incomparable; name tie-break must make the order total", a.Name, b.Name)
			}
		}
	}
	for _, a := range pods {
		for _, b := range pods {
			for _, c := range pods {
				if Less(a, b, pressures) && Less(b, c, pressures) && !Less(a, c, pressures) {
					t.Fatalf("intransitive: %s < %s < %s but not %s < %s", a.Name, b.Name, c.Name, a.Name, c.Name)
				}
			}
		}
	}
}

// TestTieBreakDeterminism builds pods identical in every ranking key
// except the name and checks every input permutation yields the same
// eviction order.
func TestTieBreakDeterminism(t *testing.T) {
	m := testManager()
	pods := []Pod{
		{Name: "delta", Usage: Resources{ResourceMemory: 40}},
		{Name: "alpha", Usage: Resources{ResourceMemory: 40}},
		{Name: "echo", Usage: Resources{ResourceMemory: 40}},
		{Name: "bravo", Usage: Resources{ResourceMemory: 40}},
		{Name: "charlie", Usage: Resources{ResourceMemory: 40}},
	}
	available := Resources{ResourceMemory: 0, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	want := []string{"alpha", "bravo", "charlie"} // 3*40 >= 100, name order
	permutations(pods, func(perm []Pod) {
		d := m.Plan(perm, available)
		if got := podNames(d.Evict); !reflect.DeepEqual(got, want) {
			t.Fatalf("Evict = %v, want %v for every input permutation", got, want)
		}
	})
}

// TestPlanDeterministicUnderPermutation shuffles a mixed pod set through
// every permutation and requires identical decisions.
func TestPlanDeterministicUnderPermutation(t *testing.T) {
	m := testManager()
	pods := append([]Pod{
		{Name: "zz-dying", Terminating: true, Usage: Resources{ResourceMemory: 30}},
	}, corpus()[:6]...)
	available := Resources{ResourceMemory: 10, ResourceDisk: 100, ResourceInodes: 10, ResourcePIDs: 5}
	want := m.Plan(pods, available)
	permutations(pods, func(perm []Pod) {
		if got := m.Plan(perm, available); !sameDecision(got, want) {
			t.Fatalf("decision differs under permutation:\n got %+v\nwant %+v", got, want)
		}
	})
}

// TestMinimalReleaseSetExhaustive generates random multi-resource
// scenarios and, for each, exhaustively enumerates candidate subsets to
// verify the decision is the minimal relieving prefix of the ranked
// order, irredundant, and complete.
func TestMinimalReleaseSetExhaustive(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for trial := 0; trial < 300; trial++ {
		m := &Manager{Thresholds: Resources{
			ResourceMemory: int64(rng.IntN(120)),
			ResourceDisk:   int64(rng.IntN(120)),
		}}
		available := Resources{
			ResourceMemory: int64(rng.IntN(60)),
			ResourceDisk:   int64(rng.IntN(60)),
		}
		n := 1 + rng.IntN(7) // 1..7 pods, subsets stay cheap to enumerate
		pods := make([]Pod, n)
		for i := range pods {
			pods[i] = Pod{
				Name: fmt.Sprintf("t%d-p%d", trial, i),
				Usage: Resources{
					ResourceMemory: int64(rng.IntN(50)),
					ResourceDisk:   int64(rng.IntN(50)),
				},
				Terminating: rng.IntN(4) == 0,
			}
		}
		d := m.Plan(pods, available)

		var inFlight, candidates []Pod
		for _, p := range pods {
			if p.Terminating {
				inFlight = append(inFlight, p)
			} else {
				candidates = append(candidates, p)
			}
		}
		base := Project(available, inFlight...)
		relieves := func(set []Pod) bool {
			return m.Relieved(Project(base, set...), d.Pressures)
		}

		// The decision must be a subsequence of the ranked candidate
		// order: selection and elimination never reorder or skip ahead.
		ranked := RankPods(candidates, d.Pressures)
		next := 0
		for _, p := range ranked {
			if next < len(d.Evict) && p.Name == d.Evict[next].Name {
				next++
			}
		}
		if next != len(d.Evict) {
			t.Fatalf("trial %d: Evict is not a subsequence of the ranked order", trial)
		}

		// Irredundancy: no proper subset of the decision relieves
		// pressure either.
		for mask := 1; mask < 1<<len(d.Evict)-1; mask++ {
			var subset []Pod
			for i, p := range d.Evict {
				if mask&(1<<i) != 0 {
					subset = append(subset, p)
				}
			}
			if relieves(subset) {
				t.Fatalf("trial %d: proper subset %v relieves pressure", trial, podNames(subset))
			}
		}

		// Completeness: Relieved must hold iff some subset of the
		// candidates can relieve the pressure; if none can, every
		// candidate must have been evicted.
		exists := false
		for mask := 0; mask < 1<<len(candidates); mask++ {
			var subset []Pod
			for i, p := range candidates {
				if mask&(1<<i) != 0 {
					subset = append(subset, p)
				}
			}
			if relieves(subset) {
				exists = true
				break
			}
		}
		if exists != d.Relieved {
			t.Fatalf("trial %d: Relieved = %v, but exhaustive search says relieving subset exists = %v", trial, d.Relieved, exists)
		}
		if !exists && len(d.Evict) != len(candidates) {
			t.Fatalf("trial %d: unrelievable pressure must evict all candidates", trial)
		}
		if len(d.Pressures) == 0 && len(d.Evict) != 0 {
			t.Fatalf("trial %d: no pressure must mean no evictions", trial)
		}
	}
}
