package dataeng

import "container/heap"

// taskHeap orders pending tasks by (Ready, Seq): earliest ready time first,
// lowest submission sequence breaking ties.
type taskHeap struct {
	tasks []*entry
}

func newTaskHeap() *taskHeap {
	h := &taskHeap{}
	heap.Init(h)
	return h
}

func (h taskHeap) Len() int { return len(h.tasks) }

func (h taskHeap) Less(i, j int) bool {
	a, b := h.tasks[i].task, h.tasks[j].task
	if !a.Ready.Equal(b.Ready) {
		return a.Ready.Before(b.Ready)
	}
	return a.Seq < b.Seq
}

func (h taskHeap) Swap(i, j int) {
	h.tasks[i], h.tasks[j] = h.tasks[j], h.tasks[i]
	h.tasks[i].index = i
	h.tasks[j].index = j
}

func (h *taskHeap) Push(x any) {
	e := x.(*entry)
	e.index = len(h.tasks)
	h.tasks = append(h.tasks, e)
}

func (h *taskHeap) Pop() any {
	n := len(h.tasks)
	e := h.tasks[n-1]
	e.index = -1
	h.tasks = h.tasks[:n-1]
	return e
}
