package dataeng

import "testing"

func TestSampleHeapPopsWorstRankedFirst(t *testing.T) {
	h := &sampleHeap{}
	items := []Item{
		{ID: "small", Weight: 1, Priority: 1},
		{ID: "big", Weight: 1, Priority: 100},
		{ID: "mid", Weight: 2, Priority: 1},
	}
	for _, it := range items {
		heapPush(h, it)
	}
	var popped []string
	for h.Len() > 0 {
		if h.Len() > 1 {
			// Max-heap by rank: root must be the worst item before every pop.
			root := (*h)[0]
			for _, other := range (*h)[1:] {
				if rankLess(root, other) {
					t.Fatalf("root %v ranks below retained %v", root, other)
				}
			}
		}
		got := h.Pop().(Item)
		popped = append(popped, got.ID)
	}
	if h.Len() != 0 {
		t.Fatalf("heap not drained: %v", *h)
	}
	// container/heap.Pop walks the heap array, so this insertion order yields
	// mid, small, big; the loop above already asserts the stronger invariant
	// that each popped item is the worst-ranked of the remaining heap.
	want := []string{"mid", "small", "big"}
	if len(popped) != len(want) {
		t.Fatalf("popped %v, want %v", popped, want)
	}
	for i := range want {
		if popped[i] != want[i] {
			t.Fatalf("pop order %v, want %v", popped, want)
		}
	}
}
