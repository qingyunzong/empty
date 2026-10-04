package frameidx

import (
	"container/heap"
	"errors"
	"fmt"
)

// Certificate is a topological certificate for a seek closure: a concrete
// decode order in which every frame is preceded by all of its references.
type Certificate struct {
	Order []int64
}

// newCertificate builds the decode order with Kahn's algorithm, breaking ties
// by (DTS, ID). Display time (PTS) is never consulted: display order is not a
// valid decode order.
func (ix *Index) newCertificate(closure []int64) *Certificate {
	inSet := make(map[int64]bool, len(closure))
	for _, id := range closure {
		inSet[id] = true
	}
	indeg := make(map[int64]int, len(closure))
	dependents := make(map[int64][]int64, len(closure))
	for _, id := range closure {
		for _, r := range ix.frames[id].Refs {
			if !inSet[r] {
				continue
			}
			indeg[id]++
			dependents[r] = append(dependents[r], id)
		}
	}
	ready := &frameHeap{}
	for _, id := range closure {
		if indeg[id] == 0 {
			heap.Push(ready, ix.frames[id])
		}
	}
	order := make([]int64, 0, len(closure))
	for ready.Len() > 0 {
		f := heap.Pop(ready).(Frame)
		order = append(order, f.ID)
		for _, d := range dependents[f.ID] {
			indeg[d]--
			if indeg[d] == 0 {
				heap.Push(ready, ix.frames[d])
			}
		}
	}
	return &Certificate{Order: order}
}

// Verify cross-checks the certificate against an independent full-graph DFS
// model. It confirms that:
//
//  1. the certificate covers exactly the frames reachable from targets —
//     completeness and minimality of the closure;
//  2. every frame in the order is preceded by all of its references —
//     the order is a valid linear extension of the dependency poset.
//
// A nil certificate, duplicate or unknown entries, missing required frames,
// unneeded frames, and dependency-order violations all fail verification.
func (c *Certificate) Verify(ix *Index, targets []int64) error {
	if c == nil {
		return errors.New("frameidx: nil certificate")
	}
	model := dfsReachable(ix, targets)
	position := make(map[int64]int, len(c.Order))
	for pos, id := range c.Order {
		if _, dup := position[id]; dup {
			return fmt.Errorf("frameidx: certificate lists frame %d twice", id)
		}
		if _, ok := ix.frames[id]; !ok {
			return fmt.Errorf("frameidx: certificate lists unknown frame %d", id)
		}
		position[id] = pos
	}
	for id := range model {
		if _, ok := position[id]; !ok {
			return fmt.Errorf("frameidx: certificate omits required frame %d", id)
		}
	}
	for _, id := range c.Order {
		if !model[id] {
			return fmt.Errorf("frameidx: certificate contains unneeded frame %d", id)
		}
	}
	for pos, id := range c.Order {
		for _, r := range ix.frames[id].Refs {
			rp, ok := position[r]
			if !ok {
				continue // dangling reference, reported separately
			}
			if rp >= pos {
				return fmt.Errorf("frameidx: frame %d decoded before its reference %d", id, r)
			}
		}
	}
	return nil
}

// dfsReachable is the independent verification model: a plain depth-first
// traversal of the whole graph from the seed frames, following reference
// edges. It deliberately shares no code with the seek closure computation.
func dfsReachable(ix *Index, seeds []int64) map[int64]bool {
	reached := make(map[int64]bool)
	var stack []int64
	for _, s := range seeds {
		if _, ok := ix.frames[s]; ok && !reached[s] {
			reached[s] = true
			stack = append(stack, s)
		}
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, r := range ix.frames[id].Refs {
			if _, ok := ix.frames[r]; ok && !reached[r] {
				reached[r] = true
				stack = append(stack, r)
			}
		}
	}
	return reached
}

// frameHeap is a min-heap of frames keyed by (DTS, ID).
type frameHeap []Frame

func (h frameHeap) Len() int { return len(h) }

func (h frameHeap) Less(i, j int) bool {
	if h[i].DTS != h[j].DTS {
		return h[i].DTS < h[j].DTS
	}
	return h[i].ID < h[j].ID
}

func (h frameHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *frameHeap) Push(x any) { *h = append(*h, x.(Frame)) }

func (h *frameHeap) Pop() any {
	old := *h
	n := len(old)
	f := old[n-1]
	*h = old[:n-1]
	return f
}
