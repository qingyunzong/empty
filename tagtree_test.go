package tagtree

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// referenceEvidence is an independent oracle: for every event, for every
// original tag, it walks the parent chain one hop at a time and records the
// event at every ancestor reached. It shares no code with Library.Evidence.
func referenceEvidence(t *Tree, events map[string][]int, node int) []Contribution {
	out := make([]Contribution, 0, len(events))
	for id, tags := range events {
		viaSet := make(map[int]bool)
		for _, tag := range tags {
			for cur := tag; ; {
				if cur == node {
					viaSet[tag] = true
					break
				}
				p, ok := t.Parent(cur)
				if !ok {
					break
				}
				cur = p
			}
		}
		if len(viaSet) > 0 {
			via := make([]int, 0, len(viaSet))
			for tag := range viaSet {
				via = append(via, tag)
			}
			sort.Ints(via)
			out = append(out, Contribution{EventID: id, Via: via})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EventID < out[j].EventID })
	return out
}

func buildSample(t *testing.T) (*Tree, *Library) {
	t.Helper()
	//       1
	//      / \
	//     2   3
	//    / \   \
	//   4   5   6
	tr := NewTree()
	for _, id := range []int{1, 2, 3, 4, 5, 6} {
		tr.AddNode(id)
	}
	for _, e := range [][2]int{{1, 2}, {1, 3}, {2, 4}, {2, 5}, {3, 6}} {
		if err := tr.AddEdge(e[0], e[1]); err != nil {
			t.Fatalf("AddEdge(%d,%d): %v", e[0], e[1], err)
		}
	}
	lib := NewLibrary(tr)
	mustEvent(t, lib, "e1", 4)    // under 2
	mustEvent(t, lib, "e2", 4, 5) // twice under 2 -> counts once
	mustEvent(t, lib, "e3", 5, 6) // spans 2 and 3
	mustEvent(t, lib, "e4", 6)    // under 3
	return tr, lib
}

func mustEvent(t *testing.T, lib *Library, id string, tags ...int) {
	t.Helper()
	if err := lib.AddEvent(id, tags...); err != nil {
		t.Fatalf("AddEvent(%s): %v", id, err)
	}
}

func TestAncestorCountsEventOnce(t *testing.T) {
	_, lib := buildSample(t)
	if got, want := lib.Count(2), 3; got != want {
		t.Errorf("Count(2) = %d, want %d (e1, e2 once, e3)", got, want)
	}
	if got, want := lib.Count(1), 4; got != want {
		t.Errorf("Count(1) = %d, want %d", got, want)
	}
	if got, want := lib.Count(3), 2; got != want {
		t.Errorf("Count(3) = %d, want %d (e3, e4)", got, want)
	}
}

func TestEvidenceListsViaNodes(t *testing.T) {
	_, lib := buildSample(t)
	want := []Contribution{
		{EventID: "e1", Via: []int{4}},
		{EventID: "e2", Via: []int{4, 5}},
		{EventID: "e3", Via: []int{5}},
	}
	if got := lib.Evidence(2); !reflect.DeepEqual(got, want) {
		t.Errorf("Evidence(2) = %+v, want %+v", got, want)
	}
}

func TestRemoveEdgeChangesMembershipNotTags(t *testing.T) {
	tr, lib := buildSample(t)
	before := lib.Tags("e3")
	if err := tr.RemoveEdge(1, 2); err != nil {
		t.Fatalf("RemoveEdge: %v", err)
	}
	// Aggregation membership changed: subtree of 1 no longer includes 2,4,5.
	if got, want := lib.Count(1), 2; got != want {
		t.Errorf("after detach Count(1) = %d, want %d (e3, e4)", got, want)
	}
	if got, want := lib.Count(2), 3; got != want {
		t.Errorf("after detach Count(2) = %d, want %d (subtree intact)", got, want)
	}
	// Original tags untouched.
	if got := lib.Tags("e3"); !reflect.DeepEqual(got, before) {
		t.Errorf("tags of e3 changed: got %v, want %v", got, before)
	}
	// Evidence at 1 still credits e3, but only via the surviving branch.
	want := []Contribution{
		{EventID: "e3", Via: []int{6}},
		{EventID: "e4", Via: []int{6}},
	}
	if got := lib.Evidence(1); !reflect.DeepEqual(got, want) {
		t.Errorf("after detach Evidence(1) = %+v, want %+v", got, want)
	}
}

