package formal

import (
	"container/heap"
	"time"
)

type delayedEvent struct {
	at      time.Time
	pending *pendingEvent
	index   int
}

type delayedHeap []*delayedEvent

func (h delayedHeap) Len() int {
	return len(h)
}

func (h delayedHeap) Less(i, j int) bool {
	return h[i].at.Before(h[j].at)
}

func (h delayedHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *delayedHeap) Push(value any) {
	item := value.(*delayedEvent)
	item.index = len(*h)
	*h = append(*h, item)
}

func (h *delayedHeap) Pop() any {
	old := *h
	last := len(old) - 1
	item := old[last]
	old[last] = nil
	item.index = -1
	*h = old[:last]
	return item
}

func (h *delayedHeap) remove(item *delayedEvent) {
	if item == nil || item.index < 0 {
		return
	}
	heap.Remove(h, item.index)
}
