package formal

type timerKind uint8

const (
	fireTimer timerKind = iota
	cleanupTimer
)

// timer is one scheduled event-time callback. Timers are keyed by (Window,
// Kind): when a session window is merged away its timers are cancelled and the
// same logical slot on the merged window is scheduled instead.
type timer struct {
	id      int64
	when    int64
	kind    timerKind
	window  Window
	active  bool
	heapIdx int
}

// timerService keeps live timers in a min-heap ordered by (when, id) and
// indexes them by (Window, Kind). Cancelling or firing a timer removes it from
// both structures, so old session callbacks become logically invalid and the
// same slot can be scheduled again on the merged window.
type timerService struct {
	nextID   int64
	heap     []*timer
	registry map[timerKey]*timer
}

type timerKey struct {
	start int64
	end   int64
	kind  timerKind
}

func newTimerService() *timerService {
	return &timerService{registry: make(map[timerKey]*timer)}
}

// register schedules the timer for (window, kind) at when. An existing active
// timer for the same slot is cancelled first, so every logical slot has at
// most one live callback.
func (s *timerService) register(window Window, kind timerKind, when int64) *timer {
	key := timerKey{window.Start, window.End, kind}
	if old, ok := s.registry[key]; ok && old.active {
		s.cancel(old)
	}
	t := &timer{
		id:      s.nextID,
		when:    when,
		kind:    kind,
		window:  window,
		active:  true,
		heapIdx: len(s.heap),
	}
	s.nextID++
	s.registry[key] = t
	s.heap = append(s.heap, t)
	s.up(len(s.heap) - 1)
	return t
}

func (s *timerService) cancel(t *timer) {
	if !t.active {
		return
	}
	t.active = false
	delete(s.registry, timerKey{t.window.Start, t.window.End, t.kind})
	idx := t.heapIdx
	last := len(s.heap) - 1
	if idx != last {
		s.heap[idx] = s.heap[last]
		s.heap[idx].heapIdx = idx
	}
	s.heap = s.heap[:last]
	if idx < len(s.heap) {
		s.down(idx)
		s.up(idx)
	}
}

// due returns and removes every active timer whose timestamp is at most
// watermark, in chronological order.
func (s *timerService) due(watermark int64) []*timer {
	var fired []*timer
	for len(s.heap) > 0 && s.heap[0].when <= watermark {
		t := s.heap[0]
		fired = append(fired, t)
		last := len(s.heap) - 1
		s.heap[0] = s.heap[last]
		s.heap[0].heapIdx = 0
		s.heap = s.heap[:last]
		if len(s.heap) > 0 {
			s.down(0)
		}
	}
	return fired
}

func (s *timerService) activeCount() int { return len(s.heap) }

func (s *timerService) less(i, j int) bool {
	if s.heap[i].when != s.heap[j].when {
		return s.heap[i].when < s.heap[j].when
	}
	return s.heap[i].id < s.heap[j].id
}

func (s *timerService) swap(i, j int) {
	s.heap[i], s.heap[j] = s.heap[j], s.heap[i]
	s.heap[i].heapIdx = i
	s.heap[j].heapIdx = j
}

func (s *timerService) up(i int) {
	for i > 0 {
		parent := (i - 1) / 2
		if !s.less(i, parent) {
			return
		}
		s.swap(i, parent)
		i = parent
	}
}

func (s *timerService) down(i int) {
	for {
		left := 2*i + 1
		right := left + 1
		smallest := i
		if left < len(s.heap) && s.less(left, smallest) {
			smallest = left
		}
		if right < len(s.heap) && s.less(right, smallest) {
			smallest = right
		}
		if smallest == i {
			return
		}
		s.swap(i, smallest)
		i = smallest
	}
}
