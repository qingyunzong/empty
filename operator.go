package formal

// windowState is the per-window aggregation kept in keyed state.
type windowState struct {
	window Window
	count  int64
	sum    int64
	// fired is true once the window's result has been emitted. Later
	// in-arrival updates then require an explicit retraction before re-emitting.
	fired bool
}

func (s *windowState) row() Row {
	return Row{Window: s.window, Count: s.count, Sum: s.sum}
}

// WindowOperator is an event-time windowing operator usable by runtime
// operator tasks. It maintains event-time watermarks, allowed lateness,
// session-window merging and a retracting changelog, all in recoverable state.
type WindowOperator struct {
	assigner        Assigner
	allowedLateness int64

	watermark int64
	timers    *timerService
	windows   map[int64]map[int64]*windowState

	changes     []Change
	nextSeq     int64
	droppedLate int64
}

// NewWindowOperator builds an operator over the given assigner. A negative
// allowed lateness is treated as zero.
func NewWindowOperator(assigner Assigner, allowedLateness int64) *WindowOperator {
	if assigner == nil {
		panic("formal: assigner must not be nil")
	}
	latency := allowedLateness
	if latency < 0 {
		latency = 0
	}
	return &WindowOperator{
		assigner:        assigner,
		allowedLateness: latency,
		watermark:       MinTimestamp,
		timers:          newTimerService(),
		windows:         make(map[int64]map[int64]*windowState),
	}
}

// Watermark returns the current event-time watermark.
func (op *WindowOperator) Watermark() int64 { return op.watermark }

// DroppedLateEvents returns how many events were discarded as too late.
func (op *WindowOperator) DroppedLateEvents() int64 { return op.droppedLate }

// Changes returns the full changelog emitted so far.
func (op *WindowOperator) Changes() []Change {
	out := make([]Change, len(op.changes))
	copy(out, op.changes)
	return out
}

// ActiveWindowCount returns the number of windows still held in state.
func (op *WindowOperator) ActiveWindowCount() int {
	total := 0
	for _, group := range op.windows {
		total += len(group)
	}
	return total
}

// StateTotals returns the aggregate count and sum across all live windows.
// It supports the invariant that merging windows never loses state.
func (op *WindowOperator) StateTotals() (count, sum int64) {
	for _, group := range op.windows {
		for _, state := range group {
			count += state.count
			sum += state.sum
		}
	}
	return count, sum
}

// Process applies one input signal (event or watermark advance).
func (op *WindowOperator) Process(signal Signal) {
	if signal.IsWatermark {
		op.advanceWatermark(signal.Watermark)
		return
	}
	op.OnEvent(signal.Event)
}

// OnEvent ingests one event, merging sessions or updating tumbling windows.
// Events arriving after watermark > eventTime + allowedLateness are dropped.
func (op *WindowOperator) OnEvent(event Event) {
	windows := op.assigner.Assign(event)
	if len(windows) == 0 {
		return
	}
	target := windows[0]
	if op.watermark != MinTimestamp && event.Timestamp+op.allowedLateness < op.watermark {
		op.droppedLate++
		return
	}
	switch op.assigner.kind() {
	case kindSession:
		op.onSessionEvent(event, target)
	default:
		op.onTumblingEvent(event, target)
	}
}

func (op *WindowOperator) onTumblingEvent(event Event, window Window) {
	state, created := op.getOrCreate(window)
	state.count++
	state.sum += event.Value
	if created {
		op.registerWindowTimers(window)
	}
	if state.fired {
		// The window already produced output; retract the stale row and emit
		// the corrected one so downstream state stays consistent.
		op.emit(Retract, state.row())
		op.emit(Add, state.row())
	}
}