func TestTreeEditErrors(t *testing.T) {
	tr, _ := buildSample(t)
	if err := tr.AddEdge(4, 1); err == nil {
		t.Error("AddEdge(4,1): expected cycle error")
	}
	if err := tr.AddEdge(1, 2); err == nil {
		t.Error("AddEdge(1,2): expected duplicate-parent error")
	}
	if err := tr.AddEdge(1, 99); err == nil {
		t.Error("AddEdge(1,99): expected missing-node error")
	}
	if err := tr.RemoveEdge(1, 4); err == nil {
		t.Error("RemoveEdge(1,4): expected missing-edge error")
	}
	if err := tr.RemoveEdge(2, 4); err != nil {
		t.Fatalf("RemoveEdge(2,4): %v", err)
	}
	if err := tr.RemoveEdge(2, 4); err == nil {
		t.Error("second RemoveEdge(2,4): expected error")
	}
}

func TestAddEventValidation(t *testing.T) {
	tr := NewTree()
	tr.AddNode(1)
	lib := NewLibrary(tr)
	if err := lib.AddEvent("e0"); err == nil {
		t.Error("AddEvent with no tags: expected error")
	}
	if err := lib.AddEvent("e1", 7); err == nil {
		t.Error("AddEvent with unknown tag: expected error")
	}
}

// TestSmallTreeReachabilityCrossCheck rebuilds random small trees with random
// multi-tag events, applies random edge deletions, and after every step
// recomputes each event's reachability hop-by-hop as an oracle for both
// Count and Evidence.
func TestSmallTreeReachabilityCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 200; trial++ {
		n := 2 + rng.Intn(7) // 2..8 nodes
		tr := NewTree()
		for id := 0; id < n; id++ {
			tr.AddNode(id)
		}
		// Random tree: node i (>=1) attaches to a uniform earlier node.
		edges := make([][2]int, 0, n-1)
		for id := 1; id < n; id++ {
			p := rng.Intn(id)
			if err := tr.AddEdge(p, id); err != nil {
				t.Fatalf("trial %d: AddEdge(%d,%d): %v", trial, p, id, err)
			}
			edges = append(edges, [2]int{p, id})
		}
		lib := NewLibrary(tr)
		events := make(map[string][]int)
		for e := 0; e < 1+rng.Intn(10); e++ {
			id := fmt.Sprintf("ev%d", e)
			k := 1 + rng.Intn(min(3, n))
			perm := rng.Perm(n)[:k]
			tags := make([]int, k)
			copy(tags, perm)
			if err := lib.AddEvent(id, tags...); err != nil {
				t.Fatalf("trial %d: AddEvent: %v", trial, err)
			}
			events[id] = tags
		}

		check := func(step string) {
			t.Helper()
			for node := 0; node < n; node++ {
				want := referenceEvidence(tr, events, node)
				if got := lib.Evidence(node); !reflect.DeepEqual(got, want) {
					t.Fatalf("trial %d %s: Evidence(%d) = %+v, oracle %+v", trial, step, node, got, want)
				}
				if got, want := lib.Count(node), len(want); got != want {
					t.Fatalf("trial %d %s: Count(%d) = %d, oracle %d", trial, step, node, got, want)
				}
			}
		}
		check("initial")

		// Delete edges in random order; re-verify after each deletion.
		for _, i := range rng.Perm(len(edges)) {
			e := edges[i]
			if err := tr.RemoveEdge(e[0], e[1]); err != nil {
				t.Fatalf("trial %d: RemoveEdge(%d,%d): %v", trial, e[0], e[1], err)
			}
			check(fmt.Sprintf("after RemoveEdge(%d,%d)", e[0], e[1]))
			// Original tags must survive every deletion.
			for id, tags := range events {
				got := lib.Tags(id)
				want := append([]int(nil), tags...)
				sort.Ints(want)
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("trial %d: tags of %s = %v, want %v", trial, id, got, want)
				}
			}
		}
	}
}
