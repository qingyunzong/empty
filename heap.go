package dataeng

import (
	"container/heap"
	"sort"
)

func heapPush(h *sampleHeap, item Item) { heap.Push(h, item) }

func heapFix(h *sampleHeap, i int) { heap.Fix(h, i) }

// sortedSample copies the retained items into a slice ordered by ascending
// rank. The heap itself is left untouched.
func sortedSample(h sampleHeap) []Item {
	if len(h) == 0 {
		return []Item{}
	}
	out := append([]Item(nil), h...)
	sort.Slice(out, func(i, j int) bool { return rankLess(out[i], out[j]) })
	return out
}