func (op *WindowOperator) onSessionEvent(event Event, initial Window) {
	// Grow the merged interval to a fixed point: overlap is transitive, so a
	// bridge event can connect sessions that do not directly overlap its own
	// initial singleton window.
	mergedWindow := initial
	var matched []*windowState
	for {
		grew := false
		var next []*windowState
		for _, group := range op.windows {
			for _, state := range group {
				if containsState(matched, state) {
					continue
				}
				if state.window.Start <= mergedWindow.End && mergedWindow.Start <= state.window.End {
					next = append(next, state)
					grew = true
				}
			}
		}
		if !grew {
			break
		}
		for _, state := range next {
			matched = append(matched, state)
			if state.window.Start < mergedWindow.Start {
				mergedWindow.Start = state.window.Start
			}
			if state.window.End > mergedWindow.End {
				mergedWindow.End = state.window.End
			}
		}
	}

	// Late check against the eventual merged lifetime: an event is only
	// dropped when even the extended session has passed its late horizon.
	if op.watermark != MinTimestamp && mergedWindow.End+op.allowedLateness < op.watermark {
		op.droppedLate++
		return
	}

	merged := &windowState{window: mergedWindow, count: 1, sum: event.Value}
	anyFired := false
	for _, old := range matched {
		merged.count += old.count
		merged.sum += old.sum
		if old.fired {
			anyFired = true
		}
		op.removeWindow(old.window)
		op.timers.cancelKey(old.window, fireTimer)
		op.timers.cancelKey(old.window, cleanupTimer)
	}
	merged.fired = anyFired
	op.putWindow(merged)

	// If any predecessor row already reached downstream, retract every stale
	// row and emit the merged row so counts and sums are preserved exactly.
	if anyFired {
		for _, old := range matched {
			if old.fired {
				op.emit(Retract, old.row())
			}
		}
		op.emit(Add, merged.row())
	}

	op.registerWindowTimers(mergedWindow)
}

func containsState(states []*windowState, target *windowState) bool {
	for _, state := range states {
		if state == target {
			return true
		}
	}
	return false
}

// registerWindowTimers schedules the event-time fire (window end) and state
// cleanup (window end + allowed lateness) callbacks that are still in the
// future relative to the current watermark.
func (op *WindowOperator) registerWindowTimers(window Window) {
	fireAt := window.End
	cleanupAt := window.End + op.allowedLateness
	if fireAt > op.watermark {
		op.timers.register(window, fireTimer, fireAt)
	} else {
		op.fireWindow(window)
	}
	if cleanupAt > op.watermark {
		op.timers.register(window, cleanupTimer, cleanupAt)
	} else {
		op.purgeWindow(window)
	}
}

// advanceWatermark moves the watermark forward only and fires every timer that
// becomes due. Backwards advances are ignored.
func (op *WindowOperator) advanceWatermark(timestamp int64) {
	if timestamp <= op.watermark {
		return
	}
	op.watermark = timestamp
	for _, t := range op.timers.due(timestamp) {
		op.onTimer(t)
	}
}

func (op *WindowOperator) onTimer(t *timer) {
	// Defensive: stale timers (cancelled during a session merge) must never
	// touch state even if they somehow reached the head of the queue.
	if !t.active {
		return
	}
	t.active = false
	delete(op.timers.registry, timerKey{t.window.Start, t.window.End, t.kind})
	state := op.lookup(t.window)
	if state == nil {
		return
	}
	switch t.kind {
	case fireTimer:
		op.fireState(state)
	case cleanupTimer:
		op.purgeWindow(t.window)
	}
}

func (op *WindowOperator) fireWindow(window Window) {
	if state := op.lookup(window); state != nil {
		op.fireState(state)
	}
}

func (op *WindowOperator) fireState(state *windowState) {
	if !state.fired {
		state.fired = true
		op.emit(Add, state.row())
	}
}

func (op *WindowOperator) purgeWindow(window Window) {
	op.removeWindow(window)
	op.timers.cancelKey(window, fireTimer)
	op.timers.cancelKey(window, cleanupTimer)
}

func (op *WindowOperator) emit(kind ChangeKind, row Row) {
	op.changes = append(op.changes, Change{Seq: op.nextSeq, Kind: kind, Row: row})
	op.nextSeq++
}

func (op *WindowOperator) lookup(window Window) *windowState {
	if group, ok := op.windows[window.Start]; ok {
		return group[window.End]
	}
	return nil
}

func (op *WindowOperator) getOrCreate(window Window) (*windowState, bool) {
	group, ok := op.windows[window.Start]
	if !ok {
		group = make(map[int64]*windowState)
		op.windows[window.Start] = group
	}
	if state, exists := group[window.End]; exists {
		return state, false
	}
	state := &windowState{window: window}
	group[window.End] = state
	return state, true
}

func (op *WindowOperator) putWindow(state *windowState) {
	group, ok := op.windows[state.window.Start]
	if !ok {
		group = make(map[int64]*windowState)
		op.windows[state.window.Start] = group
	}
	group[state.window.End] = state
}

func (op *WindowOperator) removeWindow(window Window) {
	if group, ok := op.windows[window.Start]; ok {
		delete(group, window.End)
		if len(group) == 0 {
			delete(op.windows, window.Start)
		}
	}
}

func (s *timerService) cancelKey(window Window, kind timerKind) {
	if t, ok := s.registry[timerKey{window.Start, window.End, kind}]; ok {
		s.cancel(t)
	}
}
