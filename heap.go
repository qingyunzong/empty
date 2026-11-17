package formal

// packetHeap orders incomplete datagrams by (deadline, arrival sequence).
// The sequence is a stable tie-breaker when several datagrams share a deadline.
type packetHeap []*packet

func (h packetHeap) Less(i, j int) bool {
	if h[i].deadline.Equal(h[j].deadline) {
		return h[i].seq < h[j].seq
	}
	return h[i].deadline.Before(h[j].deadline)
}

func (h packetHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func heapPush(h *packetHeap, p *packet) {
	*h = append(*h, p)
	p.index = len(*h) - 1
	up(h, p.index)
}

func heapPop(h *packetHeap) *packet {
	n := len(*h)
	top := (*h)[0]
	last := n - 1
	(*h)[0], (*h)[last] = (*h)[last], (*h)[0]
	(*h)[0].index = 0
	top.index = -1
	(*h)[last] = nil
	*h = (*h)[:last]
	if last > 0 {
		down(h, 0)
	}
	return top
}

func heapRemove(h *packetHeap, p *packet) {
	i := p.index
	if i < 0 || i >= len(*h) || (*h)[i] != p {
		return
	}
	n := len(*h) - 1
	if i != n {
		(*h)[i], (*h)[n] = (*h)[n], (*h)[i]
		(*h)[i].index = i
		(*h)[n] = nil
		*h = (*h)[:n]
		if !down(h, i) {
			up(h, i)
		}
	} else {
		(*h)[n] = nil
		*h = (*h)[:n]
	}
	p.index = -1
}

func up(h *packetHeap, i int) bool {
	moved := false
	for i > 0 {
		parent := (i - 1) / 2
		if !h.Less(i, parent) {
			break
		}
		h.Swap(i, parent)
		i = parent
		moved = true
	}
	return moved
}

func down(h *packetHeap, i int) bool {
	moved := false
	n := len(*h)
	for {
		left := 2*i + 1
		if left >= n {
			break
		}
		smallest := left
		right := left + 1
		if right < n && h.Less(right, left) {
			smallest = right
		}
		if !h.Less(smallest, i) {
			break
		}
		h.Swap(i, smallest)
		i = smallest
		moved = true
	}
	return moved
}
